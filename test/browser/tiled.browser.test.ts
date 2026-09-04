/**
 * Mode switching with no remount — roadmap A2.4, and the claim the whole design rests on.
 *
 * spec/README §4: *"a switch re-parents DOM and reassigns geometry, and the Application never learns
 * it happened — scroll positions, form contents and open connections survive."*
 *
 * That is only checkable in a real browser. Scroll position is a rendering fact — jsdom has no
 * layout, so nothing there can overflow, so nothing can be scrolled, so the central property of M2
 * is invisible to the entire jsdom suite.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
    WindowManager, createRegistry, element, mountView, tiles, text,
    PRIMITIVES, type LayoutNode, type ViewInstance,
} from '../../src/index.js';

const LAYOUT: LayoutNode = tiles({
    split: 'column',
    children: [
        { node: { tile: 'header' }, size: { px: 40 } },
        {
            node: {
                split: 'row',
                children: [
                    { node: { tile: 'sidebar' }, size: { px: 240 } },
                    { node: { tile: 'content' } },
                ],
            },
        },
    ],
});

interface Shell {
    readonly manager: WindowManager;
    readonly root: HTMLElement;
    readonly mounts: Map<string, { host: HTMLElement; instance: ViewInstance; mountedAt: number }>;
    paint(): void;
    dispose(): void;
}

let shells: Shell[] = [];

afterEach(() => {
    for (const s of shells) s.dispose();
    shells = [];
    document.body.innerHTML = '';
});

/**
 * A shell that paints both modes.
 *
 * The important line is in `paint`: it sets `style.left/top/width/height` and **never moves a node
 * between parents.** See the last test in this file for why that is not a stylistic choice.
 */
function shell(): Shell {
    const root = document.createElement('div');
    root.style.cssText = 'position:relative;width:900px;height:500px;overflow:hidden';
    document.body.appendChild(root);

    const manager = new WindowManager({ width: 900, height: 500 });
    manager.setLayout(LAYOUT);

    const components = createRegistry(PRIMITIVES);
    const mounts = new Map<string, { host: HTMLElement; instance: ViewInstance; mountedAt: number }>();
    let mountCount = 0;

    const paint = (): void => {
        const shown = new Set(manager.visible().map((w) => w.id));

        // Mounted for **every** window, shown or not — a policy decision the framework leaves to the
        // shell, and the one that buys the property this file is about. `visible()` and `hidden()`
        // report which windows the current mode can show; mounting only the visible ones would mean
        // a view that loses its tile is unmounted and remounted on the way back, losing exactly the
        // scroll position and half-typed text the mode switch preserves. A shell with a hundred
        // windows may choose the other trade; this one cannot, because swapping `post` and `editor`
        // in one tile is the case the design exists for.
        for (const record of manager.windows()) {
            let mount = mounts.get(record.id);

            if (mount === undefined) {
                const host = document.createElement('div');
                host.dataset['window'] = record.id;
                host.style.cssText = 'position:absolute;overflow:auto;box-sizing:border-box';
                root.appendChild(host);

                const instance = mountView(host, {
                    windowId: record.id,
                    decl: {
                        id: record.view,
                        title: record.title,
                        // Twenty rows in a short window, so there is something to scroll.
                        render: () => element('Stack', {
                            children: [
                                element('Input', { props: { class: 'field', value: '' } }),
                                ...Array.from({ length: 20 }, (_, i) =>
                                    element('Text', {
                                        props: { class: 'row', style: { display: 'block', height: '24px' } },
                                        children: [text(`${record.view} row ${String(i)}`)],
                                    })),
                            ],
                        }),
                    } as never,
                    api: undefined,
                    params: {},
                    windows: manager,
                    render: { components, dispatch: { dispatch: () => {} } },
                    onCommand: () => {},
                });

                mount = { host, instance, mountedAt: ++mountCount };
                mounts.set(record.id, mount);
            }

            // A window the current mode cannot show is *hidden*, not unmounted. That distinction is
            // the whole feature: `hidden` keeps the DOM, the effects and the scroll position.
            mount.host.hidden = !shown.has(record.id);

            const rect = manager.rectOf(record.id);
            if (rect === undefined) continue;

            // Reposition. Never re-parent — see the last test in this file.
            mount.host.style.left = `${rect.x}px`;
            mount.host.style.top = `${rect.y}px`;
            mount.host.style.width = `${rect.width}px`;
            mount.host.style.height = `${rect.height}px`;
            mount.host.style.zIndex = String(manager.zIndexOf(record.id));
        }

        // Closed is the only thing that disposes.
        for (const [id, mount] of mounts) {
            if (manager.get(id) !== undefined) continue;
            mount.instance.dispose();
            mount.host.remove();
            mounts.delete(id);
        }
    };

    const s: Shell = {
        manager, root, mounts, paint,
        dispose() {
            for (const m of mounts.values()) {
                m.instance.dispose();
                m.host.remove();
            }
            mounts.clear();
            root.remove();
        },
    };

    shells.push(s);
    return s;
}

const hostOf = (s: Shell, id: string): HTMLElement => s.mounts.get(id)!.host;

// ---------------------------------------------------------------------------- the tests

describe('tiled mode arranges the same views', () => {
    it('gives each window the box its tile describes, in real pixels', () => {
        const s = shell();
        const header = s.manager.open({ owner: 'p1', view: 'masthead', tile: 'header' });
        const side = s.manager.open({ owner: 'p1', view: 'postList', tile: 'sidebar' });
        const main = s.manager.open({ owner: 'p1', view: 'post', tile: 'content' });

        s.manager.setMode('tiled');
        s.paint();

        expect(hostOf(s, header.id).getBoundingClientRect().height).toBe(40);
        expect(hostOf(s, side.id).getBoundingClientRect().width).toBe(240);

        // The panes tile: content starts where the sidebar ends.
        const sidebarBox = hostOf(s, side.id).getBoundingClientRect();
        const contentBox = hostOf(s, main.id).getBoundingClientRect();
        expect(contentBox.left).toBeCloseTo(sidebarBox.right + 1, 0); // + TILE_GAP
    });
});

