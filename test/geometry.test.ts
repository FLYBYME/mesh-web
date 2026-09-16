/**
 * Pure-function tests for src/window/geometry.ts.
 *
 * No DOM. No jsdom. Every expected value is worked out arithmetically in the comments so a failure
 * tells you which branch of the logic is wrong, not just that something changed.
 */

import { describe, expect, it } from 'vitest';

import {
    DEFAULT_MIN,
    clampSize,
    move,
    resize,
    constrainToViewport,
    maximize,
    cascade,
    raise,
    type Rect,
    type Size,
} from '../src/window/geometry.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const r = (x: number, y: number, width: number, height: number): Rect =>
    ({ x, y, width, height });

// ---------------------------------------------------------------------------
// clampSize
// ---------------------------------------------------------------------------

describe('clampSize', () => {
    it('does not modify a rect already larger than the default minimum', () => {
        const rect = r(10, 20, 300, 200);
        expect(clampSize(rect)).toEqual(r(10, 20, 300, 200));
    });

    it('clamps width when below default minimum, leaves height alone', () => {
        // DEFAULT_MIN = { width: 160, height: 80 }
        // width 50 < 160 → clamped to 160; height 200 >= 80 → unchanged
        const rect = r(5, 5, 50, 200);
        expect(clampSize(rect)).toEqual(r(5, 5, 160, 200));
    });

    it('clamps height when below default minimum, leaves width alone', () => {
        // height 20 < 80 → clamped to 80; width 200 >= 160 → unchanged
        const rect = r(5, 5, 200, 20);
        expect(clampSize(rect)).toEqual(r(5, 5, 200, 80));
    });

    it('clamps both dimensions when both are below minimum', () => {
        const rect = r(0, 0, 1, 1);
        expect(clampSize(rect)).toEqual(r(0, 0, DEFAULT_MIN.width, DEFAULT_MIN.height));
    });

    it('does not change position (x, y are preserved)', () => {
        const rect = r(77, 99, 50, 20);
        const result = clampSize(rect);
        expect(result.x).toBe(77);
        expect(result.y).toBe(99);
    });

    it('respects a custom minimum', () => {
        const min: Size = { width: 400, height: 300 };
        const rect = r(10, 10, 200, 150);
        // 200 < 400 → 400; 150 < 300 → 300
        expect(clampSize(rect, min)).toEqual(r(10, 10, 400, 300));
    });

    it('uses DEFAULT_MIN when no min argument is given', () => {
        const rect = r(0, 0, 1, 1);
        expect(clampSize(rect)).toEqual(clampSize(rect, DEFAULT_MIN));
    });

    it('returns a value equal to the minimum when rect is exactly at minimum', () => {
        const rect = r(0, 0, DEFAULT_MIN.width, DEFAULT_MIN.height);
        expect(clampSize(rect)).toEqual(rect);
    });
});

// ---------------------------------------------------------------------------
// move
// ---------------------------------------------------------------------------

describe('move', () => {
    it('translates in both axes by positive deltas', () => {
        expect(move(r(10, 20, 100, 50), 5, 15)).toEqual(r(15, 35, 100, 50));
    });

    it('translates by negative deltas', () => {
        expect(move(r(50, 60, 200, 80), -10, -20)).toEqual(r(40, 40, 200, 80));
    });

    it('translates by zero (identity)', () => {
        const rect = r(7, 8, 300, 150);
        expect(move(rect, 0, 0)).toEqual(rect);
    });

    it('does not change size', () => {
        const rect = r(0, 0, 123, 456);
        const result = move(rect, 99, -99);
        expect(result.width).toBe(123);
        expect(result.height).toBe(456);
    });

    it('handles large deltas without overflow', () => {
        expect(move(r(0, 0, 100, 100), 10000, -10000)).toEqual(r(10000, -10000, 100, 100));
    });
});

// ---------------------------------------------------------------------------
// resize — edge-by-edge
// ---------------------------------------------------------------------------

