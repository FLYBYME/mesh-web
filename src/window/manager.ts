/**
 * The window manager.
 *
 * Kernel, not an Extension — geometry, z-order and the mechanics of moving and resizing
 * (spec/kernel.md section 2). An Application never moves, resizes, stacks or closes its own window;
 * it declares view defaults as *preferences* and may observe its size, and that is all
 * (spec/input.md section 6).
 *
 * This file holds the model. How a window is *drawn* — title bar, shadow, the affordance on a
 * resize edge — is an Extension, which is what lets a blog and an IDE look nothing alike over
 * identical mechanics. What is here is what must be identical.
 */

import { signal } from '../reactivity/index.js';
import type { Signal } from '../reactivity/types.js';
import type { Json } from '../description/types.js';
import {
    cascade, clampSize, constrainToViewport, DEFAULT_MIN, maximize, move, raise, resize,
    type Rect, type ResizeEdge, type Size, type WindowState,
} from './geometry.js';
import { tileNames, tileRects, type LayoutNode } from './layout.js';

/** Windowed, tiled, or single. The same views serve all three (spec/application.md §6). */
export type WindowMode = 'windowed' | 'tiled' | 'single';

/** Space between panes in tiled mode. */
export const TILE_GAP = 1;

export interface WindowRecord {
    readonly id: string;
    /** The pid that opened it. Ownership, so disposal needs no bookkeeping from the caller. */
    readonly owner: string;
    readonly view: string;
    /**
     * The tile this window's view targets, from its declaration.
     *
     * Carried on the record rather than looked up, because the manager must not know what a view
     * is — it is handed the tile name at open time, exactly as it is handed the default size.
     * Undefined for a view that declared none: perfectly fine windowed, and not showable tiled.
     */
    readonly tile: string | undefined;
    readonly params: Readonly<Record<string, Json>>;
    readonly minSize: Size;
    title: string;
    rect: Rect;
    /** Where it was before being maximised, so restore puts it back. */
    restoreRect: Rect | undefined;
    state: WindowState;
    closable: boolean;
}

export interface OpenOptions {
    readonly owner: string;
    readonly view: string;
    /** The tile the view declared, if any. */
    readonly tile?: string;
    readonly title?: string;
    readonly params?: Readonly<Record<string, Json>>;
    readonly size?: Partial<Size>;
    readonly minSize?: Size;
    readonly closable?: boolean;
}

const DEFAULT_SIZE: Size = { width: 480, height: 320 };

export class WindowManager {
    readonly windows: Signal<readonly WindowRecord[]>;
    /** Back to front. The last entry is on top. */
    readonly order: Signal<readonly string[]>;
    readonly focused: Signal<string | undefined>;
    readonly viewport: Signal<Size>;

    /**
     * Windowed or tiled.
     *
     * The same views serve both (spec/application.md §6). In windowed mode geometry is whatever the
     * user dragged; in tiled mode it comes from the layout and the drag handles are not offered.
     * **A window's `rect` is not overwritten when the mode changes** — that is what lets a switch
     * back put every window exactly where it was, and it is why `rect` means "where the user put
     * this" rather than "where this is".
     */
    readonly mode: Signal<WindowMode>;

    /** The Application's declared split tree. Consulted only in tiled mode. */
    readonly layout: Signal<LayoutNode | undefined>;

    #next = 0;
    #opened = 0;

    constructor(viewport: Size = { width: 1280, height: 800 }) {
        this.windows = signal<readonly WindowRecord[]>([]);
        this.order = signal<readonly string[]>([]);
        this.focused = signal<string | undefined>(undefined);
        this.viewport = signal(viewport);
        this.mode = signal<WindowMode>('windowed');
        this.layout = signal<LayoutNode | undefined>(undefined);
    }

    /**
     * Where a window actually is, right now.
     *
     * The one function a shell should paint from. In windowed mode it is the record's own rect; in
     * tiled mode it is the rect of the tile its view targets, and the record's rect is left alone
     * so switching back restores it.
     *
     * In single mode, the manager does not position anything: the view mounts into ordinary
     * document flow, so rectOf() has no meaningful answer and returns undefined.
     */
    rectOf(id: string): Rect | undefined {
        const record = this.get(id);
        if (record === undefined) return undefined;
        if (this.mode() === 'single') return undefined;
        if (this.mode() === 'windowed') return record.rect;

        const layout = this.layout();
        if (layout === undefined || record.tile === undefined) return undefined;
        return tileRects(layout, this.viewport(), { gap: TILE_GAP }).get(record.tile);
    }

