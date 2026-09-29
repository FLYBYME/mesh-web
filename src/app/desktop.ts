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
 * → a `WindowView`, so each route is handed to it as one whose `render` mounts the route's view through
 * the runtime — in the window's own handler table, and in the window's command scope, so a key
 * reaches only the window in front (and the page's services).
 */

import type { WindowView } from '../window/view.js';
import { signal, type ReadonlySignal } from '../reactivity/index.js';
import { computed } from '../reactivity/computed.js';
import { IoManager } from '../kernel/io.js';
import { createRegistry, PRIMITIVES } from '../render/component.js';
import { createDomRenderer } from '../render/dom.js';
import { RENDERER, type Dispatcher } from '../render/renderer.js';
import { browserHistory, type HistoryLike } from '../router/router.js';
import { mountPage } from '../window/page.js';
import type { FrameChrome, Shell } from '../window/shell.js';
import { WindowManager } from '../window/manager.js';
import type { CommandRegistryOptions } from './registry.js';
import { compileRoutes, routeParts, type RouteMatch } from './routes.js';
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
    /** How one window is drawn. The shell's `defaultFrame` when a site has not said. */
    readonly frame?: FrameChrome;
}

export interface MountedDesktop extends MountedApp {
    readonly manager: WindowManager;
    /** The window layer: where each window's frame is (`shell.hostOf(id)`). */
    readonly shell: Shell;
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
                // Same path, perhaps a new query: the window's view follows it without a rebuild.
                if (shown !== match) {
                    showing.set(id, match);
                    bump();
                }
                manager.focus(id);
                return;
            }
        }
        // The view's window hints, applied the way the part-era window sink applied them.
        const hints = match.view.spec.window;
        const record = manager.open({
            owner,
            view: match.pattern,
            params: match.raw,
            title: match.view.spec.title ?? match.view.name,
            ...(hints?.tile === undefined ? {} : { tile: hints.tile }),
            ...(hints?.defaultSize === undefined ? {} : { size: hints.defaultSize }),
            ...(hints?.minSize === undefined
                ? {}
                : { minSize: { width: hints.minSize.width ?? 0, height: hints.minSize.height ?? 0 } }),
            closable: hints?.closable ?? true,
        });
        showing.set(record.id, match);
        manager.focus(record.id);
        bump();
    };

    const read = (): RouteMatch | undefined => table.match(history.pathname(), history.search());

    const matchHref = (href: string): RouteMatch | undefined => {
        const url = new URL(href, 'http://desktop.invalid');
        const match = table.match(url.pathname, url.search);
        if (match === undefined) console.warn(`${owner}: nothing is routed at ${href}, so no window opens.`);
        return match;
    };

    const backend: RouterBackend = {
        current: route,
        navigate(href) {
            const match = matchHref(href);
            if (match === undefined) return;
            if (href !== `${history.pathname()}${history.search()}`) history.push(href);
            show(match);
        },
        replace(href) {
            // A redirect: the window in front is replaced by the target, not joined by it.
            const match = matchHref(href);
            if (match === undefined) return;
            const from = manager.focused();
            if (href !== `${history.pathname()}${history.search()}`) history.replace(href);
            show(match);
            if (from !== undefined && from !== manager.focused()) manager.close(from);
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

    /** One `WindowView` per route, made once: the shell asks for it every time it frames a window. */
    const windowViews = new Map<string, WindowView>();
    const viewOf = (_owner: string, pattern: string): WindowView | undefined => {
        const existing = windowViews.get(pattern);
        if (existing !== undefined) return existing;
        const route = App.spec.routes[pattern];
        if (route === undefined) return undefined;
        // The layout is not drawn here: on the desktop, the shell is every window's layout.
        const { view } = routeParts(route);
        const hints = view.spec.window;
        const windowView: WindowView = {
            id: pattern,
            title: view.spec.title ?? view.name,
            ...(hints === undefined ? {} : { window: hints }),
            // The route's view, mounted through the runtime in this window's handler table and in
            // this window's command scope — so a key reaches only the window in front.
            render: (vx) => live.view(view, vx.params, {
                on: (fn) => { handlers++; return vx.on(fn); },
                off: (action) => { handlers--; vx.off(action); },
            }, vx.windowId, () => { changed(); return showing.get(vx.windowId)?.query ?? {}; }),
        };
        windowViews.set(pattern, windowView);
        return windowView;
    };

    // Windows carry their own dispatchers; nothing is drawn outside them that could dispatch.
    const dispatch: Dispatcher = { dispatch: () => undefined };

    const page = mountPage(options.root, {
        manager,
        viewOf,
        resolve: (token) => io.get(token),
        renderOptions: { dispatch },
        onWindow: (event, id) => {
            if (event === 'closed' && showing.delete(id)) bump();
        },
        ...(options.frame === undefined ? {} : { frame: options.frame }),
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
        shell: page.shell,
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