describe('resize – east edge', () => {
    // 'e': width += dx, clamped to min; y, x, height unchanged
    it('increases width, leaves origin and height unchanged', () => {
        const result = resize(r(10, 20, 100, 80), 'e', 40, 0);
        // width = max(100+40, 160) = 140  (still below DEFAULT_MIN 160)
        expect(result).toEqual(r(10, 20, 160, 80));
    });

    it('increases width beyond DEFAULT_MIN correctly', () => {
        const result = resize(r(0, 0, 200, 100), 'e', 50, 0);
        // width = max(200+50, 160) = 250
        expect(result).toEqual(r(0, 0, 250, 100));
    });

    it('clamps width to custom minimum when dx is large and negative', () => {
        const min = { width: 50, height: 50 };
        const result = resize(r(0, 0, 100, 100), 'e', -200, 0, min);
        // width = max(100 + (-200), 50) = max(-100, 50) = 50
        expect(result.width).toBe(50);
        expect(result.x).toBe(0);   // origin must not move
        expect(result.y).toBe(0);
    });
});

describe('resize – south edge', () => {
    // 's': height += dy, clamped to min; x, y, width unchanged
    it('increases height, leaves origin and width unchanged', () => {
        const result = resize(r(5, 10, 200, 100), 's', 0, 60);
        // height = max(100+60, 80) = 160
        expect(result).toEqual(r(5, 10, 200, 160));
    });

    it('clamps height to minimum when dy is large and negative', () => {
        const min = { width: 50, height: 50 };
        const result = resize(r(10, 10, 100, 100), 's', 0, -200, min);
        // height = max(100 - 200, 50) = 50
        expect(result.height).toBe(50);
        expect(result.y).toBe(10);  // origin must not move
        expect(result.x).toBe(10);
    });
});

describe('resize – north edge', () => {
    // 'n': proposed = height - dy; clamped = max(proposed, min)
    //       y += height - clamped; height = clamped
    // Dragging DOWN (dy > 0) → proposed height shrinks → y increases
    it('moves y down and shrinks height when dragged downward (dy > 0)', () => {
        // rect: x=100, y=100, w=200, h=200; dy=50; min default(80)
        // proposed = 200 - 50 = 150; clamped = max(150,80) = 150
        // y = 100 + (200 - 150) = 150; height = 150
        const result = resize(r(100, 100, 200, 200), 'n', 0, 50);
        expect(result.x).toBe(100);
        expect(result.y).toBe(150);
        expect(result.width).toBe(200);
        expect(result.height).toBe(150);
    });

    it('moves y up and grows height when dragged upward (dy < 0)', () => {
        // rect: x=50, y=50, w=200, h=100; dy=-30
        // proposed = 100 - (-30) = 130; clamped = 130
        // y = 50 + (100 - 130) = 20; height = 130
        const result = resize(r(50, 50, 200, 100), 'n', 0, -30);
        expect(result.y).toBe(20);
        expect(result.height).toBe(130);
    });

    it('stops y moving once minimum height is reached (classic bug)', () => {
        // The classic bug: drag north past the minimum → y keeps walking
        // rect: x=0, y=0, w=200, h=200; dy=500; min={w:10,h:100}
        // proposed = 200 - 500 = -300; clamped = max(-300, 100) = 100
        // y = 0 + (200 - 100) = 100;  NOT 0 + 500
        const min = { width: 10, height: 100 };
        const result = resize(r(0, 0, 200, 200), 'n', 0, 500, min);
        expect(result.height).toBe(100);
        expect(result.y).toBe(100);   // stopped at min, did not walk to 500
    });
});

describe('resize – west edge', () => {
    // 'w': proposed = width - dx; clamped = max(proposed, min)
    //       x += width - clamped; width = clamped
    // Dragging RIGHT (dx > 0) → proposed width shrinks → x increases
    it('moves x right and shrinks width when dragged rightward (dx > 0)', () => {
        // rect: x=100, y=100, w=200, h=200; dx=50
        // proposed = 200-50 = 150; clamped = max(150,160) = 160
        // x = 100 + (200 - 160) = 140; width = 160
        const result = resize(r(100, 100, 200, 200), 'w', 50, 0);
        expect(result.x).toBe(140);
        expect(result.width).toBe(160);
        expect(result.y).toBe(100);
        expect(result.height).toBe(200);
    });

    it('moves x left and grows width when dragged leftward (dx < 0)', () => {
        // rect: x=100, y=100, w=200, h=200; dx=-50; min default(160)
        // proposed = 200 - (-50) = 250; clamped = 250
        // x = 100 + (200 - 250) = 50; width = 250
        const result = resize(r(100, 100, 200, 200), 'w', -50, 0);
        expect(result.x).toBe(50);
        expect(result.width).toBe(250);
    });

    it('stops x moving once minimum width is reached (classic bug)', () => {
        // rect: x=0, y=0, w=120, h=120; dx=500; min={w:100,h:10}
        // proposed = 120-500 = -380; clamped = max(-380, 100) = 100
        // x = 0 + (120-100) = 20;  NOT 500
        const min = { width: 100, height: 10 };
        const result = resize(r(0, 0, 120, 120), 'w', 500, 0, min);
        expect(result.width).toBe(100);
        expect(result.x).toBe(20);   // stopped at min, did not walk to 500
    });
});