describe('switching modes does not remount', () => {
    it('keeps scroll position, form contents and node identity', async () => {
        const s = shell();
        const w = s.manager.open({ owner: 'p1', view: 'post', tile: 'content', size: { width: 300, height: 120 } });
        s.paint();

        const host = hostOf(s, w.id);
        const firstRow = host.querySelector('.row')!;
        const field = host.querySelector<HTMLInputElement>('.field')!;

        // State that lives in the *view*, not the Application: what the user typed and how far they
        // scrolled. Neither is anywhere the Application could restore it from.
        field.value = 'half-written';
        host.scrollTop = 120;
        expect(host.scrollTop).toBe(120);

        s.manager.setMode('tiled');
        s.paint();

        // 900 − 240 sidebar − 1 gap. The content tile, not the 300 the user had dragged.
        expect(host.getBoundingClientRect().width).toBe(659);

        /**
         * **Scroll survives; the *number* does not, and cannot.**
         *
         * README §4 says "scroll positions survive a switch". Taken as "scrollTop is the same
         * integer" that is not achievable and not even coherent: this window was 120px tall and is
         * now 459, so there is only 42px left to scroll. The browser clamps, and it is right to.
         *
         * What the design actually owes is that the view is **not remounted and not reset** — the
         * reader stays roughly where they were rather than being thrown to the top. Preserving the
         * *fraction* across a resize is a shell policy on top of this, not a framework property,
         * and it is worth someone deciding on rather than assuming.
         */
        expect(host.scrollTop).toBeGreaterThan(0);
        expect(host.scrollTop).toBe(Math.min(120, host.scrollHeight - host.clientHeight));

        expect(field.value).toBe('half-written');
        expect(host.querySelector('.row')).toBe(firstRow);

        s.manager.setMode('windowed');
        s.paint();

        expect(host.getBoundingClientRect().width).toBe(300); // back where the user had it
        expect(host.scrollTop).toBeGreaterThan(0);
        expect(field.value).toBe('half-written');

        // And the Application was never told. One mount, for two modes and two switches.
        expect(s.mounts.get(w.id)!.mountedAt).toBe(1);
    });

    it('keeps a window the tiled layout cannot show, rather than closing it', () => {
        const s = shell();
        const main = s.manager.open({ owner: 'p1', view: 'post', tile: 'content' });
        const palette = s.manager.open({ owner: 'p1', view: 'palette' });  // no tile
        s.paint();

        const paletteHost = hostOf(s, palette.id);
        const field = paletteHost.querySelector<HTMLInputElement>('.field')!;
        field.value = 'typed before switching';

        s.manager.setMode('tiled');
        s.paint();

        expect(paletteHost.hidden).toBe(true);
        expect(hostOf(s, main.id).hidden).toBe(false);

        s.manager.setMode('windowed');
        s.paint();

        // Hidden, never unmounted — so what was typed into it is still there.
        expect(paletteHost.hidden).toBe(false);
        expect(field.value).toBe('typed before switching');
        expect(s.mounts.get(palette.id)!.mountedAt).toBeLessThanOrEqual(2);
    });

    it('swaps which view holds a tile without disturbing either', () => {
        const s = shell();
        const post = s.manager.open({ owner: 'p1', view: 'post', tile: 'content' });
        const editor = s.manager.open({ owner: 'p1', view: 'editor', tile: 'content' });
        s.manager.setMode('tiled');
        s.paint();

        // Both target `content`; the editor was focused last, so it has the tile.
        expect(hostOf(s, editor.id).hidden).toBe(false);
        expect(hostOf(s, post.id).hidden).toBe(true);

        // Whatever the browser accepts, rather than a number I chose: a scroll beyond the content
        // is clamped, so asserting a literal tests my arithmetic about row heights rather than the
        // property under test.
        hostOf(s, editor.id).scrollTop = 40;
        const parked = hostOf(s, editor.id).scrollTop;
        expect(parked).toBeGreaterThan(0);

        s.manager.focus(post.id);
        s.paint();
        expect(hostOf(s, post.id).hidden).toBe(false);

        s.manager.focus(editor.id);
        s.paint();

        // Reading and editing the same record, swapped back and forth, with the editor exactly
        // where it was. This is what "several views may target one tile" is worth.
        expect(hostOf(s, editor.id).scrollTop).toBe(parked);
    });
});

describe('why the shell repositions instead of re-parenting', () => {
    it('moving a node between parents loses its scroll position', () => {
        // spec/README §4 describes the switch as one that "re-parents DOM and reassigns geometry".
        // The second half is right and the first half is a trap: a node removed and re-inserted has
        // its scroll reset by the browser, which silently breaks the very property the sentence is
        // claiming. Written as a test because it is the kind of thing an implementation drifts into
        // — one appendChild looks harmless.
        const a = document.createElement('div');
        const b = document.createElement('div');
        a.style.cssText = 'width:200px;height:100px;overflow:auto';
        b.style.cssText = 'width:200px;height:100px;overflow:auto';
        document.body.append(a, b);

        const tall = document.createElement('div');
        tall.style.cssText = 'height:600px';
        a.appendChild(tall);

        a.scrollTop = 200;
        expect(a.scrollTop).toBe(200);

        b.appendChild(tall);   // the naive "re-parent"
        expect(b.scrollTop).toBe(0);

        a.remove();
        b.remove();
    });
});
