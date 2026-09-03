/**
 * Window geometry: pure functions over rectangles.
 *
 * spec/README.md section 4. The window manager owns position, size, z-order, mode and
 * minimised/maximised; the Application owns scroll, forms and connections. A mode switch, a move or
 * a resize touches only the first, which is what makes switching dynamic with no remount.
 *
 * Everything here is a pure function so it can be tested without a DOM — and it is the part most
 * likely to be subtly wrong, because "resize from the top-left edge" is four sign errors waiting to
 * happen (spec/testing.md section 2).
 */

export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export interface Size {
    readonly width: number;
    readonly height: number;
}

export type WindowState = 'normal' | 'minimized' | 'maximized';

/** Which edges a drag moves. `move` is all four at once. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const DEFAULT_MIN: Size = { width: 160, height: 80 };

export function clampSize(rect: Rect, min: Size = DEFAULT_MIN): Rect {
    return {
        x: rect.x,
        y: rect.y,
        width: Math.max(rect.width, min.width),
        height: Math.max(rect.height, min.height),
    };
}

export function move(rect: Rect, dx: number, dy: number): Rect {
    return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

/**
 * Resize by dragging an edge.
 *
 * The north and west edges move the origin as well as the size, and they must stop moving it once
 * the minimum is reached — otherwise dragging past the minimum walks the window across the screen,
 * which is the classic version of this bug.
 */
export function resize(rect: Rect, edge: ResizeEdge, dx: number, dy: number, min: Size = DEFAULT_MIN): Rect {
    let { x, y, width, height } = rect;

    if (edge.includes('e')) {
        width = Math.max(width + dx, min.width);
    }
    if (edge.includes('s')) {
        height = Math.max(height + dy, min.height);
    }
    if (edge.includes('w')) {
        const proposed = width - dx;
        const clamped = Math.max(proposed, min.width);
        x += width - clamped;
        width = clamped;
    }
    if (edge.includes('n')) {
        const proposed = height - dy;
        const clamped = Math.max(proposed, min.height);
        y += height - clamped;
        height = clamped;
    }

    return { x, y, width, height };
}

/** Keep a window reachable: never let its title bar go above or entirely outside the viewport. */
export function constrainToViewport(rect: Rect, viewport: Size, edgeMargin = 32): Rect {
    return {
        ...rect,
        x: Math.min(Math.max(rect.x, edgeMargin - rect.width), viewport.width - edgeMargin),
        y: Math.min(Math.max(rect.y, 0), viewport.height - edgeMargin),
    };
}

export function maximize(viewport: Size): Rect {
    return { x: 0, y: 0, width: viewport.width, height: viewport.height };
}

/**
 * Where a new window goes when nothing said.
 *
 * Cascading rather than centring, because centring every window puts them all in one place and the
 * second one hides the first.
 */
export function cascade(index: number, size: Size, viewport: Size, step = 28): Rect {
    const offset = (index % 8) * step;
    return constrainToViewport(
        { x: 40 + offset, y: 40 + offset, width: size.width, height: size.height },
        viewport,
    );
}

/** Bring one window to the front, keeping everything else's relative order. */
export function raise(order: readonly string[], id: string): readonly string[] {
    const without = order.filter((entry) => entry !== id);
    return [...without, id];
}
