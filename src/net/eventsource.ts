/**
 * **An `EventSource` that can carry a credential.**
 *
 * `/events` is gated like everything else — flowboard's collections stream at `user`, the console's
 * fleet events at `operator` — and mesh-serve reads the credential the way it reads it everywhere
 * else: `Authorization: Bearer <ticket>`.
 *
 * The browser's own `EventSource` **cannot send a header.** It takes a URL and a `withCredentials`
 * flag and nothing else. So the native class can only ever connect anonymously, which for any gated
 * stream is a connection that opens and is refused — and the usual workaround, putting the ticket in
 * the query string, writes a live credential into every access log, proxy, and `Referer` between
 * here and the server. `spec/auth.md` is explicit that a ticket travels in a header.
 *
 * `EventSourceLike` in `models/models.ts` is a duck-typed interface rather than the DOM class, and
 * that is the whole opening: `fetch` sends headers, its response body is a stream, and the wire
 * format is small enough to parse honestly. So this is the same protocol, read by hand, with the
 * request the rest of the kernel would have made.
 *
 * **What it is not.** It is not a general `EventSource` polyfill: no `Last-Event-ID` replay, no
 * `retry:` field, no `readyState`. The models layer reconnects and refetches on its own
 * (`onReconnect` → `q.refetch()`), which is stronger than replay anyway — it re-reads the
 * collection rather than trusting a cursor.
 */

/** The subset of the DOM `EventSource` surface that `models/models.ts` actually calls. */
export interface FetchEventSourceLike {
    addEventListener(event: string, listener: (event: { data?: string }) => void): void;
    removeEventListener(event: string, listener: (event: { data?: string }) => void): void;
    close(): void;
}

export interface FetchEventSourceOptions {
    /** The credential headers, read per attempt — a reconnect after a refresh must use the new ticket. */
    readonly headers?: () => Record<string, string>;
    /** Milliseconds before a dropped connection is retried. Backs off to `maxDelay`. */
    readonly retryDelay?: number;
    readonly maxDelay?: number;
    /**
     * Milliseconds with no bytes at all before the connection is treated as dead and reopened.
     * mesh-serve sends a `: keepalive` comment every 20s, so silence well past that is a connection
     * that died without closing -- a dropped route, a proxy that lost it -- which would otherwise
     * wait forever, looking connected and delivering nothing. `0` disables it.
     */
    readonly idleTimeoutMs?: number;
}

/**
 * Statuses that retrying cannot change: refused by the gate (403), or nothing served here (404).
 * Everything else -- a network drop, a 5xx, a 401 a ticket refresh may fix -- is retried.
 */
const PERMANENT_REFUSALS = new Set([403, 404]);

class RefusedError extends Error {}

/**
 * One SSE frame.
 *
 * Fields are `name: value`, a blank line dispatches, and a leading space after the colon is part of
 * the separator rather than the value. `data:` accumulates across lines; everything else is last
 * one wins. A frame with no `event:` is a `message`, which is what the DOM class does.
 */
interface Frame {
    event: string;
    data: string[];
}

const emptyFrame = (): Frame => ({ event: 'message', data: [] });