    /**
     * Which windows are on screen in the current mode, back to front.
     *
     * In single mode, exactly one view is shown — the most recently focused non-minimized window.
     * The others are not closed and not disposed; they are simply not shown, and reported by hidden().
     *
     * In tiled mode a tile holds **one** view at a time — several views may target one tile over an
     * Application's life, and this is where "the window manager decides which occupies it now" is
     * decided: the most recently focused. The others are not closed and not disposed; they are
     * simply not shown, which is the whole point of the mode being a *view* concern.
     */
    visible(): readonly WindowRecord[] {
        const stacked = this.stacked();
        if (this.mode() === 'single') {
            const active = stacked.filter((w) => w.state !== 'minimized').at(-1);
            return active === undefined ? [] : [active];
        }
        if (this.mode() === 'windowed') return stacked.filter((w) => w.state !== 'minimized');

        /**
         * **No layout means no tiling to do, not nothing to show.**
         *
         * This returned `[]`, which was defensible while nothing could reach tiled mode: a site that
         * deliberately pinned `window-manager/mode: tiled` would also have declared a layout. Then
         * `alt+t` made the mode reachable from the keyboard on any site, and pressing it on a
         * composition whose Applications declare no `layout` blanked the screen — ten windows to
         * zero, with no error and no way to tell what had happened.
         *
         * A mode switch that can empty the page is worse than one that does nothing, so an absent
         * layout falls back to showing what windowed mode would. The mode is still *set*, so an
         * Application that declares a layout later tiles immediately.
         */
        const layout = this.layout();
        if (layout === undefined) return stacked.filter((w) => w.state !== 'minimized');

        const available = new Set(tileNames(layout));
        const occupant = new Map<string, WindowRecord>();

        // `stacked` is back to front, so the later entry wins — which is the more recently focused.
        for (const record of stacked) {
            if (record.tile === undefined || !available.has(record.tile)) continue;
            occupant.set(record.tile, record);
        }

        return stacked.filter((w) => occupant.get(w.tile ?? '') === w);
    }

    /** Windows the current mode cannot show. Not an error — something a shell may want to offer. */
    hidden(): readonly WindowRecord[] {
        const shown = new Set(this.visible().map((w) => w.id));
        return this.windows().filter((w) => !shown.has(w.id));
    }

    setMode(mode: WindowMode): void {
        this.mode.set(mode);
    }

    setLayout(layout: LayoutNode | undefined): void {
        this.layout.set(layout);
    }

    get(id: string): WindowRecord | undefined {
        return this.windows().find((w) => w.id === id);
    }

    /** Back-to-front, which is the order a renderer should paint in. */
    stacked(): readonly WindowRecord[] {
        const byId = new Map(this.windows().map((w) => [w.id, w]));
        return this.order()
            .map((id) => byId.get(id))
            .filter((w): w is WindowRecord => w !== undefined);
    }

    zIndexOf(id: string): number {
        return this.order().indexOf(id);
    }

