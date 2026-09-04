/**
 * The layout: a split tree, and where each tile lands.
 *
 * spec/application.md §6 and roadmap A2.3. All of it is pure, which is deliberate — geometry is the
 * part most likely to be subtly wrong (a fraction that does not add up, a fixed pane that eats a
 * flexible one) and none of that needs a browser to catch.
 */

import { describe, expect, it } from 'vitest';

import {
    tileNames, tileRects, tiles, WindowManager,
    type LayoutNode, type Rect,
} from '../src/index.js';

const screen = { width: 1000, height: 600 };

/** The blog from the spec: a header, a sidebar beside content, a footer. */
const blog: LayoutNode = tiles({
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
        { node: { tile: 'footer' }, size: { px: 24 } },
    ],
});

const rect = (r: Rect | undefined): Rect => {
    if (r === undefined) throw new Error('expected a rect');
    return r;
};

describe('a layout places its tiles', () => {
    it('takes fixed sizes first and divides what is left', () => {
        const at = tileRects(blog, screen);

        expect(rect(at.get('header'))).toEqual({ x: 0, y: 0, width: 1000, height: 40 });
        expect(rect(at.get('footer'))).toEqual({ x: 0, y: 576, width: 1000, height: 24 });

        // 600 − 40 − 24 = 536 for the middle row, split 240 / 760.
        expect(rect(at.get('sidebar'))).toEqual({ x: 0, y: 40, width: 240, height: 536 });
        expect(rect(at.get('content'))).toEqual({ x: 240, y: 40, width: 760, height: 536 });
    });

    it('keeps a fixed pane fixed when the screen shrinks', () => {
        const at = tileRects(blog, { width: 400, height: 300 });

        // The one thing a fixed size was asked for: a 40px header is 40px on a phone too. Dividing
        // first and then taking fixed sizes would make it 7% of the height and unreadable.
        expect(rect(at.get('header')).height).toBe(40);
        expect(rect(at.get('footer')).height).toBe(24);
        expect(rect(at.get('content')).height).toBe(300 - 40 - 24);
    });

    it('divides fractions relative to each other, not to a total anyone maintains', () => {
        const thirds = tiles({
            split: 'row',
            children: [
                { node: { tile: 'a' }, size: 1 },
                { node: { tile: 'b' }, size: 3 },
            ],
        });

        const at = tileRects(thirds, { width: 800, height: 100 });
        expect(rect(at.get('a')).width).toBe(200);
        expect(rect(at.get('b')).width).toBe(600);

        // Adding a third pane re-divides without editing the other two, which is why these are
        // weights rather than percentages that must sum to 100.
        const withC = tiles({
            split: 'row',
            children: [
                { node: { tile: 'a' }, size: 1 },
                { node: { tile: 'b' }, size: 3 },
                { node: { tile: 'c' }, size: 4 },
            ],
        });
        expect(rect(tileRects(withC, { width: 800, height: 100 }).get('c')).width).toBe(400);
    });

    it('treats an absent size as one share', () => {
        const even = tiles({ split: 'row', children: [{ node: { tile: 'a' } }, { node: { tile: 'b' } }] });
        const at = tileRects(even, { width: 500, height: 100 });
        expect(rect(at.get('a')).width).toBe(250);
        expect(rect(at.get('b')).width).toBe(250);
    });

    it('puts a gap between panes and never around the outside', () => {
        const two = tiles({ split: 'row', children: [{ node: { tile: 'a' } }, { node: { tile: 'b' } }] });
        const at = tileRects(two, { width: 500, height: 100 }, { gap: 10 });

        expect(rect(at.get('a'))).toEqual({ x: 0, y: 0, width: 245, height: 100 });
        expect(rect(at.get('b'))).toEqual({ x: 255, y: 0, width: 245, height: 100 });

        // The panes plus one gap fill the screen exactly: no border at the edges.
        expect(rect(at.get('b')).x + rect(at.get('b')).width).toBe(500);
    });

    it('scales fixed panes together rather than pushing one off the edge', () => {
        const tooBig = tiles({
            split: 'column',
            children: [
                { node: { tile: 'a' }, size: { px: 300 } },
                { node: { tile: 'b' }, size: { px: 300 } },
            ],
        });

        const at = tileRects(tooBig, { width: 100, height: 200 });

        // A layout mistake, and the useful behaviour is everything visible and obviously cramped —
        // not one pane silently absent below the fold.
        expect(rect(at.get('a')).height).toBe(100);
        expect(rect(at.get('b')).height).toBe(100);
        expect(rect(at.get('b')).y).toBe(100);
    });

    it('nests to any depth', () => {
        const nested = tiles({
            split: 'row',
            children: [
                { node: { tile: 'left' } },
                {
                    node: {
                        split: 'column',
                        children: [{ node: { tile: 'top' } }, { node: { tile: 'bottom' } }],
                    },
                },
            ],
        });

        const at = tileRects(nested, { width: 400, height: 400 });
        expect(rect(at.get('left'))).toEqual({ x: 0, y: 0, width: 200, height: 400 });
        expect(rect(at.get('top'))).toEqual({ x: 200, y: 0, width: 200, height: 200 });
        expect(rect(at.get('bottom'))).toEqual({ x: 200, y: 200, width: 200, height: 200 });
    });

    it('lists its tile names in order', () => {
        expect(tileNames(blog)).toEqual(['header', 'sidebar', 'content', 'footer']);
    });
});