describe('resize – northeast corner', () => {
    // 'ne' = 'n' + 'e': width grows from east (no x change); y/height from north
    it('combines north and east behaviours', () => {
        // rect: x=50, y=50, w=200, h=200; dx=30, dy=20; min default
        // east: width = max(200+30, 160) = 230
        // north: proposed=200-20=180; clamped=180; y=50+(200-180)=70; height=180
        const result = resize(r(50, 50, 200, 200), 'ne', 30, 20);
        expect(result.width).toBe(230);
        expect(result.height).toBe(180);
        expect(result.x).toBe(50);   // east does not move x
        expect(result.y).toBe(70);   // north moves y
    });

    it('clamps north component at minimum', () => {
        const min = { width: 10, height: 100 };
        // rect: x=0, y=0, w=200, h=200; dy=500
        // north: proposed=200-500=-300; clamped=100; y=0+(200-100)=100
        const result = resize(r(0, 0, 200, 200), 'ne', 0, 500, min);
        expect(result.height).toBe(100);
        expect(result.y).toBe(100);
    });
});

describe('resize – southwest corner', () => {
    // 'sw' = 's' + 'w': height from south (no y change); x/width from west
    it('combines south and west behaviours', () => {
        // rect: x=100, y=100, w=200, h=200; dx=40, dy=30; min default
        // south: height = max(200+30, 80) = 230
        // west: proposed=200-40=160; clamped=max(160,160)=160; x=100+(200-160)=140; width=160
        const result = resize(r(100, 100, 200, 200), 'sw', 40, 30);
        expect(result.height).toBe(230);
        expect(result.y).toBe(100);   // south does not move y
        expect(result.width).toBe(160);
        expect(result.x).toBe(140);
    });

    it('clamps west component at minimum', () => {
        const min = { width: 100, height: 10 };
        // rect: x=0, y=0, w=120, h=120; dx=500
        // west: proposed=120-500=-380; clamped=100; x=0+(120-100)=20
        const result = resize(r(0, 0, 120, 120), 'sw', 500, 0, min);
        expect(result.width).toBe(100);
        expect(result.x).toBe(20);
    });
});

describe('resize – southeast corner', () => {
    // 'se' = 's' + 'e': only width and height grow; x and y never move
    it('changes only width and height, never the origin', () => {
        // rect: x=10, y=10, w=100, h=100; dx=20, dy=30; min tiny
        const min = { width: 10, height: 10 };
        const result = resize(r(10, 10, 100, 100), 'se', 20, 30, min);
        expect(result).toEqual(r(10, 10, 120, 130));
    });

    it('clamps both dimensions to minimum', () => {
        const min = { width: 50, height: 50 };
        const result = resize(r(0, 0, 60, 60), 'se', -100, -100, min);
        expect(result).toEqual(r(0, 0, 50, 50));
    });
});

describe('resize – northwest corner', () => {
    // 'nw' = 'n' + 'w': both x and y may move; both are clamped at minimum
    it('moves both x and y, shrinks both dimensions when dragging inward', () => {
        // rect: x=100, y=100, w=200, h=200; dx=20, dy=30; min tiny
        const min = { width: 10, height: 10 };
        // west: proposed=200-20=180; clamped=180; x=100+(200-180)=120; width=180
        // north: proposed=200-30=170; clamped=170; y=100+(200-170)=130; height=170
        const result = resize(r(100, 100, 200, 200), 'nw', 20, 30, min);
        expect(result).toEqual(r(120, 130, 180, 170));
    });

    it('stops both x and y once their respective minimums are reached', () => {
        const min = { width: 100, height: 80 };
        // rect: x=0, y=0, w=200, h=200; dx=500, dy=500
        // west: proposed=200-500=-300; clamped=100; x=0+(200-100)=100
        // north: proposed=200-500=-300; clamped=80; y=0+(200-80)=120
        const result = resize(r(0, 0, 200, 200), 'nw', 500, 500, min);
        expect(result.width).toBe(100);
        expect(result.x).toBe(100);
        expect(result.height).toBe(80);
        expect(result.y).toBe(120);
    });
});

