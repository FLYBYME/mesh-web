/**
 * The kernel's collector (kernel/collect.ts): a page's warnings and errors sent where the site's
 * policy says, batched and capped.
 */

import { describe, expect, it } from 'vitest';

import { createLogBuffer } from '../src/index.js';
import { collectUrl, startCollector } from '../src/kernel/collect.js';

interface Sent {
    readonly url: string;
    readonly body: { records: Array<{ level: string; message: string; route?: string }>; dropped?: number };
}

function recorder(): { sent: Sent[]; send: (url: string, body: string) => Promise<unknown> } {
    const sent: Sent[] = [];

    return {
        sent,
        send: async (url, body) => {
            const parsed: unknown = JSON.parse(body);
            if (typeof parsed === 'object' && parsed !== null && 'records' in parsed && Array.isArray(parsed.records)) {
                sent.push({ url, body: { records: parsed.records, ...('dropped' in parsed && typeof parsed.dropped === 'number' ? { dropped: parsed.dropped } : {}) } });
            }
        },
    };
}

describe('the page collector', () => {
    it('sends warnings and errors from now on, with the route, and nothing else', async () => {
        const logs = createLogBuffer();
        logs.push({ level: 'error', source: 'kernel', message: 'before it started' });

        const { sent, send } = recorder();
        const collector = startCollector(logs, { url: 'https://streams.example/collect', send, route: () => '/runs', batchMs: 60_000 });

        logs.push({ level: 'info', source: 'kernel', message: 'site started' });
        logs.push({ level: 'warn', source: 'kernel', message: 'call failed: infer.run (500)', data: { status: 500 } });
        logs.push({ level: 'error', source: 'app', message: 'boom' });
        await collector.flush();

        expect(sent).toHaveLength(1);
        expect(sent[0]?.url).toBe('https://streams.example/collect');
        expect(sent[0]?.body.records.map((r) => [r.level, r.message, r.route])).toEqual([
            ['warn', 'call failed: infer.run (500)', '/runs'],
            ['error', 'boom', '/runs'],
        ]);

        collector.dispose();
        logs.push({ level: 'error', source: 'app', message: 'after dispose' });
        await collector.flush();
        expect(sent).toHaveLength(1);
    });

    it('sends at most its records a minute, and says how many it held back', async () => {
        const logs = createLogBuffer();
        const clock = { at: 0 };
        const { sent, send } = recorder();
        const collector = startCollector(logs, { url: 'https://streams.example/collect', send, perMinute: 2, batchMs: 60_000, now: () => clock.at });

        for (let i = 0; i < 5; i++) logs.push({ level: 'error', source: 'app', message: `e${i}` });
        await collector.flush();
        expect(sent[0]?.body.records.map((r) => r.message)).toEqual(['e0', 'e1']);
        expect(sent[0]?.body.dropped).toBe(3);

        clock.at = 60_000;
        logs.push({ level: 'error', source: 'app', message: 'next minute' });
        await collector.flush();
        expect(sent[1]?.body.records.map((r) => r.message)).toEqual(['next minute']);
        expect(sent[1]?.body.dropped).toBeUndefined();
        collector.dispose();
    });

    it('is off unless the policy names an http(s) URL', () => {
        expect(collectUrl('https://streams.example/collect')).toBe('https://streams.example/collect');
        expect(collectUrl('javascript:alert(1)')).toBeUndefined();
        expect(collectUrl(undefined)).toBeUndefined();
        expect(collectUrl(42)).toBeUndefined();
    });
});
