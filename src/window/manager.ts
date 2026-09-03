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

export interface WindowRecord {
    readonly id: string;
    /** The pid that opened it. Ownership, so disposal needs no bookkeeping from the caller. */
    readonly owner: string;
    readonly view: string;
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

    #next = 0;
    #opened = 0;

    constructor(viewport: Size = { width: 1280, height: 800 }) {
        this.windows = signal<readonly WindowRecord[]>([]);
        this.order = signal<readonly string[]>([]);
        this.focused = signal<string | undefined>(undefined);
        this.viewport = signal(viewport);
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

    close(id: string): void {
        const record = this.get(id);
        if (record === undefined) return;

        this.windows.set(this.windows().filter((w) => w.id !== id));
        this.order.set(this.order().filter((entry) => entry !== id));

        if (this.focused() === id) {
            const remaining = this.order();
            this.focused.set(remaining[remaining.length - 1]);
        }
    }

    /** Everything one process owns. Called when it stops — the kernel cleans up, not the caller. */
    closeOwnedBy(owner: string): void {
        for (const record of this.windows().filter((w) => w.owner === owner)) {
            this.close(record.id);
        }
    }

    focus(id: string): void {
        if (this.get(id) === undefined) return;
        this.order.set(raise(this.order(), id));
        this.focused.set(id);
    }

    move(id: string, dx: number, dy: number): void {
        this.#update(id, (record) => {
            // A maximised window is not draggable; dragging one should restore it first, which is a
            // decision for the chrome Extension rather than something to guess at here.
            if (record.state !== 'normal') return record.rect;
            return constrainToViewport(move(record.rect, dx, dy), this.viewport());
        });
    }

    resize(id: string, edge: ResizeEdge, dx: number, dy: number): void {
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
     */
    setViewport(size: Size): void {
        this.viewport.set(size);
        this.windows.set(
            this.windows().map((w) =>
                w.state === 'maximized'
                    ? { ...w, rect: maximize(size) }
                    : { ...w, rect: constrainToViewport(w.rect, size) },
            ),
        );
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
