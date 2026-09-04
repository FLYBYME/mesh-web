/**
 * The window layer — roadmap A6.3e.
 *
 * The thing that puts windows on a screen. Until now the framework tracked windows and rendered
 * none of them: `WindowManager` held the geometry and 900 lines of `browser/harness.ts` did the
 * painting, which meant **the only shell was in the demo**. A framework whose only shell lives in
 * its own demo has not shipped a shell, and A6.3 could not be answered — the workbench is supposed
 * to be an Extension *over the window manager*, and there was nothing to be over.
 *
 * ## What is here and what is not
 *
 * [kernel §2](../../spec/kernel.md) draws the line and this module is built on it:
 *
 * > Moving, resizing and stacking are kernel, not a decoration Extension … What remains an Extension
 * > is how a window is *drawn* — title bar, shadow, the visual affordance on a resize edge.
 *
 * So the kernel half is here: one host element per window, positioned from the manager, stacked by
 * z-index, shown or hidden by mode, with the view mounted inside it once and disposed when the
 * window goes. **Reposition, never re-parent** — moving a node between parents resets its scroll,
 * which would silently break the one property a mode switch exists for.
 *
 * The drawn half is a `FrameChrome`: a function that builds the title bar, the buttons and the
 * resize grip, and tells this module which elements drag what. `defaultFrame` below is one, shipped
 * so a site gets a working window without writing one — and replaceable, which is the seam A6.3d's
 * chrome Extension plugs into. A broken chrome can therefore make a window look wrong; it cannot
 * make one unmovable, unstackable or immortal, because none of that is its to do.
 */

import type { Json } from '../description/types.js';
import type { Action } from '../description/types.js';
import type { ViewDecl } from '../contribution/contract.js';
import { effect } from '../reactivity/index.js';
import type { RenderOptions } from '../render/dom.js';
import { mountView, type ViewInstance } from './host.js';
import type { WindowManager, WindowRecord } from './manager.js';

// ---------------------------------------------------------------------------- the drawn half

/**
 * What chrome hands back for one window.
 *
 * `content` is where the view is mounted, and it is the only element this module writes into.
 * `drags` say which elements report which gesture — a *report*, not an assignment: the handler
 * receives deltas and the manager decides what they mean, applies the view's minimum size and
 * clamps to the viewport.
 */
export interface Frame {
    readonly root: HTMLElement;
    readonly content: HTMLElement;
    /** Called on every paint, so chrome can retitle, restyle, or show a focus ring. */
    update?(record: WindowRecord, state: FrameState): void;
    dispose?(): void;
}

export interface FrameState {
    readonly focused: boolean;
    readonly tiled: boolean;
}

export interface FrameContext {
    readonly id: string;
    /** Report a drag on this element as deltas. Pointer capture is handled here. */
    drag(handle: HTMLElement, onMove: (dx: number, dy: number) => void): void;
    readonly manager: WindowManager;
}

export type FrameChrome = (cx: FrameContext) => Frame;

// ---------------------------------------------------------------------------- the kernel half

export interface ShellOptions {
    readonly manager: WindowManager;
    /** The view declaration for a window. From the kernel, which knows every manifest. */
    viewOf(owner: string, view: string): ViewDecl<never, never> | undefined;
    /** What that window's process provides to its views. */
    apiOf(owner: string): unknown;
    readonly render: RenderOptions;
    readonly onCommand: (action: Action) => void;
    /**
     * How **one window** is drawn. `defaultFrame` when a site has not said.
     *
     * Not to be confused with the page chrome in `page.ts`, which is the frame *around* the windows.
     * Two different things, and naming them both "chrome" was a mistake worth undoing early.
     */
    readonly frame?: FrameChrome;
    /** Told when a window is framed or dropped, so a site can log it. */
    readonly onWindow?: (event: 'opened' | 'closed', id: string) => void;
}

export interface Shell {
    /** The host element for a window, so a test can find one without reading the DOM by class. */
    hostOf(id: string): HTMLElement | undefined;
    dispose(): void;
}

/**
 * Paint, driven by the manager's own signals.
 *
 * There is no `paint()` call anywhere: `windows`, `order`, `focused` and `mode` are signals, so
 * moving a window re-runs this effect and nothing else. **The view inside the window is untouched
 * by it** — geometry is the shell's, application state is the Application's, and they do not share
 * a render pass.
 */
