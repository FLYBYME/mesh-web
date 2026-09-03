import { describe, expect, it } from 'vitest';

import {
    cascade, clampSize, constrainToViewport, DEFAULT_MIN, maximize, move, raise, resize,
    WindowManager, type Rect,
} from '../src/index.js';

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

describe('geometry is pure, so the sign errors are cheap to find', () => {
    it('moves', () => {
        expect(move(rect(10, 10, 100, 100), 5, -5)).toEqual(rect(15, 5, 100, 100));
    });

    // An explicit minimum, because DEFAULT_MIN is 160x80 and would otherwise clamp these — which is
    // itself worth knowing: the first version of this test asserted a 120px width and got 160.
    const tiny = { width: 10, height: 10 };

    it('resizes from the south-east without moving the origin', () => {
        expect(resize(rect(10, 10, 100, 100), 'se', 20, 30, tiny)).toEqual(rect(10, 10, 120, 130));
    });

    it('resizes from the north-west by moving the origin too', () => {
        expect(resize(rect(100, 100, 200, 200), 'nw', 20, 30, tiny)).toEqual(rect(120, 130, 180, 170));
    });

    it('stops the origin walking once the minimum is reached', () => {
        // The classic bug: drag the west edge past the minimum and the window slides across the
        // screen because x keeps moving after width has stopped shrinking.
        const min = { width: 100, height: 100 };
        const shrunk = resize(rect(0, 0, 120, 120), 'w', 500, 0, min);

        expect(shrunk.width).toBe(100);
        expect(shrunk.x).toBe(20); // 120 - 100, and no further
    });

    it('honours a minimum on every edge', () => {
        const min = { width: 50, height: 50 };
        expect(resize(rect(0, 0, 60, 60), 'se', -100, -100, min)).toEqual(rect(0, 0, 50, 50));
        expect(resize(rect(0, 0, 60, 60), 'n', 0, 100, min).height).toBe(50);
    });

    it('clamps a size below the default minimum', () => {
        expect(clampSize(rect(0, 0, 1, 1))).toEqual(rect(0, 0, DEFAULT_MIN.width, DEFAULT_MIN.height));
    });

    it('keeps a window reachable', () => {
        const viewport = { width: 1000, height: 800 };
        expect(constrainToViewport(rect(0, -200, 300, 200), viewport).y).toBe(0);
        expect(constrainToViewport(rect(5000, 100, 300, 200), viewport).x).toBe(1000 - 32);
        // Dragged left until almost off-screen: a strip stays grabbable.
        expect(constrainToViewport(rect(-5000, 100, 300, 200), viewport).x).toBe(32 - 300);
    });

    it('maximizes to the viewport', () => {
        expect(maximize({ width: 800, height: 600 })).toEqual(rect(0, 0, 800, 600));
    });

    it('cascades rather than centring, so the second window is not hidden by the first', () => {
        const viewport = { width: 1000, height: 800 };
        const size = { width: 200, height: 200 };
        expect(cascade(0, size, viewport)).not.toEqual(cascade(1, size, viewport));
    });

    it('raises without disturbing the rest of the order', () => {
        expect(raise(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
        expect(raise(['a', 'b', 'c'], 'c')).toEqual(['a', 'b', 'c']);
    });
});

describe('the window manager', () => {
    const open = (m: WindowManager, owner = 'p1', view = 'editor') => m.open({ owner, view });

    it('stacks in open order and raises on focus', () => {
        const m = new WindowManager();
        const a = open(m);
        const b = open(m);

        expect(m.stacked().map((w) => w.id)).toEqual([a.id, b.id]);
        expect(m.focused()).toBe(b.id);

        m.focus(a.id);
        expect(m.stacked().map((w) => w.id)).toEqual([b.id, a.id]);
        expect(m.zIndexOf(a.id)).toBeGreaterThan(m.zIndexOf(b.id));
    });

    it('moves and resizes', () => {
        const m = new WindowManager();
        const w = open(m);
        const before = w.rect;

        m.move(w.id, 20, 20);
        expect(m.get(w.id)!.rect).toMatchObject({ x: before.x + 20, y: before.y + 20 });

        m.resize(w.id, 'se', 50, 50);
        expect(m.get(w.id)!.rect.width).toBe(before.width + 50);
    });

    it('maximizes and restores to where it was', () => {
        const m = new WindowManager({ width: 1000, height: 800 });
        const w = open(m);
        const original = m.get(w.id)!.rect;

        m.maximize(w.id);
        expect(m.get(w.id)!.rect).toEqual(rect(0, 0, 1000, 800));
        expect(m.get(w.id)!.state).toBe('maximized');

        m.restore(w.id);
        expect(m.get(w.id)!.rect).toEqual(original);
        expect(m.get(w.id)!.state).toBe('normal');
    });

    it('will not drag a maximized window', () => {
        const m = new WindowManager();
        const w = open(m);
        m.maximize(w.id);
        const maximized = m.get(w.id)!.rect;

        m.move(w.id, 100, 100);
        expect(m.get(w.id)!.rect).toEqual(maximized);
    });

    it('moves focus off a window it minimizes', () => {
        const m = new WindowManager();
        const a = open(m);
        const b = open(m);

        m.minimize(b.id);
        expect(m.focused()).toBe(a.id);
    });

    it('closes everything one process owns', () => {
        const m = new WindowManager();
        open(m, 'p1');
        open(m, 'p1');
        open(m, 'p2');

        m.closeOwnedBy('p1');
        expect(m.windows().map((w) => w.owner)).toEqual(['p2']);
    });

    it('follows the viewport for maximized windows and pulls the rest back into reach', () => {
        const m = new WindowManager({ width: 1000, height: 800 });
        const big = open(m);
        const small = open(m);
        m.maximize(big.id);
        m.move(small.id, 900, 0);

        m.setViewport({ width: 600, height: 400 });

        expect(m.get(big.id)!.rect).toEqual(rect(0, 0, 600, 400));
        // A user's chosen size is theirs: a narrower screen moves a window, it does not resize it.
        expect(m.get(small.id)!.rect.width).toBe(small.rect.width);
        expect(m.get(small.id)!.rect.x).toBeLessThanOrEqual(600 - 32);
    });
});
