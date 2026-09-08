/**
 * @vitest-environment jsdom
 *
 * Full-screen log viewer and bounded log buffer (roadmap / issue #44, item 2).
 */

import { describe, expect, it } from 'vitest';

import {
    BROWSER_TAB_RESERVED, Kernel, createLogBuffer, normalizeBinding, reservedSet, start,
    type Application, type Context, needs, KEEPS_NOTHING,
} from '../src/index.js';

const clean = (): void => { document.body.replaceChildren(); };

describe('LogBuffer bounding and eviction', () => {
    it('bounds the buffer and evicts the oldest records FIFO when capacity is reached', () => {
        const buffer = createLogBuffer(3);
        expect(buffer.capacity).toBe(3);
        expect(buffer.dropped).toBe(0);
        expect(buffer.length).toBe(0);

        buffer.push({ level: 'info', source: 'app1', message: 'msg1' });
        buffer.push({ level: 'info', source: 'app2', message: 'msg2' });
        expect(buffer.length).toBe(2);
        expect(buffer.dropped).toBe(0);

        buffer.push({ level: 'warn', source: 'app3', message: 'msg3' });
        expect(buffer.length).toBe(3);
        expect(buffer.dropped).toBe(0);

        // Exceed capacity
        buffer.push({ level: 'error', source: 'app4', message: 'msg4' });
        expect(buffer.length).toBe(3);
        expect(buffer.dropped).toBe(1);
        expect(buffer.map((l) => l.message)).toEqual(['msg2', 'msg3', 'msg4']);

        // Push multiple items exceeding capacity
        buffer.push(
            { level: 'info', source: 'app5', message: 'msg5' },
            { level: 'info', source: 'app6', message: 'msg6' },
        );
        expect(buffer.length).toBe(3);
        expect(buffer.dropped).toBe(3);
        expect(buffer.map((l) => l.message)).toEqual(['msg4', 'msg5', 'msg6']);
    });

    it('notifies subscribers on append', () => {
        const buffer = createLogBuffer(10);
        let calls = 0;
        const unsubscribe = buffer.subscribe(() => { calls++; });

        buffer.push({ level: 'info', source: 's', message: 'm' });
        expect(calls).toBe(1);

        unsubscribe();
        buffer.push({ level: 'info', source: 's2', message: 'm2' });
        expect(calls).toBe(1);
    });
});

describe('ctrl+alt+q binding against BROWSER_TAB_RESERVED', () => {
    it('is not blocked by BROWSER_TAB_RESERVED', () => {
        const reserved = reservedSet(BROWSER_TAB_RESERVED);
        // ctrl+q is reserved by browsers
        expect(reserved.has(normalizeBinding('ctrl+q'))).toBe(true);
        // ctrl+alt+q is safe for kernel use
        expect(reserved.has(normalizeBinding('ctrl+alt+q'))).toBe(false);
    });
});

describe('mountLogViewer on a page with no chrome', () => {
    const LOG_NEEDS = needs('log');

    class LoggingApp implements Application<typeof LOG_NEEDS> {
        readonly needs = LOG_NEEDS;
        async start(cx: Context<typeof LOG_NEEDS>): Promise<typeof KEEPS_NOTHING> {
            cx.log.info('app started', { version: '1.0' });
            cx.log.warn('warning from app');
            cx.log.error('error from app');
            return KEEPS_NOTHING;
        }
    }

    it('mounts on root with no chrome and opens with ctrl+alt+q or command', async () => {
        clean();
        const root = document.createElement('div');
        document.body.append(root);

        const instance = start({
            application: 'test',
            root,
            parts: [{ id: 'test-app', contribution: new LoggingApp() }],
            logCapacity: 5,
        });

        await instance.ready;

        // Writer wrote to services.logs
        expect(instance.kernel.services.logs.length).toBeGreaterThanOrEqual(3);

        const viewerEl = root.querySelector('.mesh-log-viewer') as HTMLElement;
        expect(viewerEl).not.toBeNull();
        expect(viewerEl.hidden).toBe(true);
        expect(instance.logViewer.isOpen()).toBe(false);

        // Toggle via command or instance method
        instance.logViewer.open();
        expect(viewerEl.hidden).toBe(false);
        expect(instance.logViewer.isOpen()).toBe(true);

        // Verify log entries are rendered
        const entries = viewerEl.querySelectorAll('.mesh-log-entry');
        expect(entries.length).toBeGreaterThanOrEqual(3);

        // Check source and level formatting
        const texts = Array.from(entries).map((e) => e.textContent);
        expect(texts.some((t) => t?.includes('app started'))).toBe(true);
        expect(texts.some((t) => t?.includes('warning from app'))).toBe(true);
        expect(texts.some((t) => t?.includes('error from app'))).toBe(true);

        // Filter by level
        const levelSelect = viewerEl.querySelector('.mesh-log-level-filter') as HTMLSelectElement;
        levelSelect.value = 'error';
        levelSelect.dispatchEvent(new Event('change'));

        const filteredEntries = viewerEl.querySelectorAll('.mesh-log-entry');
        expect(filteredEntries.length).toBe(1);
        expect(filteredEntries[0]!.textContent).toContain('error from app');

        // Filter by source
        levelSelect.value = 'all';
        levelSelect.dispatchEvent(new Event('change'));

        const sourceSelect = viewerEl.querySelector('.mesh-log-source-filter') as HTMLSelectElement;
        expect(Array.from(sourceSelect.options).map((o) => o.value)).toContain('p1');
        sourceSelect.value = 'p1';
        sourceSelect.dispatchEvent(new Event('change'));

        const sourceFiltered = viewerEl.querySelectorAll('.mesh-log-entry');
        expect(sourceFiltered.length).toBe(3);

        // Close via close button
        const closeBtn = viewerEl.querySelector('.mesh-log-close') as HTMLButtonElement;
        closeBtn.click();
        expect(viewerEl.hidden).toBe(true);
        expect(instance.logViewer.isOpen()).toBe(false);

        // Toggle via ctrl+alt+q keydown event
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'q',
            code: 'KeyQ',
            ctrlKey: true,
            altKey: true,
            bubbles: true,
        }));
        expect(viewerEl.hidden).toBe(false);
        expect(instance.logViewer.isOpen()).toBe(true);

        // Close via Escape
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
        }));
        expect(viewerEl.hidden).toBe(true);

        instance.dispose();
    });

    it('shows eviction notice when log bound is reached', async () => {
        clean();
        const root = document.createElement('div');
        document.body.append(root);

        const instance = start({
            application: 'test',
            root,
            parts: [],
            logCapacity: 2,
        });

        instance.kernel.services.logs.push(
            { level: 'info', source: 'test', message: 'first' },
            { level: 'info', source: 'test', message: 'second' },
            { level: 'info', source: 'test', message: 'third' },
        );

        instance.logViewer.open();
        const stats = root.querySelector('.mesh-log-stats');
        expect(stats?.textContent).toContain('1 oldest logs evicted');

        instance.dispose();
    });
});
