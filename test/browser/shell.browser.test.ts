/**
 * The window layer, and the seam in it — roadmap A6.3e, spec/kernel.md §2.
 *
 * `mountShell` exists because the framework tracked windows and painted none of them: the only shell
 * mesh-web had was 130 lines inside its own harness. This suite is the argument that moving it was
 * worth doing, and it is made in the only place it can be — a real browser, where boxes have sizes
 * and a drag is a drag.
 *
 * The claim under test is [kernel §2](../../spec/kernel.md)'s line:
 *
 * > Moving, resizing and stacking are kernel, not a decoration Extension … What remains an Extension
 * > is how a window is *drawn*.
 *
 * So chrome is swapped for something that looks nothing like the default, and then for something
 * actively broken, and in both cases the windows still move, stack, hide and close exactly as
 * before. That is what makes the split real rather than a convention — and it is what A6.3d's chrome
 * Extension will plug into.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from '@vitest/browser/context';

import {
    Kernel, WindowManager, createRegistry, element, flushSync, mountShell, needs, text,
    windowSink, PRIMITIVES,
    type Application, type Context, type FrameChrome, type Shell, type ViewContext,
} from '../../src/index.js';

// ---------------------------------------------------------------------------- a minimal site

const APP_NEEDS = needs('windows', 'state');

class TwoWindowApp implements Application<typeof APP_NEEDS> {
    readonly needs = APP_NEEDS;

    readonly views = [
        {
            id: 'alpha',
            title: 'Alpha',
            instances: 'one' as const,
            defaultSize: { width: 300, height: 200 },
            render: () => element('Text', { children: [text('alpha')] }),
        },
        {
            id: 'beta',
            title: 'Beta',
            instances: 'one' as const,
            defaultSize: { width: 300, height: 200 },
            // Declared unclosable. A6.3c-i made this mean something; here it is asserted through
            // chrome, which is where it can actually be got wrong.
            closable: false,
            render: () => element('Text', { children: [text('beta')] }),
        },
    ];

    async start(cx: Context<typeof APP_NEEDS>): Promise<void> {
        cx.windows.open({ view: 'alpha' });
        cx.windows.open({ view: 'beta' });
    }
}

interface Site {
    readonly manager: WindowManager;
    readonly shell: Shell;
    dispose(): void;
}

let site: Site | undefined;

afterEach(() => {
    site?.dispose();
    site = undefined;
    document.body.innerHTML = '';
});

async function boot(frame?: FrameChrome): Promise<Site> {
    const root = document.createElement('div');
    root.id = 'desktop';
    root.style.cssText = 'position:relative;width:900px;height:600px;overflow:hidden';
    document.body.appendChild(root);

    // The default chrome ships no stylesheet — the framework says which element is the title bar and
    // never what one looks like — so the test supplies the *appearance* a site would.
    //
    // It no longer supplies `position: absolute`, and that line is the point: it used to, which is
    // how this suite hid A6.3f from itself for as long as the shell existed. The test was providing
    // the one CSS rule the framework silently depended on, so every assertion below passed while a
    // site without that rule got a vertical stack of windows. The shell sets it now; leaving it out
    // here is what keeps that true.
    const style = document.createElement('style');
    style.textContent = `
        .window, .slab { box-sizing: border-box; display: flex; flex-direction: column; background: #fff; border: 1px solid #999; }
        .titlebar, .lozenge { height: 24px; flex: 0 0 auto; background: #eee; cursor: move; }
        .content, .belly { flex: 1 1 auto; overflow: auto; }
        .grip, .corner { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: se-resize; }
    `;
    document.head.appendChild(style);

    const manager = new WindowManager({ width: 900, height: 600 });
    const kernel = new Kernel();
    kernel.services.windows = windowSink(manager, (owner, view) => kernel.viewOf(owner, view));
    kernel.boot([{ id: 'app', contribution: new TwoWindowApp() as never }]);

    const shell = mountShell(root, {
        manager,
        viewOf: (owner, view) => kernel.viewOf(owner, view),
        apiOf: (owner) => kernel.processes.find((p) => p.pid === owner)?.api,
        isReady: (owner) => kernel.processes.find((p) => p.pid === owner)?.state === 'running',
        render: { components: createRegistry(PRIMITIVES), dispatch: { dispatch: () => {} } },
        onCommand: () => {},
        ...(frame === undefined ? {} : { frame }),
    });

    await kernel.start('app');

    const created: Site = {
        manager,
        shell,
        dispose() {
            shell.dispose();
            root.remove();
            style.remove();
        },
    };

    site = created;
    return created;
}

const idsOf = (manager: WindowManager): readonly string[] => manager.stacked().map((w) => w.id);

// ---------------------------------------------------------------------------- the default

describe('the framework paints windows now', () => {
    it('gives every window a real box on the screen', async () => {
        const created = await boot();
        const [first] = idsOf(created.manager);

        const host = created.shell.hostOf(first!)!;
        const rect = host.getBoundingClientRect();

        // jsdom computes no boxes, so this assertion is only meaningful here — and it is the whole
        // difference between a window manager and a list of rectangles in a signal.
        expect(rect.width).toBeGreaterThan(100);
        expect(rect.height).toBeGreaterThan(100);
    });

    it('moves a window by its title bar and leaves the view alone', async () => {
        const created = await boot();
        const id = idsOf(created.manager)[0]!;
        const host = created.shell.hostOf(id)!;

        const before = created.manager.get(id)!.rect;
        const bar = host.querySelector('.titlebar')!;

        await userEvent.dragAndDrop(bar, document.body, { targetPosition: { x: 500, y: 400 } });

        const after = created.manager.get(id)!.rect;
        expect(after.x === before.x && after.y === before.y).toBe(false);

        // Same element, still mounted, never re-parented. The view is not part of a geometry change.
        expect(created.shell.hostOf(id)).toBe(host);
        expect(host.querySelector('.content')?.textContent).toContain('alpha');
    });

    it('draws no close button for a window that declared it may not be closed', async () => {
        const created = await boot();
        const beta = created.manager.stacked().find((w) => w.title === 'Beta')!;

        const buttons = created.shell.hostOf(beta.id)!.querySelectorAll('.buttons button');

        // Maximize only. A button that did nothing would be worse than no button — and since
        // A6.3c-i the manager genuinely refuses, so this is the affordance matching the rule rather
        // than standing in for it.
        expect(buttons).toHaveLength(1);
        expect([...buttons].map((b) => b.textContent)).not.toContain('×');
    });
});

// ---------------------------------------------------------------------------- the seam

/** Chrome that looks nothing like the default and shares no class name with it. */
const strangeChrome: FrameChrome = ({ id, drag, manager }) => {
    const root = document.createElement('section');
    root.className = 'slab';
    root.dataset['slab'] = id;

    const lozenge = document.createElement('header');
    lozenge.className = 'lozenge';

    const belly = document.createElement('div');
    belly.className = 'belly';

    const corner = document.createElement('i');
    corner.className = 'corner';

    root.append(lozenge, belly, corner);
    drag(lozenge, (dx, dy) => { manager.move(id, dx, dy); });
    drag(corner, (dx, dy) => { manager.resize(id, 'se', dx, dy); });

    return {
        root,
        content: belly,
        update(record) { lozenge.textContent = record.title.toUpperCase(); },
    };
};

