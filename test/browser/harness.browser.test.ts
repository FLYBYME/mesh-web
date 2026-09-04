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

async function open(page = PAGE): Promise<Document> {
    const el = document.createElement('iframe');
    el.style.cssText = 'width:1000px;height:600px;border:0';
    el.src = page;
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

        // Windowed: the maximize and close buttons sit side by side, not stacked. `display: grid`
        // on a button makes it block-level, which put one under the other until the row that
        // contains them was made a flex row.
        const [max, close] = [...doc.querySelectorAll<HTMLElement>('.titlebar .buttons button')];
        const maxBox = max!.getBoundingClientRect();
        const closeBox = close!.getBoundingClientRect();
        expect(closeBox.left).toBeGreaterThan(maxBox.left);
        expect(Math.round(closeBox.top)).toBe(Math.round(maxBox.top));

        mode.click();
        await new Promise((r) => setTimeout(r, 50));

        // A pane is not a window: no resize grip and no title bar at all. `header`, `sidebar`,
        // `content` and `footer` are page regions, and a page region does not wear a window's
        // chrome — keeping the bar and hiding only its buttons made the switch look half-done.
        const pane = doc.querySelector<HTMLElement>('.window.tiled')!;
        expect(getComputedStyle(pane.querySelector('.grip')!).display).toBe('none');
        expect(getComputedStyle(pane.querySelector('.titlebar')!).display).toBe('none');
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


/**
 * The gap a user found with devtools open.
 *
 * `cx.notifications.warn(...)` was called correctly, recorded correctly, and **rendered nowhere** —
 * so a failed API call looked exactly like a button that did nothing. Nothing in 167 unit tests
 * could see it: every one of them asserts the *record*, which was always right. What was missing
 * was a surface, and a surface only exists where there is a screen.
 *
 * Driven by pointing the page at an API that is not there, because that is a failure with no timing
 * and no state behind it: every call fails the same way, every time.
 */
describe('a failure reaches the screen', () => {
    const UNREACHABLE = '/browser/index.html?api=http://127.0.0.1:1';

    it('shows the reason, and says who raised it', async () => {
        const el = document.createElement('iframe');
        el.style.cssText = 'width:1000px;height:600px;border:0';
        el.src = UNREACHABLE;
        document.body.appendChild(el);
        frame = el;

        await new Promise<void>((r) => { el.addEventListener('load', () => r(), { once: true }); });
        const doc = el.contentDocument!;

        for (let i = 0; i < 100; i++) {
            if (doc.querySelector('.notice') !== null) break;
            await new Promise((r) => setTimeout(r, 50));
        }

        const notice = doc.querySelector<HTMLElement>('.notice')!;
        expect(notice).not.toBeNull();

        // `describe()` turned a named transport failure into a sentence. Before the host existed
        // this string was produced correctly and shown to nobody.
        expect(notice.textContent).toContain('Could not reach the server.');
        // Attributed: `notifications` is scoped to the contributor that raised it, so the toast can
        // say which process is complaining without the Application passing its own name.
        expect(notice.querySelector('.source')!.textContent).toMatch(/^p\d+$/);
        // Severity is in the form as well as the words.
        expect(notice.classList.contains('warn')).toBe(true);
    }, 30_000);

    it('is dismissable, and dismissing removes it rather than flagging it', async () => {
        const el = document.createElement('iframe');
        el.style.cssText = 'width:1000px;height:600px;border:0';
        el.src = UNREACHABLE;
        document.body.appendChild(el);
        frame = el;

        await new Promise<void>((r) => { el.addEventListener('load', () => r(), { once: true }); });
        const doc = el.contentDocument!;

        for (let i = 0; i < 100; i++) {
            if (doc.querySelector('.notice') !== null) break;
            await new Promise((r) => setTimeout(r, 50));
        }

        doc.querySelector<HTMLButtonElement>('.notice button')!.click();
        await new Promise((r) => setTimeout(r, 60));

        // Gone from the list, not left in it with a flag nobody reads — the history is the log.
        expect(doc.querySelector('.notice')).toBeNull();
    }, 30_000);
});

/**
 * The hotkey, through the real binding table — roadmap A1.4 and A2.8.
 *
 * The declared spelling is `Alt+N`; the manifest stores `alt+n`; the event says `n` with altKey.
 * Three spellings, one binding. The old task switcher compared a configurable binding against a
 * literal and any other binding silently never fired, so this is the shape worth holding down.
 */
describe('a declared hotkey fires', () => {
    it('runs the command the manifest bound, from a real keypress', async () => {
        const doc = await open();
        const before = doc.querySelectorAll('.post').length;

        doc.defaultView!.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'n', altKey: true, bubbles: true, cancelable: true,
        }));
        await new Promise((r) => setTimeout(r, 150));

        expect(doc.querySelectorAll('.post').length).toBe(before + 1);
        expect(doc.getElementById('log')!.textContent).toContain('alt+n → blog.add');
    }, 30_000);

    it('switches mode from its own binding, which the shell implements', async () => {
        const doc = await open();
        expect(doc.querySelector('.window.tiled')).toBeNull();

        doc.defaultView!.dispatchEvent(new KeyboardEvent('keydown', {
            key: 't', altKey: true, bubbles: true, cancelable: true,
        }));
        await new Promise((r) => setTimeout(r, 100));

        // The Application declared `blog.mode`; the shell implemented it. The blog cannot switch
        // modes and cannot see which one it is in.
        expect(doc.querySelector('.window.tiled')).not.toBeNull();
    }, 30_000);

    it('ignores a keypress with a modifier the binding did not name', async () => {
        const doc = await open();
        const before = doc.querySelectorAll('.post').length;

        // `alt+shift+n` is not `alt+n`. The hand-assembled string this replaced ignored shift
        // entirely and would have fired.
        doc.defaultView!.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'n', altKey: true, shiftKey: true, bubbles: true, cancelable: true,
        }));
        await new Promise((r) => setTimeout(r, 150));

        expect(doc.querySelectorAll('.post').length).toBe(before);
    }, 30_000);
});