// ---------------------------------------------------------------------------
// constrainToViewport
// ---------------------------------------------------------------------------

describe('constrainToViewport', () => {
    const viewport: Size = { width: 1000, height: 800 };
    const edgeMargin = 32; // default

    it('does not modify a window fully inside the viewport', () => {
        // x=100, width=300: edgeMargin-300=-268 ≤ 100 ≤ 1000-32=968 ✓
        // y=100: 0 ≤ 100 ≤ 800-32=768 ✓
        const rect = r(100, 100, 300, 200);
        expect(constrainToViewport(rect, viewport)).toEqual(rect);
    });

    it('clamps x when window is too far right', () => {
        // x=5000, width=300: max allowed x = 1000-32 = 968
        const result = constrainToViewport(r(5000, 100, 300, 200), viewport);
        expect(result.x).toBe(1000 - 32);
    });

    it('clamps x when window is too far left (keeps edgeMargin strip visible)', () => {
        // x=-5000, width=300: min allowed x = 32-300 = -268
        const result = constrainToViewport(r(-5000, 100, 300, 200), viewport);
        expect(result.x).toBe(edgeMargin - 300); // = -268
    });

    it('clamps y to 0 when window is above the top', () => {
        const result = constrainToViewport(r(100, -200, 300, 200), viewport);
        expect(result.y).toBe(0);
    });

    it('clamps y when window is below the bottom', () => {
        // y=5000: max allowed y = 800-32 = 768
        const result = constrainToViewport(r(100, 5000, 300, 200), viewport);
        expect(result.y).toBe(800 - 32);
    });

    it('does not change width or height', () => {
        const result = constrainToViewport(r(5000, 5000, 300, 200), viewport);
        expect(result.width).toBe(300);
        expect(result.height).toBe(200);
    });

    it('respects a custom edgeMargin', () => {
        // edgeMargin=100; window at x=950, width=200:
        // max x = 1000-100 = 900  → clamped to 900
        const result = constrainToViewport(r(950, 100, 200, 150), viewport, 100);
        expect(result.x).toBe(1000 - 100);
    });

    it('clamps left correctly with custom edgeMargin', () => {
        // edgeMargin=100; window at x=-5000, width=200:
        // min x = 100-200 = -100  → clamped to -100
        const result = constrainToViewport(r(-5000, 100, 200, 150), viewport, 100);
        expect(result.x).toBe(100 - 200); // = -100
    });

    it('clamps bottom correctly with custom edgeMargin', () => {
        // edgeMargin=100; max y = 800-100 = 700
        const result = constrainToViewport(r(100, 5000, 200, 150), viewport, 100);
        expect(result.y).toBe(800 - 100);
    });
});

// ---------------------------------------------------------------------------
// maximize
// ---------------------------------------------------------------------------

describe('maximize', () => {
    it('returns a rect at 0,0 that fills the viewport exactly', () => {
        const viewport: Size = { width: 800, height: 600 };
        expect(maximize(viewport)).toEqual(r(0, 0, 800, 600));
    });

    it('works with non-standard viewport sizes', () => {
        expect(maximize({ width: 1920, height: 1080 })).toEqual(r(0, 0, 1920, 1080));
    });
});

// ---------------------------------------------------------------------------
// cascade
// ---------------------------------------------------------------------------

