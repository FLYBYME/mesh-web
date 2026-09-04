/**
 * The harness itself, in a browser.
 *
 * `tiled.browser.test.ts` checks the mechanics with a shell written for the test. This checks the
 * shell people actually open — `browser/index.html` — because the harness is the thing that gets
 * looked at, and a demo that is broken teaches the wrong lesson more effectively than a passing
 * test teaches the right one.
 *
 * It runs the page in an iframe against the in-page transport, so it needs no mesh-api and no dev
 * server: the same Application, the same generated client, a different transport.
 */

import { afterEach, describe, expect, it } from 'vitest';

const PAGE = '/browser/index.html?api=memory';

let frame: HTMLIFrameElement | undefined;

afterEach(() => {
    frame?.remove();
    frame = undefined;
});

async function open(): Promise<Document> {
    const el = document.createElement('iframe');
    el.style.cssText = 'width:1000px;height:600px;border:0';
    el.src = PAGE;
    document.body.appendChild(el);
    frame = el;

    await new Promise<void>((resolve) => { el.addEventListener('load', () => resolve(), { once: true }); });

    const doc = el.contentDocument!;
    // The blog starts asynchronously and its first render waits on a net call, so wait for the
    // windows rather than a fixed delay.
    for (let i = 0; i < 100; i++) {
        if (doc.querySelectorAll('.window').length >= 4) break;
        await new Promise((r) => setTimeout(r, 50));
    }
    return doc;
}

const visible = (doc: Document): HTMLElement[] =>
    [...doc.querySelectorAll<HTMLElement>('.window')].filter((w) => !w.hidden);

describe('the harness people open', () => {
    it('boots the Application and opens a window per view', async () => {
        const doc = await open();

        expect(doc.querySelectorAll('.window')).toHaveLength(4);
        // Served by the in-page transport through the real generated client, so the list is real
        // data that crossed the real boundary.
        expect(doc.querySelectorAll('.post').length).toBeGreaterThan(0);
        expect(doc.querySelector('#processes')!.textContent).toContain('running');
    }, 30_000);

    it('tiles the same four views, filling the desktop', async () => {
        const doc = await open();
        const desktop = doc.getElementById('desktop')!.getBoundingClientRect();

        (doc.getElementById('mode') as HTMLButtonElement).click();
        await new Promise((r) => setTimeout(r, 50));

        const panes = visible(doc);
        expect(panes).toHaveLength(4);

        const boxes = panes.map((p) => p.getBoundingClientRect());

        // Every pane inside the desktop, and together spanning it: a header band, two side by side,
        // a footer band.
        for (const box of boxes) {
            expect(box.width).toBeGreaterThan(0);
            expect(box.height).toBeGreaterThan(0);
            expect(Math.round(box.left)).toBeGreaterThanOrEqual(Math.round(desktop.left) - 1);
        }

        const header = boxes.reduce((a, b) => (a.top <= b.top ? a : b));
        expect(Math.round(header.height)).toBe(44);          // the fixed tile
        expect(Math.round(header.width)).toBe(Math.round(desktop.width));

        // The sidebar is 260 and the reader takes what is left.
        const middle = boxes.filter((b) => b !== header && b.height > 44);
        expect(middle).toHaveLength(2);
        const [left, right] = middle.sort((a, b) => a.left - b.left);
        expect(Math.round(left!.width)).toBe(260);
        expect(Math.round(right!.left)).toBe(Math.round(left!.right) + 1);
    }, 30_000);

    it('drops the window affordances when tiled, and brings them back', async () => {
        const doc = await open();
        const mode = doc.getElementById('mode') as HTMLButtonElement;

        expect(doc.querySelector<HTMLElement>('.window .grip')!.offsetParent).not.toBeNull();

        mode.click();
        await new Promise((r) => setTimeout(r, 50));

        // A pane is not a window: no resize grip, no close button. Layout-defined geometry, no
        // min/max affordances (roadmap A2.3) — the shell stops offering them.
        const grip = doc.querySelector<HTMLElement>('.window.tiled .grip')!;
        expect(getComputedStyle(grip).display).toBe('none');
        expect(mode.textContent).toBe('Windowed');

        mode.click();
        await new Promise((r) => setTimeout(r, 50));
        expect(doc.querySelector('.window.tiled')).toBeNull();
    }, 30_000);

    it('survives the round trip with nothing remounted', async () => {
        const doc = await open();

        const sidebar = [...doc.querySelectorAll<HTMLElement>('.window')]
            .find((w) => w.textContent?.includes('New post'))!;
        const firstPost = sidebar.querySelector('.post')!;
        const before = sidebar.getBoundingClientRect();

        (doc.getElementById('mode') as HTMLButtonElement).click();
        await new Promise((r) => setTimeout(r, 50));
        expect(Math.round(sidebar.getBoundingClientRect().width)).toBe(260);

        (doc.getElementById('mode') as HTMLButtonElement).click();
        await new Promise((r) => setTimeout(r, 50));

        // Same node, and back to the size the window had. Nothing was rebuilt in between.
        expect(sidebar.querySelector('.post')).toBe(firstPost);
        expect(sidebar.getBoundingClientRect().width).toBe(before.width);
    }, 30_000);
});
