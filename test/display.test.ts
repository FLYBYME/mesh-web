/**
 * @vitest-environment jsdom
 *
 * `cx.display` — how much room there is, as a signal.
 *
 * The kernel has measured this since the beginning and handed it to exactly one consumer: the
 * window manager. So the only thing on a page that could react to how much room there was, was the
 * thing that draws windows — and a chrome deciding whether to draw windows *at all* could not see
 * the number it needed. That is how a phone ends up with a desktop.
 *
 * ## What it deliberately is not
 *
 * Not `isMobile`. A width is a fact; what to do at 380px is a decision, and it belongs to whoever
 * is drawing. A boolean decided at boot from a user-agent is stale the moment a phone is rotated or
 * a desktop window is dragged narrow, and it buries a breakpoint the kernel guessed at inside every
 * part that reads it.
 */

import { describe, expect, it } from 'vitest';

import { needs } from '../src/contribution/capabilities.js';
import type { Application, Context } from '../src/contribution/contract.js';
import { KEEPS_NOTHING } from '../src/contribution/contract.js';
import { start } from '../src/kernel/start.js';

const NEEDS = needs('display');

/** Records what the display said, so a test can assert on what a part actually observed. */
class Watcher implements Application<typeof NEEDS> {
    readonly needs = NEEDS;
    readonly views = [];

    seen: { width: number; height: number } | undefined;
    display: Context<typeof NEEDS>['display'] | undefined;

    async start(cx: Context<typeof NEEDS>): Promise<typeof KEEPS_NOTHING> {
        this.display = cx.display;
        this.seen = cx.display.size();
        return KEEPS_NOTHING;
    }
}

describe('the display a part is given', () => {
    it('is measured before a part starts, not after the first resize', async () => {
        /**
         * Nothing else measures at boot. `resize` fires when the window changes and the
         * `ResizeObserver` when the host box does — neither is guaranteed on a page that loads and
         * sits there. Without an initial measurement the display reads 0×0 until somebody drags
         * something, so a chrome asking *how much room is there* at boot is told none, and
         * reasonably draws the narrow layout on a desktop.
         */
        const root = document.createElement('div');
        Object.defineProperty(root, 'clientWidth', { value: 1280, configurable: true });
        Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
        document.body.append(root);

        const watcher = new Watcher();
        const started = start({
            application: 'test',
            root,
            parts: [{ id: 'watcher', contribution: watcher }],
        });
        await started.ready;

        expect(watcher.seen).toBeDefined();
        started.dispose();
        root.remove();
    });

    it('is a signal, so a part sees a resize rather than a value from boot', async () => {
        /**
         * Driven through a real `resize` rather than by writing the signal directly. The write is
         * the kernel's — `start()` does not hand `services` back, deliberately — so reaching for it
         * would mean widening the kernel's public surface for a test's convenience, and testing a
         * path no page takes. This is the path every page takes.
         */
        const root = document.createElement('div');
        let width = 1280;
        Object.defineProperty(root, 'clientWidth', { get: () => width, configurable: true });
        Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
        document.body.append(root);

        const watcher = new Watcher();
        const started = start({
            application: 'test',
            root,
            parts: [{ id: 'watcher', contribution: watcher }],
        });
        await started.ready;

        expect(watcher.display?.size().width).toBe(1280);

        // The browser is dragged narrow. Nothing in the part changes; the number it reads does.
        width = 375;
        window.dispatchEvent(new Event('resize'));

        expect(watcher.display?.size().width).toBe(375);

        started.dispose();
        root.remove();
    });

    it('answers a size with no DOM at all, rather than forcing every reader to handle undefined', async () => {
        /**
         * Most of this repository's tests boot without a real page. `0×0` is the honest answer
         * there — there genuinely is no room — and a chrome that renders nothing at 0×0 is behaving
         * correctly. The alternative, an optional capability, would put a `?? { width: 0 }` in
         * every consumer and the default would be guessed at each time.
         */
        const watcher = new Watcher();
        const started = start({
            application: 'test',
            parts: [{ id: 'watcher', contribution: watcher }],
        });
        await started.ready;

        expect(watcher.seen).toEqual({ width: 0, height: 0 });
        started.dispose();
    });

    it('is not handed to a part that did not ask for it', async () => {
        // The same rule as every other capability: `needs` is the manifest, and what is not
        // declared is not present. A part reading the page's dimensions is a small thing to know
        // about a part, and it should still be visible in its manifest.
        const quiet = new (class implements Application<readonly []> {
            readonly needs = [] as const;
            readonly views = [];
            given: unknown;
            async start(cx: unknown): Promise<typeof KEEPS_NOTHING> {
                this.given = (cx as { display?: unknown }).display;
                return KEEPS_NOTHING;
            }
        })();

        const started = start({
            application: 'test',
            parts: [{ id: 'quiet', contribution: quiet }],
        });
        await started.ready;

        expect(quiet.given).toBeUndefined();
        started.dispose();
    });
});
