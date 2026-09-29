/**
 * `mountSite` — an app-model App as a single-page site (docs/app-model.md §5, phase 4).
 *
 * No kernel, no windows, no manifest: the renderer, one handler table, the browser's history, and
 * one view per URL. This is the path a website takes; the windowed desktop is a presentation of the
 * same routes, and arrives with the kernel integration (phase 5).
 *
 * The outlet is an `each` over zero or one route matches, keyed by `RouteMatch.key`, so the
 * existing reconciler does the swapping: a new route or new path params disposes the old view
 * instance (and everything it mounted) and constructs a new one; a new query string only updates the
 * live instance's `query()`.
 */

import { createHandlerTable, each, element, text, when } from '../description/build.js';
import type { Node } from '../description/types.js';
import { signal, type ReadonlySignal } from '../reactivity/index.js';
import { effect } from '../reactivity/effect.js';
import { createRegistry, PRIMITIVES } from '../render/component.js';
import { render } from '../render/dom.js';
import type { Dispatcher } from '../render/renderer.js';
import { browserHistory, type HistoryLike } from '../router/router.js';
import type { CommandRegistryOptions } from './registry.js';
import type { LayoutClass } from './types.js';
import { compileRoutes, type RouteMatch } from './routes.js';
import type { RouterBackend } from './router.js';
import { createAppRuntime, type AppClass, type AppRuntime, type GrantedContext, type HandlerRegistry } from './runtime.js';

export interface SiteOptions {
    /** Where the site renders. It owns everything inside. */
    readonly root: Element;
    /** The capabilities the App was granted. The kernel supplies these once it boots Apps (phase 5). */
    readonly granted?: GrantedContext;
    /** Defaults to the real browser history. */
    readonly history?: HistoryLike;
    /** Where keyed commands listen. Defaults to `root`'s document. */
    readonly keys?: Pick<Document, 'addEventListener' | 'removeEventListener'>;
    readonly commands?: CommandRegistryOptions;
    /** What to show for a URL no route matches (or whose params do not parse). */
    readonly notFound?: (path: string) => Node;
}

export interface MountedApp {
    readonly runtime: AppRuntime;
    readonly route: ReadonlySignal<RouteMatch | undefined>;
    navigate(href: string): void;
    /**
     * How many intent handlers are live. A diagnostic: a number that only ever grows while someone
     * uses the page is a leak — the thing per-instance handler removal exists to prevent.
     */
    handlerCount(): number;
    dispose(): void;
}

export function mountSite(App: AppClass, options: SiteOptions): MountedApp {
    const history = options.history ?? browserHistory(window);
    const table = compileRoutes(App.spec.routes);
    const read = (): RouteMatch | undefined => table.match(history.pathname(), history.search());

    const route = signal<RouteMatch | undefined>(read());
    const stopHistory = history.onChange(() => route.set(read()));

    const backend: RouterBackend = {
        current: route,
        navigate(href) {
            // Same URL: nothing to push, and nothing to remount.
            if (href === `${history.pathname()}${history.search()}`) return;
            history.push(href);
            route.set(read());
        },
        replace(href) {
            if (href === `${history.pathname()}${history.search()}`) return;
            history.replace(href);
            route.set(read());
        },
        back() {
            history.back();
        },
        href: (view, params) => table.href(view, params),
    };

    const runtime = createAppRuntime(App, options.granted ?? {}, {
        router: backend,
        ...(options.commands !== undefined ? { commands: options.commands } : {}),
    });

    const handlers = createHandlerTable('site');
    const registry: HandlerRegistry = { on: handlers.on, off: (action) => handlers.remove(action) };
    const dispatch: Dispatcher = {
        dispatch(action, value) {
            if (action.kind === 'handler') {
                handlers.invoke(action.id, value);
                return;
            }
            // A legacy `command('id')` action has nothing to reach in an app-model site. Loud, not
            // silent — a button that does nothing is the bug this whole model exists to remove.
            console.error(`"${action.id}" is a command id; app-model sites run command objects. Use this.on(() => cmd.run()).`);
        },
    };

    const notFound = options.notFound ?? ((path: string) => element('Stack', {
        props: { role: 'alert', 'data-not-found': '' },
        children: [text(`Nothing here: ${path}`)],
    }));

    // Two levels, each an `each` over zero or one item. The outer is keyed by layout, so while
    // consecutive pages share a layout it stays mounted; the inner is keyed by route and path params,
    // so the view inside is replaced. A view with no layout is its own outer item.
    const layoutKeys = new Map<LayoutClass, string>();
    const layoutKey = (match: RouteMatch): string => {
        const layout = match.layout;
        if (layout === undefined) return 'none';
        let key = layoutKeys.get(layout);
        if (key === undefined) layoutKeys.set(layout, key = `layout${layoutKeys.size}`);
        return key;
    };

    const outlet = (layout: LayoutClass | undefined): Node => each(
        () => { const current = route(); return current === undefined || current.layout !== layout ? [] : [current]; },
        (match) => match.key,
        // Same key, new query: `match` is re-read, so the live view's `query()` follows it.
        (match) => runtime.view(match().view, match().raw, registry, undefined, () => match().query),
    );

    const page: Node = [
        each(
            () => { const current = route(); return current === undefined ? [] : [current]; },
            layoutKey,
            (match) => {
                const layout = match().layout;
                return layout === undefined ? outlet(undefined) : runtime.component(layout, { outlet: outlet(layout) }, registry);
            },
        ),
        when(() => route() === undefined, () => notFound(history.pathname())),
    ];

    const mounted = render(page, options.root, { components: createRegistry(PRIMITIVES), dispatch });
    const stopKeys = runtime.commands.attach(options.keys ?? options.root.ownerDocument);

    // A view's `title`, if it declares one, is the page's; otherwise the page's own title comes back.
    // Only setting it when declared left the last page's title on a 404, or on any untitled view
    // navigated to from a titled one — found by loading the site as a visitor, not by a test.
    const document = options.root.ownerDocument;
    const pageTitle = document.title;
    const stopTitle = effect(() => {
        document.title = route()?.view.spec.title ?? pageTitle;
    });

    return {
        runtime,
        route,
        navigate: backend.navigate,
        handlerCount: () => handlers.size,
        dispose() {
            stopTitle();
            document.title = pageTitle;
            stopKeys();
            stopHistory();
            mounted.dispose();
            handlers.dispose();
            runtime.dispose();
        },
    };
}
