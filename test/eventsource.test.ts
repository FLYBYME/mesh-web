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

    it('aborts active fetch and clears listeners on close()', async () => {
        let aborted = false;

        vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
            init?.signal?.addEventListener('abort', () => {
                aborted = true;
            });
            return new Promise<Response>(() => {
                // Hang indefinitely until aborted
            });
        }));

        const es = createFetchEventSource('/events');
        expect(aborted).toBe(false);

        es.close();
        expect(aborted).toBe(true);
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