describe('how a window is drawn is replaceable', () => {
    it('uses the chrome the site supplied, and none of the default', async () => {
        const created = await boot(strangeChrome);

        expect(document.querySelectorAll('.slab')).toHaveLength(2);
        expect(document.querySelectorAll('.window')).toHaveLength(0);
        expect(document.querySelector('.lozenge')?.textContent).toBe('ALPHA');
    });

    it('still moves, because moving was never the chrome’s to do', async () => {
        const created = await boot(strangeChrome);
        const id = idsOf(created.manager)[0]!;
        const before = created.manager.get(id)!.rect;

        const lozenge = created.shell.hostOf(id)!.querySelector('.lozenge')!;
        await userEvent.dragAndDrop(lozenge, document.body, { targetPosition: { x: 500, y: 420 } });

        const after = created.manager.get(id)!.rect;
        expect(after.x === before.x && after.y === before.y).toBe(false);
    });
});

describe('what broken chrome cannot do', () => {
    /** Draws a box and wires nothing: no title bar, no buttons, no drag, no update. */
    const inertChrome: FrameChrome = () => {
        const root = document.createElement('div');
        root.className = 'slab';
        const belly = document.createElement('div');
        belly.className = 'belly';
        root.append(belly);
        return { root, content: belly };
    };

    it('cannot stop a window being positioned, stacked or hidden', async () => {
        const created = await boot(inertChrome);
        const [first, second] = idsOf(created.manager);

        // Positioned by the kernel, whatever the chrome did or did not do.
        expect(created.shell.hostOf(first!)!.style.left).not.toBe('');
        expect(created.shell.hostOf(first!)!.style.zIndex).not.toBe('');

        created.manager.focus(first!);
        expect(idsOf(created.manager).at(-1)).toBe(first);

        // The paint is an effect over the manager's signals, so a test that changes the manager and
        // looks at the DOM in the same tick is looking before the frame. That is the shell working
        // as designed — nothing repaints per mutation — not a race.
        created.manager.setMode('tiled');
        flushSync();
        // Neither view targets a tile, so tiled mode shows nothing — and it is the shell that hides
        // them, not the chrome, which is exactly the point.
        expect(created.shell.hostOf(second!)!.hidden).toBe(true);
    });

    it('cannot keep a window alive after the manager closes it', async () => {
        const created = await boot(inertChrome);
        const id = idsOf(created.manager)[0]!;
        const host = created.shell.hostOf(id)!;

        created.manager.close(id);
        flushSync();

        expect(host.isConnected).toBe(false);
        expect(created.shell.hostOf(id)).toBeUndefined();
    });

    it('cannot close a window the view forbade, however it asks', async () => {
        const created = await boot(inertChrome);
        const beta = created.manager.stacked().find((w) => w.title === 'Beta')!;

        created.manager.close(beta.id);
        flushSync();

        expect(created.shell.hostOf(beta.id)?.isConnected).toBe(true);
    });
});