export function mountShell(root: Element, options: ShellOptions): Shell {
    const manager = options.manager;
    const frame = options.frame ?? defaultFrame;
    const announce = options.onWindow ?? (() => {});

    interface Mounted {
        readonly frame: Frame;
        readonly instance: ViewInstance;
    }

    const mounted = new Map<string, Mounted>();

    const build = (record: WindowRecord): Mounted | undefined => {
        const decl = options.viewOf(record.owner, record.view);
        if (decl === undefined) {
            // The manager refuses an undeclared view at `open`, so reaching here means the process
            // went away between opening and painting. Skipped rather than thrown: a shell that
            // throws mid-paint takes every other window down with it.
            return undefined;
        }

        const built = frame({ id: record.id, drag, manager });

        built.root.addEventListener('pointerdown', () => { manager.focus(record.id); }, true);
        root.appendChild(built.root);

        const instance = mountView(built.content, {
            windowId: record.id,
            decl,
            api: options.apiOf(record.owner),
            params: record.params,
            windows: manager,
            render: options.render,
            onCommand: options.onCommand,
        });

        return { frame: built, instance };
    };

    const stop = effect(() => {
        const stacked = manager.stacked();
        const live = new Set(stacked.map((r) => r.id));
        const visible = new Set(manager.visible().map((r) => r.id));
        const tiled = manager.mode() === 'tiled';
        const focused = manager.focused();

        for (const record of stacked) {
            let entry = mounted.get(record.id);
            if (entry === undefined) {
                const built = build(record);
                if (built === undefined) continue;
                entry = built;
                mounted.set(record.id, entry);
                announce('opened', record.id);
            }

            const host = entry.frame.root;

            // `rectOf`, not `record.rect`: in tiled mode a window's box comes from the tile its view
            // targets, and the record's own rect is left alone so switching back restores it.
            const rect = manager.rectOf(record.id);
            if (rect !== undefined) {
                host.style.left = `${String(rect.x)}px`;
                host.style.top = `${String(rect.y)}px`;
                host.style.width = `${String(rect.width)}px`;
                host.style.height = `${String(rect.height)}px`;
            }

            host.style.zIndex = String(manager.zIndexOf(record.id));

            // Hidden, never unmounted: a window the current mode cannot show keeps its DOM, its
            // effects, its scroll position and whatever was typed into it.
            host.hidden = record.state === 'minimized' || !visible.has(record.id);

            entry.frame.update?.(record, { focused: focused === record.id, tiled });
        }

        for (const [id, entry] of [...mounted]) {
            if (live.has(id)) continue;
            entry.instance.dispose();
            entry.frame.dispose?.();
            entry.frame.root.remove();
            mounted.delete(id);
            announce('closed', id);
        }
    });

    return {
        hostOf: (id) => mounted.get(id)?.frame.root,

        dispose() {
            stop();
            for (const entry of mounted.values()) {
                entry.instance.dispose();
                entry.frame.dispose?.();
                entry.frame.root.remove();
            }
            mounted.clear();
        },
    };
}

/**
 * A pointer drag, reported as deltas.
 *
 * Pointer capture rather than window-level listeners, because a drag that leaves the element must
 * keep receiving moves — the bug every hand-rolled drag has on the first try. The manager owns the
 * geometry; this owns nothing.
 */
export function drag(handle: HTMLElement, onMove: (dx: number, dy: number) => void): void {
    handle.addEventListener('pointerdown', (event: PointerEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);

        let x = event.clientX;
        let y = event.clientY;

        const move = (e: PointerEvent): void => {
            onMove(e.clientX - x, e.clientY - y);
            x = e.clientX;
            y = e.clientY;
        };

        const up = (): void => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
        };

        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
    });
}

// ---------------------------------------------------------------------------- the default chrome

/**
 * A title bar, a maximize button, a close button and a resize grip.
 *
 * Shipped so a site has a working window without writing chrome, and **replaceable**, which is the
 * whole point — this is an argument by construction that the drawn half is separable, made by
 * separating it. Every class name is left bare for a site's own stylesheet: the framework says which
 * element is the title bar, never what a title bar looks like.
 *
 * It closes and maximizes by asking the manager, exactly as an outside chrome would, so it has no
 * power an Extension lacks. A window whose view declared `closable: false` stays open when the close
 * button is pressed, because the manager refuses it — the button is simply not drawn for one.
 */
export const defaultFrame: FrameChrome = ({ id, drag: onDrag, manager }) => {
    const root = document.createElement('div');
    root.className = 'window';
    root.dataset['window'] = id;

    const bar = document.createElement('div');
    bar.className = 'titlebar';

    const label = document.createElement('span');
    label.className = 'label';

    const buttons = document.createElement('span');
    buttons.className = 'buttons';

    const max = document.createElement('button');
    max.type = 'button';
    max.textContent = '□';
    max.title = 'Maximize / restore';
    max.addEventListener('click', () => {
        const record = manager.get(id);
        if (record === undefined) return;
        if (record.state === 'maximized') manager.restore(id);
        else manager.maximize(id);
    });
    buttons.append(max);

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Close';
    close.addEventListener('click', () => { manager.close(id); });

    const content = document.createElement('div');
    content.className = 'content';

    const grip = document.createElement('div');
    grip.className = 'grip';

    bar.append(label, buttons);
    root.append(bar, content, grip);

    onDrag(bar, (dx, dy) => { manager.move(id, dx, dy); });
    onDrag(grip, (dx, dy) => { manager.resize(id, 'se', dx, dy); });

    let closeShown = false;

    return {
        root,
        content,

        update(record, state) {
            label.textContent = record.title;
            root.classList.toggle('focused', state.focused);
            root.classList.toggle('tiled', state.tiled);

            // Drawn only for a window that can actually be closed. A button that does nothing is
            // worse than no button, and since A6.3c-i the manager genuinely refuses.
            if (record.closable !== closeShown) {
                closeShown = record.closable;
                if (record.closable) buttons.append(close);
                else close.remove();
            }
        },
    };
};
