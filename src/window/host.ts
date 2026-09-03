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
import type { Action, Json } from '../description/types.js';
import type { ViewContext, ViewDecl } from '../contribution/contract.js';
import { render, type Dispatcher, type Mounted, type RenderOptions } from '../render/index.js';
import type { WindowManager } from './manager.js';

export interface ViewHostOptions {
    readonly windowId: string;
    readonly decl: ViewDecl<never, never>;
    readonly api: unknown;
    readonly params: Readonly<Record<string, Json>>;
    readonly windows: WindowManager;
    readonly render: RenderOptions;
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
        dispatch(action: Action): void {
            if (action.kind === 'handler') {
                handlers.invoke(action.id);
                return;
            }
            options.onCommand(action);
        },
    };

    const vx: ViewContext<never, never> = {
        params: options.params as never,
        app: options.api as never,
        setTitle: (title) => options.windows.setTitle(options.windowId, title),
        close: () => options.windows.close(options.windowId),
        onDispose: (fn) => void cleanups.push(fn),
    };

    let mounted: Mounted | undefined;

    scope.run(() => {
        mounted = render(options.decl.render(vx), host, { ...options.render, dispatch });
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