    open(options: OpenOptions): WindowRecord {
        const id = `w${++this.#next}`;
        const min = options.minSize ?? DEFAULT_MIN;

        const size: Size = {
            width: options.size?.width ?? DEFAULT_SIZE.width,
            height: options.size?.height ?? DEFAULT_SIZE.height,
        };

        const record: WindowRecord = {
            id,
            owner: options.owner,
            view: options.view,
            tile: options.tile,
            params: options.params ?? {},
            minSize: min,
            title: options.title ?? options.view,
            rect: clampSize(cascade(this.#opened++, size, this.viewport()), min),
            restoreRect: undefined,
            state: 'normal',
            closable: options.closable ?? true,
        };

        this.windows.set([...this.windows(), record]);
        this.order.set([...this.order(), id]);
        this.focused.set(id);

        return record;
    }

    /**
     * Close a window, unless its view said it may not be.
     *
     * `closable` was stored, handed to chrome, and enforced nowhere — so it was a hint about which
     * affordance to draw and nothing more, and any chrome could close a window the Application had
     * declared permanent by simply asking. A flag that only well-behaved callers respect is not a
     * flag. Found by the first test that asked chrome to do it (roadmap A6.3).
     */
    close(id: string): void {
        const record = this.get(id);
        if (record === undefined || !record.closable) return;
        this.#remove(id);
    }

    /**
     * Everything one process owns. Called when it stops — the kernel cleans up, not the caller.
     *
     * This ignores `closable`, and must: the flag means *the user may not dismiss this*, not *this
     * window outlives its Application*. A window whose process is gone has nothing behind it, and
     * leaving one on screen would be a worse outcome than the one the flag guards against.
     */
    closeOwnedBy(owner: string): void {
        for (const record of this.windows().filter((w) => w.owner === owner)) {
            this.#remove(record.id);
        }
    }

    #remove(id: string): void {
        this.windows.set(this.windows().filter((w) => w.id !== id));
        this.order.set(this.order().filter((entry) => entry !== id));

        if (this.focused() === id) {
            const remaining = this.order();
            this.focused.set(remaining[remaining.length - 1]);
        }
    }

    focus(id: string): void {
        if (this.get(id) === undefined) return;
        this.order.set(raise(this.order(), id));
        this.focused.set(id);
    }

    move(id: string, dx: number, dy: number): void {
        if (this.mode() === 'single') return;
        this.#update(id, (record) => {
            // A maximised window is not draggable; dragging one should restore it first, which is a
            // decision for the chrome Extension rather than something to guess at here.
            if (record.state !== 'normal') return record.rect;
            return constrainToViewport(move(record.rect, dx, dy), this.viewport());
        });
    }

    resize(id: string, edge: ResizeEdge, dx: number, dy: number): void {
        if (this.mode() === 'single') return;
        this.#update(id, (record) => {
            if (record.state !== 'normal') return record.rect;
            return resize(record.rect, edge, dx, dy, record.minSize);
        });
    }

    maximize(id: string): void {
        const record = this.get(id);
        if (record === undefined || record.state === 'maximized') return;

        this.#replace(id, (w) => ({
            ...w,
            restoreRect: w.state === 'normal' ? w.rect : w.restoreRect,
            rect: maximize(this.viewport()),
            state: 'maximized',
        }));
    }

    minimize(id: string): void {
        this.#replace(id, (w) => ({
            ...w,
            restoreRect: w.state === 'normal' ? w.rect : w.restoreRect,
            state: 'minimized',
        }));

        if (this.focused() === id) {
            const visible = this.order().filter((entry) => this.get(entry)?.state !== 'minimized');
            this.focused.set(visible[visible.length - 1]);
        }
    }

    restore(id: string): void {
        this.#replace(id, (w) => ({
            ...w,
            rect: w.restoreRect ?? w.rect,
            restoreRect: undefined,
            state: 'normal',
        }));
    }

    setTitle(id: string, title: string): void {
        this.#replace(id, (w) => ({ ...w, title }));
    }

    /**
     * The viewport changed.
     *
     * Maximised windows follow it; normal ones are pulled back into reach rather than resized,
     * because a user's chosen size is theirs and a narrower screen is not a request to change it.
     *
     * In single mode, geometry is preserved untouched so entering and leaving single is lossless.
     */
    setViewport(size: Size): void {
        this.viewport.set(size);
        if (this.mode() === 'single') return;
        this.windows.set(
            this.windows().map((w) =>
                w.state === 'maximized'
                    ? { ...w, rect: maximize(size) }
                    : { ...w, rect: constrainToViewport(w.rect, size) },
            ),
        );
    }

    /**
     * Put a window exactly here.
     *
     * Everything else moves a window *relatively* — `move` takes deltas because a drag reports
     * deltas — and restoring saved geometry is the one case with an absolute answer already in
     * hand. Doing it as a delta from wherever the cascade happened to place the window would be
     * arithmetic standing in for an assignment, and wrong the moment the viewport differs from the
     * one that saved it.
     *
     * Still clamped to the viewport: a window restored from a larger monitor must not come back
     * off-screen, which is the failure this whole feature is judged by.
     */
    place(id: string, rect: Rect): void {
        this.#update(id, (record) => constrainToViewport(
            clampSize(rect, record.minSize ?? DEFAULT_MIN),
            this.viewport(),
        ));
    }

    #update(id: string, next: (record: WindowRecord) => Rect): void {
        this.#replace(id, (w) => ({ ...w, rect: next(w) }));
    }

    #replace(id: string, next: (record: WindowRecord) => WindowRecord): void {
        const current = this.windows();
        const index = current.findIndex((w) => w.id === id);
        if (index === -1) return;

        const updated = [...current];
        updated[index] = next(current[index]!);
        this.windows.set(updated);
    }
}
