import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchEventSource } from '../src/net/eventsource.js';

describe('createFetchEventSource', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    /** Helper to create a streaming Response from string chunks */
    function createStreamResponse(chunks: string[], status = 200, statusText = 'OK'): Response {
        const encoder = new TextEncoder();
        let chunkIndex = 0;

        const stream = new ReadableStream({
            pull(controller) {
                if (chunkIndex < chunks.length) {
                    controller.enqueue(encoder.encode(chunks[chunkIndex++]));
                } else {
                    controller.close();
                }
            },
        });

        return new Response(stream, {
            status,
            statusText,
            headers: { 'content-type': 'text/event-stream' },
        });
    }

    it('attaches dynamic headers and dispatches open and message events', async () => {
        const token = 'bearer-123';
        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            return createStreamResponse([
                'data: {"hello":"world"}\n\n',
            ]);
        });
        vi.stubGlobal('fetch', fetchMock);

        const messages: string[] = [];
        let opened = false;

        const es = createFetchEventSource('/events', {
            headers: () => ({ authorization: `Bearer ${token}` }),
        });

        es.addEventListener('open', () => {
            opened = true;
        });

        es.addEventListener('message', (event) => {
            if (event.data) messages.push(event.data);
        });

        await vi.waitFor(() => expect(opened).toBe(true));
        await vi.waitFor(() => expect(messages).toEqual(['{"hello":"world"}']));

        expect(fetchMock).toHaveBeenCalledWith(
            '/events',
            expect.objectContaining({
                headers: expect.objectContaining({
                    accept: 'text/event-stream',
                    authorization: 'Bearer bearer-123',
                }),
            }),
        );

        es.close();
    });

    it('routes named custom events correctly and ignores comment frames', async () => {
        const chunks = [
            ': keepalive ping\n\n',
            'event: part.created\ndata: {"id":"part_1"}\n\n',
            ': another comment\n',
            'event: part.deleted\r\ndata: {"id":"part_2"}\r\n\r\n',
        ];

        vi.stubGlobal('fetch', vi.fn(async () => createStreamResponse(chunks)));

        const createdEvents: string[] = [];
        const deletedEvents: string[] = [];
        const messageEvents: string[] = [];

        const es = createFetchEventSource('/events');

        es.addEventListener('part.created', (e) => {
            if (e.data) createdEvents.push(e.data);
        });
        es.addEventListener('part.deleted', (e) => {
            if (e.data) deletedEvents.push(e.data);
        });
        es.addEventListener('message', (e) => {
            if (e.data) messageEvents.push(e.data);
        });

        await vi.waitFor(() => expect(createdEvents).toEqual(['{"id":"part_1"}']));
        await vi.waitFor(() => expect(deletedEvents).toEqual(['{"id":"part_2"}']));
        expect(messageEvents).toHaveLength(0);

        es.close();
    });

    it('reassembles frames and multi-line data split across chunk boundaries', async () => {
        const chunks = [
            'event: mult',
            'iline\ndata: first line\n',
            'data: second line\n\n',
        ];

        vi.stubGlobal('fetch', vi.fn(async () => createStreamResponse(chunks)));

        const events: string[] = [];
        const es = createFetchEventSource('/events');

        es.addEventListener('multiline', (e) => {
            if (e.data) events.push(e.data);
        });

        await vi.waitFor(() => expect(events).toEqual(['first line\nsecond line']));

        es.close();
    });

    it('emits error and re-reads headers on retry reconnect', async () => {
        let attempt = 0;
        let token = 'initial-token';

        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            attempt++;
            if (attempt === 1) {
                // First attempt fails with 401
                return new Response('Unauthorized token', { status: 401 });
            }
            // Second attempt receives refreshed token and succeeds
            return createStreamResponse(['data: ok\n\n']);
        }));

        const errors: string[] = [];
        const messages: string[] = [];

        const es = createFetchEventSource('/events', {
            headers: () => ({ authorization: `Bearer ${token}` }),
            retryDelay: 10,
            maxDelay: 50,
        });

        es.addEventListener('error', (e) => {
            if (e.data) errors.push(e.data);
            // Refresh token upon receiving auth error
            token = 'refreshed-token';
        });

        es.addEventListener('message', (e) => {
            if (e.data) {
                messages.push(e.data);
                es.close();
            }
        });

        await vi.waitFor(() => expect(errors.length).toBeGreaterThanOrEqual(1));
        expect(errors[0]).toContain('events 401: Unauthorized token');

        // Should automatically retry and succeed with refreshed token
        await vi.waitFor(() => expect(messages).toEqual(['ok']));
        expect(attempt).toBeGreaterThanOrEqual(2);
    });

    it('stops for good on a 403 instead of asking again forever, and says why', async () => {
        const fetchMock = vi.fn(async () => new Response('Requires role "operator".', { status: 403 }));
        vi.stubGlobal('fetch', fetchMock);

        const errors: string[] = [];
        const closes: string[] = [];
        const es = createFetchEventSource('/events', { retryDelay: 5, maxDelay: 5 });
        es.addEventListener('error', (e) => { if (e.data) errors.push(e.data); });
        es.addEventListener('close', (e) => { if (e.data) closes.push(e.data); });

        await vi.waitFor(() => expect(closes).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(errors[0]).toBe('events 403: Requires role "operator".');
        expect(closes[0]).toBe(errors[0]);
    });

    it('reopens a connection that went silent without closing', async () => {
        let attempt = 0;
        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            attempt++;
            if (attempt === 1) {
                // Opens, then never sends another byte and never ends -- a dead route.
                const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(': open\n\n'));
                        init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
                    },
                });
                return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
            }
            return createStreamResponse(['data: back\n\n']);
        }));

        const errors: string[] = [];
        const messages: string[] = [];
        const es = createFetchEventSource('/events', { retryDelay: 5, maxDelay: 5, idleTimeoutMs: 40 });
        es.addEventListener('error', (e) => { if (e.data) errors.push(e.data); });
        es.addEventListener('message', (e) => { if (e.data) { messages.push(e.data); es.close(); } });

        await vi.waitFor(() => expect(messages).toEqual(['back']));
        expect(errors[0]).toContain('nothing received for 40ms');
    });

    it('aborts active fetch and clears listeners on close()', async () => {
        let aborted = false;

        const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
            init?.signal?.addEventListener('abort', () => {
                aborted = true;
            });
            return new Promise<Response>(() => {
                // Hang indefinitely until aborted
            });
        });
        vi.stubGlobal('fetch', fetchMock);

        // Connecting starts on the next tick, so wait for the request to be in flight.
        const es = createFetchEventSource('/events');
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(aborted).toBe(false);

        es.close();
        expect(aborted).toBe(true);
    });

    it('makes no request at all when closed before it started', async () => {
        const fetchMock = vi.fn(async () => createStreamResponse(['data: x\n\n']));
        vi.stubGlobal('fetch', fetchMock);

        createFetchEventSource('/events').close();
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('removes event listeners via removeEventListener', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => createStreamResponse([
            'data: msg-1\n\n',
            'data: msg-2\n\n',
        ])));

        const received: string[] = [];
        const listener = (e: { data?: string }) => {
            if (e.data) received.push(e.data);
        };

        const es = createFetchEventSource('/events');
        es.addEventListener('message', listener);

        await vi.waitFor(() => expect(received).toContain('msg-1'));

        // Remove listener
        es.removeEventListener('message', listener);

        es.close();
    });
});
