/**
 * The layout: a split tree whose named nodes are tiles.
 *
 * spec/application.md §6, decided. **A tile is a slot; a view fills it.** The Application declares
 * the tree — `header`, `sidebar`, `content`, `footer` — and each view declares which tile it
 * targets. Several views may target one tile over the Application's life (`post` and `editor` both
 * target `content`), and the window manager decides which occupies it now.
 *
 * Pure functions over plain data, deliberately. Geometry is the thing most likely to be subtly wrong
 * — a fraction that does not add up, a fixed pane that eats a flexible one, a border counted twice —
 * and all of it is answerable without a DOM. What is left for the browser is whether the boxes those
 * numbers describe actually appear, which is a much smaller question.
 *
 * **In windowed mode tile names are simply unused.** Same views, two geometries; nothing here is
 * consulted when a window is where the user dragged it.
 */

import type { Rect, Size } from './geometry.js';

/** A named slot. The leaf of the tree, and the thing a view targets. */
export interface TileNode {
    readonly tile: string;
}

/** A division of space. `row` places children left to right; `column`, top to bottom. */
export interface SplitNode {
    readonly split: 'row' | 'column';
    readonly children: readonly LayoutChild[];
}

export type LayoutNode = TileNode | SplitNode;

export interface LayoutChild {
    readonly node: LayoutNode;
    /**
     * How much of the parent's main axis this child takes.
     *
     * A number is a **fraction** of what remains after fixed sizes are taken, relative to its
     * siblings' fractions — so `1` and `3` is a quarter and three quarters, and adding a third
     * child at `1` re-divides without anyone editing the others. `{ px }` is a fixed size, for the
     * thing that genuinely has one: a 40px header does not want to be 6% of a phone.
     *
     * Absent means `1`.
     */
    readonly size?: number | { readonly px: number };
}

export const isTile = (node: LayoutNode): node is TileNode =>
    typeof (node as TileNode).tile === 'string';

/**
 * Declare a layout.
 *
 * Exists so an Application writes `tiles({ ... })` rather than a bare object literal — the call site
 * reads as a declaration, and the return type is checked at the point of writing rather than
 * wherever it is eventually consumed.
 */
export function tiles(root: LayoutNode): LayoutNode {
    const seen = new Set<string>();

    const walk = (node: LayoutNode, path: string): void => {
        if (isTile(node)) {
            if (node.tile.trim() === '') throw new Error(`Layout has an unnamed tile at ${path}.`);
            if (seen.has(node.tile)) {
                throw new Error(
                    `Layout names the tile "${node.tile}" twice. A tile is an address, and two ` +
                    `places with one address means a view targeting it lands somewhere by accident.`,
                );
            }
            seen.add(node.tile);
            return;
        }

        if (node.children.length === 0) {
            throw new Error(`Layout has an empty ${node.split} at ${path}.`);
        }

        node.children.forEach((child, i) => walk(child.node, `${path}/${node.split}[${String(i)}]`));
    };

    walk(root, '');
    return root;
}

/** Every tile name in a layout, in the order they appear. */
export function tileNames(root: LayoutNode): readonly string[] {
    if (isTile(root)) return [root.tile];
    return root.children.flatMap((child) => tileNames(child.node));
}

export interface TileOptions {
    /** Space between panes. Applied *between* children, never around the outside. */
    readonly gap?: number;
}

/**
 * Where each tile is, given a viewport.
 *
 * Fixed sizes are taken first, then what remains is divided among the fractional children. That
 * order is the whole of it: doing it the other way makes a fixed 40px header shrink on a small
 * screen, which is the one thing a fixed size was asked for to prevent.
 *
 * A pane never gets a negative size — when fixed children ask for more than there is, they are
 * scaled down together rather than the last one being pushed off the edge. That case is a layout
 * mistake, and the useful behaviour is that everything is visible and obviously cramped rather than
 * something being silently absent.
 */
export function tileRects(
    root: LayoutNode,
    viewport: Size,
    options: TileOptions = {},
): ReadonlyMap<string, Rect> {
    const rects = new Map<string, Rect>();
    place(root, { x: 0, y: 0, width: viewport.width, height: viewport.height }, options.gap ?? 0, rects);
    return rects;
}

function place(node: LayoutNode, rect: Rect, gap: number, into: Map<string, Rect>): void {
    if (isTile(node)) {
        into.set(node.tile, rect);
        return;
    }

    const horizontal = node.split === 'row';
    const total = horizontal ? rect.width : rect.height;
    const between = gap * Math.max(0, node.children.length - 1);
    const available = Math.max(0, total - between);

    const fixed = node.children.map((c) =>
        typeof c.size === 'object' ? Math.max(0, c.size.px) : undefined);

    const fixedTotal = fixed.reduce<number>((sum, px) => sum + (px ?? 0), 0);

    // Fixed children asking for more than exists: scale them together. Everything stays visible.
    const scale = fixedTotal > available && fixedTotal > 0 ? available / fixedTotal : 1;

    const flexibleTotal = Math.max(0, available - fixedTotal * scale);
    const weights = node.children.map((c, i) =>
        fixed[i] !== undefined ? 0 : (typeof c.size === 'number' ? Math.max(0, c.size) : 1));
    const weightSum = weights.reduce((a, b) => a + b, 0);

    let offset = horizontal ? rect.x : rect.y;

    node.children.forEach((child, i) => {
        const px = fixed[i] !== undefined
            ? fixed[i]! * scale
            : weightSum === 0 ? 0 : (flexibleTotal * weights[i]!) / weightSum;

        const childRect: Rect = horizontal
            ? { x: offset, y: rect.y, width: px, height: rect.height }
            : { x: rect.x, y: offset, width: rect.width, height: px };

        place(child.node, childRect, gap, into);
        offset += px + gap;
    });
}