export function createFetchEventSource(
    url: string,
    options: FetchEventSourceOptions = {},
): FetchEventSourceLike {
    const listeners = new Map<string, Set<(event: { data?: string }) => void>>();
    const controller = new AbortController();
    let closed = false;

    const retryDelay = options.retryDelay ?? 1000;
    const maxDelay = options.maxDelay ?? 30_000;
    const idleTimeoutMs = options.idleTimeoutMs ?? 50_000;
    let delay = retryDelay;

    const emit = (event: string, data: string | undefined): void => {
        for (const listener of listeners.get(event) ?? []) {
            listener({ ...(data === undefined ? {} : { data }) });
        }
    };

    const dispatch = (frame: Frame): void => {
        // A frame that carried no `data:` at all is a comment or a keep-alive, not an event.
        if (frame.data.length === 0) return;
        emit(frame.event, frame.data.join('\n'));
    };

    /**
     * Read one connection to exhaustion.
     *
     * Returns normally when the server closes the stream, which is a reconnect rather than an error
     * — a node restarting is the ordinary case, and the models layer refetches when we come back.
     */
    async function pump(): Promise<void> {
        // One controller per attempt, so the idle watchdog can drop a dead connection without
        // closing the source; `close()` aborts whichever attempt is live.
        const attempt = new AbortController();
        const abortAttempt = (): void => attempt.abort();
        controller.signal.addEventListener('abort', abortAttempt);

        let idle: ReturnType<typeof setTimeout> | undefined;
        const armWatchdog = (): void => {
            if (idleTimeoutMs <= 0) return;
            if (idle !== undefined) clearTimeout(idle);
            idle = setTimeout(abortAttempt, idleTimeoutMs);
        };

        try {
            armWatchdog();
            const response = await fetch(url, {
                method: 'GET',
                headers: { accept: 'text/event-stream', ...(options.headers?.() ?? {}) },
                signal: attempt.signal,
            });

            if (!response.ok || response.body === null) {
                // A refusal is data, not a transport failure: the body says which event was refused
                // and why. Surfacing it as `error` lets a page log the reason rather than a status.
                const detail = await response.text().catch(() => '');
                const message = `events ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 400)}`}`;
                throw PERMANENT_REFUSALS.has(response.status) ? new RefusedError(message) : new Error(message);
            }

            // Connected and accepted. Anything after this is a normal end or a genuine drop, so the
            // backoff starts over.
            delay = retryDelay;
            emit('open', undefined);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let frame = emptyFrame();

            for (;;) {
                armWatchdog();
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                // Frames end at a newline; anything after the last one is a partial line held for
                // the next chunk. Splitting on \n and keeping the tail is what makes a chunk
                // boundary mid-field harmless.
                let newline = buffer.indexOf('\n');
                while (newline !== -1) {
                    const line = buffer.slice(0, newline).replace(/\r$/, '');
                    buffer = buffer.slice(newline + 1);
                    newline = buffer.indexOf('\n');

                    if (line === '') {
                        dispatch(frame);
                        frame = emptyFrame();
                        continue;
                    }
                    if (line.startsWith(':')) continue;   // a comment; the usual keep-alive

                    const colon = line.indexOf(':');
                    const field = colon === -1 ? line : line.slice(0, colon);
                    const raw = colon === -1 ? '' : line.slice(colon + 1);
                    const value_ = raw.startsWith(' ') ? raw.slice(1) : raw;

                    if (field === 'event') frame.event = value_;
                    else if (field === 'data') frame.data.push(value_);
                    // `id` and `retry` are parsed away deliberately: see the note at the top of the file.
                }
            }
        } catch (error) {
            // The watchdog's abort surfaces here as an AbortError on a source that is still open.
            if (attempt.signal.aborted && !controller.signal.aborted) {
                throw new Error(`events: nothing received for ${idleTimeoutMs}ms, reconnecting`);
            }
            throw error;
        } finally {
            if (idle !== undefined) clearTimeout(idle);
            controller.signal.removeEventListener('abort', abortAttempt);
        }
    }

    const stop = (): void => {
        closed = true;
        controller.abort();
        listeners.clear();
    };

    async function run(): Promise<void> {
        while (!closed) {
            try {
                await pump();
            } catch (error) {
                if (closed || controller.signal.aborted) return;
                emit('error', error instanceof Error ? error.message : String(error));
                if (error instanceof RefusedError) {
                    // Retrying cannot change a gate's answer, so stop -- rather than asking again
                    // every 30s for as long as the page stays open. `close` says it is over.
                    emit('close', error.message);
                    stop();
                    return;
                }
            }

            if (closed) return;
            await new Promise((resolve) => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, maxDelay);
        }
    }

    // Next tick, not inside this constructor: whoever created the source attaches its listeners
    // first, so not even the earliest `open` or `error` can be missed.
    setTimeout(() => { void run(); }, 0);

    return {
        addEventListener(event, listener) {
            const set = listeners.get(event) ?? new Set();
            set.add(listener);
            listeners.set(event, set);
        },
        removeEventListener(event, listener) {
            listeners.get(event)?.delete(listener);
        },
        close() {
            stop();
        },
    };
}
