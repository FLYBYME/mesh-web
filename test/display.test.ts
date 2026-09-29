/**
 * @vitest-environment jsdom
 *
 * `cx.display` — how much room there is, as a signal.
 *
 * The kernel has measured this since the beginning and handed it, for a long time, to exactly one
 * consumer: the window manager. So the only thing on a page that could react to how much room there
 * was, was the thing that draws windows — which is how a phone ends up with a desktop.
 *
 * ## What it deliberately is not
 *
 * Not `isMobile`. A width is a fact; what to do at 380px is a decision, and it belongs to whoever is
 * drawing. A boolean decided at boot is stale the moment a phone is rotated.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { App, element, needs, Service, View, type Node } from '../src/index.js';
import { start } from '../src/kernel/start.js';

/** Records what the display said, so a test can assert on what a service actually observed. */
let watcher: Watcher | undefined;

const Base = Service({ needs: needs('display') });
class Watcher extends Base {
    readonly seen = this.cx.display.size();
    constructor(...args: ConstructorParameters<typeof Base>) {
        super(...args);
        watcher = this;
    }
    width(): number { return this.cx.display.size().width; }
}

class Blank extends View({}) {
    render(): Node { return element('Stack', { children: [] }); }
}

class Watching extends App({ needs: needs('display'), services: [Watcher], routes: { '/': Blank } }) {}

afterEach(() => {
    watcher = undefined;
    document.body.replaceChildren();
});

describe('the display a service is given', () => {
    it('is measured before anything is constructed, not after the first resize', () => {
        /**
         * Nothing else measures at boot. `resize` fires when the window changes and the
         * `ResizeObserver` when the host box does — neither is guaranteed on a page that loads and
         * sits there. Without an initial measurement a service asking at construction is told 0×0,
         * and reasonably draws the narrow layout on a desktop.
         */
        const root = document.createElement('div');
        Object.defineProperty(root, 'clientWidth', { value: 1280, configurable: true });
        Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
        document.body.append(root);

        const started = start({ application: 'test', root, parts: [{ id: 'watching', contribution: Watching }] });
        expect(watcher?.seen).toEqual({ width: 1280, height: 800 });
        started.dispose();
    });

    it('is a signal, so a service sees a resize rather than a value from boot', () => {
        // Driven through a real `resize`: the path every page takes.
        const root = document.createElement('div');
        let width = 1280;
        Object.defineProperty(root, 'clientWidth', { get: () => width, configurable: true });
        Object.defineProperty(root, 'clientHeight', { value: 800, configurable: true });
        document.body.append(root);

        const started = start({ application: 'test', root, parts: [{ id: 'watching', contribution: Watching }] });
        expect(watcher?.width()).toBe(1280);

        width = 375;
        window.dispatchEvent(new Event('resize'));
        expect(watcher?.width()).toBe(375);

        // And not after dispose: the page stopped listening.
        started.dispose();
        width = 999;
        window.dispatchEvent(new Event('resize'));
        expect(watcher?.width()).toBe(375);
    });

    it('answers a size with no layout at all, rather than forcing every reader to handle undefined', () => {
        // jsdom has no layout: 0×0 is the honest answer, and a reader need not guess a default.
        const started = start({ application: 'test', parts: [{ id: 'watching', contribution: Watching }] });
        expect(watcher?.seen).toEqual({ width: 0, height: 0 });
        started.dispose();
    });

    it('is not handed to a service that did not ask for it', () => {
        // `needs` is the manifest: what is not declared is not present.
        let given: boolean | undefined;
        const QuietBase = Service({});
        class Quiet extends QuietBase {
            constructor(...args: ConstructorParameters<typeof QuietBase>) {
                super(...args);
                given = 'display' in this.cx;
            }
        }
        class QuietApp extends App({ needs: needs('display'), services: [Quiet], routes: { '/': Blank } }) {}

        const started = start({ application: 'test', parts: [{ id: 'quiet', contribution: QuietApp }] });
        expect(given).toBe(false);
        started.dispose();
    });
});
