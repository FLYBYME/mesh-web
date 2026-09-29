/**
 * `mountDesktop` — an App's routes as windows (docs/app-model.md, phase 5b).
 *
 * The same App, the same routes, the same views as `mountSite`; only the presentation differs. A
 * route is a window: navigating opens one, or focuses the window already showing that route with
 * those params. `Router.current` is the focused window's route. Each window is its own view instance
 * — two windows on one route are two instances, as views have always promised.
 *
 * Built on the existing window layer rather than beside it: the real `WindowManager` (drag, tile,
 * focus, stacking) and `mountPage`'s shell. The shell mounts a window through `viewOf(owner, view)`
 * → a `ViewDecl`, so each route is handed to it as one whose `render` mounts the route's view through
 * the runtime — in the window's own handler table, and in the window's command scope, so a key
 * reaches only the window in front (and the page's services).
 */

import type { ViewContext, ViewDecl } from '../contribution/contract.js';
import { signal, type ReadonlySignal } from '../reactivity/index.js';
import { computed } from '../reactivity/computed.js';
import { IoManager } from '../kernel/io.js';
import { createRegistry, PRIMITIVES } from '../render/component.js';
import { createDomRenderer } from '../render/dom.js';
import { RENDERER, type Dispatcher } from '../render/renderer.js';
import { browserHistory, type HistoryLike } from '../router/router.js';
import { mountPage } from '../window/page.js';
import { WindowManager } from '../window/manager.js';
import type { CommandRegistryOptions } from './registry.js';
import { compileRoutes, type RouteMatch } from './routes.js';
import type { RouterBackend } from './router.js';
import { createAppRuntime, type AppClass, type AppRuntime, type GrantedContext } from './runtime.js';
import type { MountedApp } from './site.js';

export interface DesktopOptions {
    readonly root: Element;
    readonly granted?: GrantedContext;
    readonly history?: HistoryLike;
    readonly keys?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
    /** `inFront` is the desktop's own (the focused window) and cannot be overridden. */
    readonly commands?: Omit<CommandRegistryOptions, 'inFront'>;
    readonly mode?: 'windowed' | 'tiled';
    /** Where the renderer is found. The kernel passes its own; alone, one is made. */
    readonly io?: IoManager;
}

export interface MountedDesktop extends MountedApp {
    readonly manager: WindowManager;
}

export function mountDesktop(App: AppClass, options: DesktopOptions): MountedDesktop {
    const history = options.history ?? browserHistory(window);
    const table = compileRoutes(App.spec.routes);
    const owner = App.name;

    const io = options.io ?? new IoManager();
    if (io.get(RENDERER) === undefined) io.register(RENDERER, createDomRenderer(createRegistry(PRIMITIVES)));

    const manager = new WindowManager({ width: options.root.clientWidth, height: options.root.clientHeight });
    manager.setMode(options.mode ?? 'windowed');

    /** window id → the route it shows. A signal's tick marks changes, since a Map is not reactive. */
    const showing = new Map<string, RouteMatch>();
    const changed = signal(0);
    const bump = (): void => changed.set(changed() + 1);

    const route: ReadonlySignal<RouteMatch | undefined> = computed(() => {
        changed();
        const id = manager.focused();
        return id === undefined ? undefined : showing.get(id);
    });

    const show = (match: RouteMatch): void => {
        const open = new Set(manager.stacked().map((r) => r.id));
        for (const [id, shown] of showing) {
            if (shown.key === match.key && open.has(id)) {
                manager.focus(id);
                return;
            }
        }
        const record = manager.open({
            owner,
            view: match.pattern,
            params: match.raw,
            title: match.view.spec.title ?? match.view.name,
        });
        showing.set(record.id, match);
        manager.focus(record.id);
        bump();
    };

    const read = (): RouteMatch | undefined => table.match(history.pathname(), history.search());

    const backend: RouterBackend = {
        current: route,
        navigate(href) {
            const url = new URL(href, 'http://desktop.invalid');
            const match = table.match(url.pathname, url.search);
            if (match === undefined) {
                console.warn(`${owner}: nothing is routed at ${href}, so no window opens.`);
                return;
            }
            if (href !== `${history.pathname()}${history.search()}`) history.push(href);
            show(match);
        },
        back() {
            history.back();
        },
        href: (view, params) => table.href(view, params),
    };

    const live: AppRuntime = createAppRuntime(App, options.granted ?? {}, {
        router: backend,
        commands: { ...options.commands, inFront: () => manager.focused() },
    });

    /** Live handlers across every window, counted where the runtime registers and removes them. */
    let handlers = 0;

    /** One `ViewDecl` per route, made once: the shell asks for it every time it frames a window. */
    const decls = new Map<string, ViewDecl<never, never>>();
    const viewOf = (_owner: string, pattern: string): ViewDecl<never, never> | undefined => {
        const existing = decls.get(pattern);
        if (existing !== undefined) return existing;
        const view = App.spec.routes[pattern];
        if (view === undefined) return undefined;
        const decl: ViewDecl<never, never> = {
            id: pattern,
            title: view.spec.title ?? view.name,
            render: (vx: ViewContext<never, never>) => live.view(view, vx.params, {
                on: (fn) => { handlers++; return vx.on(fn); },
                off: (action) => { handlers--; vx.off(action); },
            }, vx.windowId),
        };
        decls.set(pattern, decl);
        return decl;
    };

    // Windows carry their own dispatchers; nothing is drawn outside them that could dispatch.
    const dispatch: Dispatcher = { dispatch: () => undefined };

    const page = mountPage(options.root, {
        manager,
        viewOf,
        apiOf: () => undefined,
        resolve: (token) => io.get(token),
        renderOptions: { dispatch },
        onCommand: () => undefined,
        onWindow: (event, id) => {
            if (event === 'closed' && showing.delete(id)) bump();
        },
    });

    const measure = (): void => {
        if (manager.mode() !== 'single') manager.setViewport({ width: page.host.clientWidth, height: page.host.clientHeight });
    };
    measure();
    const win = options.root.ownerDocument.defaultView;
    win?.addEventListener('resize', measure);

    const stopHistory = history.onChange(() => {
        const match = read();
        if (match !== undefined) show(match);
    });
    const stopKeys = live.commands.attach(options.keys ?? options.root.ownerDocument);

    const first = read() ?? table.match('/', '');
    if (first !== undefined) show(first);

    return {
        runtime: live,
        route,
        manager,
        navigate: backend.navigate,
        handlerCount: () => handlers,
        dispose() {
            stopKeys();
            stopHistory();
            win?.removeEventListener('resize', measure);
            page.dispose();
            live.dispose();
        },
    };
}
