/**
 * The page's warnings and errors, sent somewhere a person can see them (design: a page error
 * that leaves the browser). Off unless the site's policy names where: `telemetry/collect`, a URL
 * that takes `POST { records, dropped }`. What goes is what the log panel shows at warn and error
 * -- a failed call among them, with its contract, kind and status, never the input, the answer, a
 * header or a ticket (logs.ts says what the kernel writes).
 *
 * Bounded both ways: a batch at most every few seconds, at most `perMinute` records a minute (the
 * rest only counted, and the count sent with the next batch), and nothing kept if the collector
 * does not answer. A page is never slowed by its collector.
 */

import type { LogBuffer } from './logs.js';
import type { LogRecord } from './broker.js';

export interface CollectorOptions {
    readonly url: string;
    readonly batchMs?: number;
    readonly perMinute?: number;
    readonly route?: () => string;
    readonly now?: () => number;
    readonly send?: (url: string, body: string) => Promise<unknown>;
}

export interface Collector {
    /** Sends what is waiting now; resolves when the send is done (or failed). */
    flush(): Promise<void>;
    dispose(): void;
}

interface Outgoing {
    readonly level: 'warn' | 'error';
    readonly source: string;
    readonly message: string;
    readonly part?: string;
    readonly route?: string;
    readonly data?: string;
    readonly at: number;
}

const MAX_BATCH = 50;

function plainData(data: unknown): string | undefined {
    if (data === undefined) return undefined;

    try {
        const text = JSON.stringify(data);

        return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
    } catch {
        return undefined;
    }
}

function defaultSend(url: string, body: string): Promise<unknown> {
    return fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true, credentials: 'omit' });
}

/** Where the policy says to send, when it says so: an http(s) URL, else nothing is sent. */
export function collectUrl(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;

    try {
        const url = new URL(value);

        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
    } catch {
        return undefined;
    }
}

export function startCollector(logs: LogBuffer, options: CollectorOptions): Collector {
    const now = options.now ?? Date.now;
    const send = options.send ?? defaultSend;
    const perMinute = options.perMinute ?? 60;
    const batchMs = options.batchMs ?? 5000;

    let waiting: Outgoing[] = [];
    let dropped = 0;
    let minute = Math.floor(now() / 60_000);
    let sentThisMinute = 0;
    let seen = logs.dropped + logs.length;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const take = (record: LogRecord): void => {
        if (record.level !== 'warn' && record.level !== 'error') return;

        const current = Math.floor(now() / 60_000);
        if (current !== minute) {
            minute = current;
            sentThisMinute = 0;
        }
        if (sentThisMinute >= perMinute || waiting.length >= MAX_BATCH) {
            dropped += 1;
            return;
        }

        sentThisMinute += 1;
        const route = options.route?.();
        const data = plainData(record.data);
        waiting.push({
            level: record.level,
            source: record.source.slice(0, 100),
            message: record.message.slice(0, 2000),
            ...(record.part !== undefined ? { part: record.part.slice(0, 200) } : {}),
            ...(route !== undefined ? { route: route.slice(0, 200) } : {}),
            ...(data !== undefined ? { data } : {}),
            at: now(),
        });

        timer ??= setTimeout(() => { void flush(); }, batchMs);
    };

    const flush = async (): Promise<void> => {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        if (waiting.length === 0) return;

        const records = waiting;
        const held = dropped;
        waiting = [];
        dropped = 0;

        try {
            await send(options.url, JSON.stringify({ records, ...(held > 0 ? { dropped: held } : {}) }));
        } catch {
            // Not kept: a collector that is down costs these records, never the page's memory.
        }
    };

    // Only what arrives from now on: the buffer counts everything it ever held (length + dropped).
    const unsubscribe = logs.subscribe(() => {
        const total = logs.dropped + logs.length;
        const fresh = Math.min(total - seen, logs.length);
        seen = total;

        for (const record of logs.slice(logs.length - fresh)) take(record);
    });

    return {
        flush,
        dispose() {
            unsubscribe();
            if (timer !== undefined) clearTimeout(timer);
            timer = undefined;
        },
    };
}