describe('cascade', () => {
    // viewport={1000,800}, size={400,300}
    // spread = Math.max(28, Math.floor(Math.min((1000-80-400)/8, (800-80-300)/8)))
    //        = Math.max(28, Math.floor(Math.min(65, 52.5)))
    //        = Math.max(28, Math.floor(52.5))
    //        = Math.max(28, 52) = 52
    const viewport: Size = { width: 1000, height: 800 };
    const size: Size = { width: 400, height: 300 };

    it('index 0 and index 1 produce different positions', () => {
        const c0 = cascade(0, size, viewport);
        const c1 = cascade(1, size, viewport);
        expect(c0).not.toEqual(c1);
    });

    it('index 8 wraps to the same position as index 0 (index % 8)', () => {
        // Both should go through the same computation
        const c0 = cascade(0, size, viewport);
        const c8 = cascade(8, size, viewport);
        expect(c8).toEqual(c0);
    });

    it('index 0: x and y start at margin (40) with offset 0, then constrained', () => {
        // offset=0 → raw {x:40, y:40}
        // constrainToViewport with edgeMargin=32:
        //   x = clamp(40, 32-400, 1000-32) = 40 ✓
        //   y = clamp(40, 0, 768) = 40 ✓
        const c0 = cascade(0, size, viewport);
        expect(c0.x).toBe(40);
        expect(c0.y).toBe(40);
        expect(c0.width).toBe(400);
        expect(c0.height).toBe(300);
    });

    it('index 1: offset by spread (52) from index 0', () => {
        // offset = 1*52 = 52 → raw {x:92, y:92}
        // constrained: 92 is within [−368, 968] and [0, 768] ✓
        const c1 = cascade(1, size, viewport);
        const c0 = cascade(0, size, viewport);
        expect(c1.x).toBe(c0.x + 52);
        expect(c1.y).toBe(c0.y + 52);
    });

    it('result is constrained to the viewport (width+height unchanged, x/y in range)', () => {
        for (let i = 0; i < 8; i++) {
            const c = cascade(i, size, viewport);
            expect(c.width).toBe(size.width);
            expect(c.height).toBe(size.height);
            // x must be in [edgeMargin - width, viewport.width - edgeMargin]
            expect(c.x).toBeGreaterThanOrEqual(32 - 400);
            expect(c.x).toBeLessThanOrEqual(1000 - 32);
            // y must be in [0, viewport.height - edgeMargin]
            expect(c.y).toBeGreaterThanOrEqual(0);
            expect(c.y).toBeLessThanOrEqual(800 - 32);
        }
    });

    it('uses a larger spread in a larger viewport (proportional spacing)', () => {
        // Small viewport: spread forced to default 28
        const smallVP: Size = { width: 360, height: 460 };
        const smallSize: Size = { width: 300, height: 400 };
        // spread = Math.max(28, Math.floor(Math.min((360-80-300)/8, (460-80-400)/8)))
        //        = Math.max(28, Math.floor(Math.min(-2.5, -2.5)))
        //        = Math.max(28, -3) = 28
        const s0 = cascade(0, smallSize, smallVP);
        const s1 = cascade(1, smallSize, smallVP);
        expect(s1.x - s0.x).toBe(28);

        // Large viewport: spread grows beyond 28
        const largeVP: Size = { width: 1400, height: 950 };
        const largeSize: Size = { width: 320, height: 420 };
        // spread = Math.max(28, Math.floor(Math.min((1400-80-320)/8, (950-80-420)/8)))
        //        = Math.max(28, Math.floor(Math.min(125, 56.25)))
        //        = Math.max(28, 56) = 56
        const l0 = cascade(0, largeSize, largeVP);
        const l1 = cascade(1, largeSize, largeVP);
        expect(l1.x - l0.x).toBeGreaterThan(28);
    });

    it('spreads across the room: index 5 on a large viewport is far from the corner', () => {
        // Regression: six windows on 1400x950 must not all pile in the top-left 180px
        const sixth = cascade(5, { width: 320, height: 420 }, { width: 1400, height: 950 });
        expect(sixth.x).toBeGreaterThan(300);
    });
});

// ---------------------------------------------------------------------------
// raise
// ---------------------------------------------------------------------------

describe('raise', () => {
    it('brings an id in the middle to the end, preserving relative order of others', () => {
        expect(raise(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a']);
        expect(raise(['a', 'b', 'c'], 'b')).toEqual(['a', 'c', 'b']);
    });

    it('keeps an id already at the end there (order is unchanged)', () => {
        expect(raise(['a', 'b', 'c'], 'c')).toEqual(['a', 'b', 'c']);
    });

    it('appends an id not present in the array', () => {
        expect(raise(['a', 'b'], 'd')).toEqual(['a', 'b', 'd']);
    });

    it('returns [id] for an empty array', () => {
        expect(raise([], 'x')).toEqual(['x']);
    });

    it('does not mutate the original array', () => {
        const original = ['a', 'b', 'c'];
        const snapshot = [...original];
        raise(original, 'a');
        expect(original).toEqual(snapshot);
    });

    it('handles a single-element array where the element is the raised id', () => {
        expect(raise(['only'], 'only')).toEqual(['only']);
    });

    it('removes duplicate occurrences of the id (keeps last)', () => {
        // If 'a' somehow appeared twice, filter removes both and appends once.
        // (Defensive: the real app should never have duplicates, but the function handles it.)
        expect(raise(['a', 'b', 'a'], 'a')).toEqual(['b', 'a']);
    });
});