describe('a layout that could not be honoured is refused when it is written', () => {
    it('refuses two tiles with one name', () => {
        // A tile is an address. Two places with one address means a view targeting it lands
        // somewhere by accident, and which one would depend on traversal order.
        expect(() => tiles({
            split: 'row',
            children: [{ node: { tile: 'main' } }, { node: { tile: 'main' } }],
        })).toThrow(/twice/);
    });

    it('refuses an empty split and an unnamed tile', () => {
        expect(() => tiles({ split: 'row', children: [] })).toThrow(/empty row/);
        expect(() => tiles({ tile: '  ' })).toThrow(/unnamed tile/);
    });
});

// ---------------------------------------------------------------------------- the manager

describe('the manager in tiled mode', () => {
    const open = (m: WindowManager, view: string, tile?: string) =>
        m.open({ owner: 'p1', view, ...(tile === undefined ? {} : { tile }) });

    const tiled = (): WindowManager => {
        const m = new WindowManager(screen);
        m.setLayout(blog);
        m.setMode('tiled');
        return m;
    };

    it('places a window by the tile its view targets', () => {
        const m = tiled();
        const w = open(m, 'postList', 'sidebar');

        const at = m.rectOf(w.id)!;
        expect(at.width).toBe(240);
        expect(at.x).toBe(0);
    });

    it('leaves the window’s own rect alone, so switching back restores it', () => {
        const m = new WindowManager(screen);
        m.setLayout(blog);

        const w = open(m, 'postList', 'sidebar');
        m.move(w.id, 60, 40);
        const dragged = { ...m.get(w.id)!.rect };

        m.setMode('tiled');
        expect(m.rectOf(w.id)!.width).toBe(240);   // the tile
        expect(m.get(w.id)!.rect).toEqual(dragged); // untouched

        m.setMode('windowed');
        expect(m.rectOf(w.id)).toEqual(dragged);
    });

    it('gives a tile to one view at a time, most recently focused', () => {
        const m = tiled();
        const post = open(m, 'post', 'content');
        const editor = open(m, 'editor', 'content');

        // Both target `content`. Opening the editor focused it, so it occupies the tile.
        expect(m.visible().map((w) => w.id)).toContain(editor.id);
        expect(m.visible().map((w) => w.id)).not.toContain(post.id);

        // And the other is *hidden*, not closed — nothing was disposed, which is the whole reason
        // mode is a view concern rather than an application one.
        expect(m.hidden().map((w) => w.id)).toEqual([post.id]);
        expect(m.get(post.id)).toBeDefined();

        m.focus(post.id);
        expect(m.visible().map((w) => w.id)).toContain(post.id);
    });

    it('does not show a view with no tile, or one naming a tile the layout lacks', () => {
        const m = tiled();
        const floating = open(m, 'palette');
        const wrong = open(m, 'stray', 'nowhere');

        expect(m.visible()).toHaveLength(0);
        expect(m.hidden().map((w) => w.id).sort()).toEqual([floating.id, wrong.id].sort());

        // Both are ordinary windows the moment the mode changes.
        m.setMode('windowed');
        expect(m.visible()).toHaveLength(2);
    });

    it('shows nothing tiled when the Application declared no layout', () => {
        const m = new WindowManager(screen);
        m.setMode('tiled');
        open(m, 'postList', 'sidebar');

        expect(m.visible()).toHaveLength(0);
        expect(m.rectOf(m.windows()[0]!.id)).toBeUndefined();
    });

    it('follows the viewport, because a tile is a fraction of it', () => {
        const m = tiled();
        const w = open(m, 'post', 'content');
        const before = m.rectOf(w.id)!;

        m.setViewport({ width: 500, height: 600 });
        expect(m.rectOf(w.id)!.width).toBeLessThan(before.width);
    });
});
