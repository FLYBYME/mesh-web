import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchEventSource } from '../../src/net/eventsource.js';

describe('createFetchEventSource in browser', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('streams chunks across boundaries and reconnects', async () => {
        let attempt = 0;

        const fetchSpy = vi.spyOn(window, 'fetch').mockImplementation(async () => {
            attempt++;
            const encoder = new TextEncoder();
            
            const chunks = attempt === 1 ? [
                'event: mess',
                'age\ndata: he',
                'llo\n\n'
            ] : [
                'data: reconnected\n\n'
            ];
            
            let chunkIndex = 0;
            const stream = new ReadableStream({
                pull(controller) {
                    if (chunkIndex < chunks.length) {
                        controller.enqueue(encoder.encode(chunks[chunkIndex++]));
                    } else {
                        controller.close();
                    }
                }
            });

            return new Response(stream, {
                status: 200,
                headers: { 'content-type': 'text/event-stream' }
            });
        });

        const es = createFetchEventSource('http://test', { retryDelay: 10 });
        const messageSpy = vi.fn();

        es.addEventListener('message', (event) => {
            messageSpy(event);
            if (event.data === 'reconnected') {
                es.close();
            }
        });

        await vi.waitFor(() => {
            expect(messageSpy).toHaveBeenCalledWith({ data: 'hello' });
        });

        // The first fetch closes its stream, triggering a reconnect.
        // It waits `retryDelay` and calls fetch again.
        await vi.waitFor(() => {
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        });

        await vi.waitFor(() => {
            expect(messageSpy).toHaveBeenCalledWith({ data: 'reconnected' });
        });

        es.close();
    });
});
