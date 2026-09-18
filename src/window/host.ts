/**
 * The view host: where an Application's view actually reaches the screen.
 *
 * This is the seam the whole design was arranged around, so it is worth naming what crosses it:
 *
 *   in  — a `ViewDecl` (declared statically, so the kernel knew about it before the Application
 *         started), the Application's API from `start()`, and the window's params
 *   out — a description, which the renderer turns into DOM
 *
 * The Application is not here. It has no element, no window handle, and no way to reach either. It
 * returned an API from `start()`, and a view is a pure function of that.
 */

import { createDetachedScope } from '../reactivity/scope.js';
import type { ReactiveScope } from '../reactivity/types.js';
import { createHandlerTable, type HandlerTable } from '../description/build.js';
import type { Action, IntentValue, Json } from '../description/types.js';
import type { ViewContext, ViewDecl } from '../contribution/contract.js';
import { RENDERER, type Dispatcher, type Mounted, type RendererOptions } from '../render/index.js';
import type { WindowManager } from './manager.js';
import type { ProviderToken } from '../contribution/provider.js';

export interface ViewHostOptions {
    readonly windowId: string;
    readonly decl: ViewDecl<never, never, never>;
    readonly api: unknown;
    readonly internal?: unknown;
    readonly params: Readonly<Record<string, Json>>;
    readonly windows: WindowManager;
    readonly resolve: <T>(token: ProviderToken<T>) => T | undefined;
    readonly renderOptions: RendererOptions;
    /** The part or application owning this view, if known. */
    readonly part?: string;
    /** Commands go to the kernel; handlers come back to this view's own table. */
    readonly onCommand: (action: Action) => void;
}

export interface ViewInstance {
    readonly windowId: string;
    /** Exposed so a test can assert the table empties — the bookkeeping most likely to be wrong. */
    readonly handlers: HandlerTable;
    dispose(): void;
}

/**
 * Mount one view instance into one element.
 *
 * One view instance per window. Two windows means two instances over one application state, which
 * is how a split editor showing one document twice works with no new concept
 * (spec/application.md section 6).
 */
export function mountView(host: Element, options: ViewHostOptions): ViewInstance {
    // Detached, and this is load-bearing. A shell naturally paints its windows from an effect, so
    // `mountView` is naturally called from inside one — and an effect disposes the scopes created
    // during its last run before running again. A view mounted that way dies the first time the
    // shell repaints for any reason at all (a focus change is enough), stays on screen, and stops
    // updating. It reads exactly like a broken reconciler and is an ownership bug.
    //
    // This function returns a `dispose()`. That makes the caller the owner, and something with an
    // explicit owner must not also have an implicit one.
    const scope: ReactiveScope = createDetachedScope();
    const handlers = createHandlerTable(options.windowId);
    const cleanups: (() => void)[] = [];

    // Every action from this view arrives here first. A command is the kernel's business; a handler
    // is this instance's, and resolving it locally is what keeps a closure from ever needing to
    // cross a boundary (spec/view-layer.md section 5).
    const dispatch: Dispatcher = {
        dispatch(action: Action, value?: IntentValue): void {
            if (action.kind === 'handler') {
                handlers.invoke(action.id, value);
                return;
            }

            // A command carries declared arguments; an intent's value is appended to them, so
            // `command('post.rename', slug)` on a field arrives as `run(slug, "the new title")`.
            // Appended rather than prepended because the declared arguments are the ones the author
            // wrote, and they should not move when a binding gains a value.
            options.onCommand(
                value === undefined
                    ? action
                    : { ...action, args: [...(action.args ?? []), value] },
            );
        },
    };

    const vx: ViewContext<never, never, never> = {
        params: options.params as never,
        app: options.api as never,
        internal: options.internal as never,
        /**
         * The table has always been here; nothing could reach it (roadmap A8.10).
         *
         * `handlers` is created above, the dispatcher below resolves `{ kind: 'handler' }` against
         * it, and it is disposed with the view — every part of the mechanism existed except the one
         * that lets an author put a function in. So handler intents resolved to nothing, silently,
         * because `invoke` returning `false` is a stale event rather than a crash.
         *
         * Bound to this window's table rather than a shared one, which is what makes a handler die
         * with the screen that owns it and what keeps two instances of one view from colliding —
         * ids are already `${windowId}:${n}`.
         */
        on: (fn) => handlers.on(fn),

        setTitle: (title) => options.windows.setTitle(options.windowId, title),
        close: () => options.windows.close(options.windowId),
        onDispose: (fn) => void cleanups.push(fn),
    };

    let mounted: Mounted | undefined;

    const part = options.part ?? options.renderOptions.part;
    const renderer = options.resolve(RENDERER);
    if (renderer === undefined) throw new Error('No renderer available to mount view.');

    scope.run(() => {
        mounted = renderer.render(options.decl.render(vx), host, {
            ...options.renderOptions,
            ...(part !== undefined ? { part } : {}),
            dispatch,
        });
    });

    return {
        windowId: options.windowId,
        handlers,

        dispose(): void {
            for (const fn of cleanups.splice(0)) {
                try {
                    fn();
                } catch {
                    // A view's own cleanup throwing must not stop the rest.
                }
            }
            mounted?.dispose();
            handlers.dispose();
            scope.dispose();
        },
    };
}