/**
 * Roadmap A6.3f — **whoever writes `left` owns `position`.**
 *
 * The paint sets `left`, `top`, `width` and `height` from the manager and, until this was fixed,
 * never said the box was positioned. A stylesheet that did not happen to declare
 * `position: absolute` got every window laid out as an ordinary block: stacked down the left edge in
 * document order, at the right *sizes*, with no error and nothing in the console.
 *
 * Found by the first site built outside this repository. The framework's own harness had the rule in
 * its stylesheet — and so did this suite, one line above `boot` — which is why nothing here noticed
 * that the framework depended on a CSS rule it never mentioned. Removing that line from the fixture
 * is half the fix; these are the other half.
 *
 * They assert against **laid-out geometry**, never against style properties, because that is what
 * was actually wrong: every style was set correctly and none of it had any effect.
 */
describe('the shell positions windows without help from a stylesheet', () => {
    it('puts a window where the manager says', async () => {
        const created = await boot();
        const [first, second] = idsOf(created.manager);

        const rect = created.manager.rectOf(first!)!;
        const desktop = document.getElementById('desktop')!.getBoundingClientRect();
        const box = created.shell.hostOf(first!)!.getBoundingClientRect();

        expect(Math.round(box.left - desktop.left)).toBe(rect.x);
        expect(Math.round(box.top - desktop.top)).toBe(rect.y);

        // The failure this replaces was two windows stacked at x = 0, each the *right size* — so a
        // size assertion alone passed, and did. Only their relative placement catches it.
        const other = created.shell.hostOf(second!)!.getBoundingClientRect();
        expect(other.left - box.left).toBe(28);
        expect(other.top - box.top).toBe(28);
    });

    it('makes the window area a containing block when the site left it static', async () => {
        // An absolutely positioned window inside a `static` host escapes to the nearest positioned
        // ancestor — the viewport — and leaves the area the chrome set aside for it entirely.
        const host = document.createElement('div');
        host.style.cssText = 'width:400px;height:300px';
        document.body.appendChild(host);

        const shell = mountShell(host, {
            manager: new WindowManager({ width: 400, height: 300 }),
            viewOf: () => undefined,
            apiOf: () => undefined,
            render: { components: createRegistry(PRIMITIVES), dispatch: { dispatch: () => {} } },
            onCommand: () => {},
        });

        expect(getComputedStyle(host).position).toBe('relative');

        shell.dispose();
        host.remove();
    });

    it('leaves a host the site already positioned alone', async () => {
        // A site that chose `absolute` or `fixed` made a decision. A framework arguing with a
        // stylesheet it cannot see would be a worse bug than the one being fixed.
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;width:400px;height:300px';
        document.body.appendChild(host);

        const shell = mountShell(host, {
            manager: new WindowManager({ width: 400, height: 300 }),
            viewOf: () => undefined,
            apiOf: () => undefined,
            render: { components: createRegistry(PRIMITIVES), dispatch: { dispatch: () => {} } },
            onCommand: () => {},
        });

        expect(getComputedStyle(host).position).toBe('absolute');

        shell.dispose();
        host.remove();
    });
});
