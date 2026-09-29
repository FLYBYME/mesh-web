/**
 * `Router` — a service like any other, injected like any other (docs/app-model.md §5, phase 4).
 *
 * `inject: { router: Router }` gives a unit the current route, `navigate`, and a typed `href`:
 * `router.href(RecordsView, { zone })` is checked against `RecordsView`'s params at compile time, so
 * a link cannot name a param the view does not take or forget one it needs.
 *
 * What it drives — the URL, the history, which view is mounted — belongs to whatever mounted the
 * site (`mountSite`), which hands the runtime a backend. The service is the typed face of it; that is
 * why it has no `needs` of its own.
 */

import type { ReadonlySignal } from '../reactivity/index.js';
import type { RouteMatch } from './routes.js';
import type { InferInput, ViewClass } from './types.js';
import { Service } from './units.js';

export interface RouterBackend {
    readonly current: ReadonlySignal<RouteMatch | undefined>;
    navigate(href: string): void;
    back(): void;
    href(view: ViewClass, params: unknown): string;
}

/** `href(View)` for a view without params; `href(View, params)` — the schema's input type — for one with. */
export type HrefArgs<V extends ViewClass> =
    V['spec'] extends { readonly params: infer P } ? [params: InferInput<P>] : [];

const backends = new WeakMap<object, RouterBackend>();

/** Kernel side: give a constructed `Router` the site it answers for. Not for app code. */
export function attachRouter(router: object, backend: RouterBackend): void {
    backends.set(router, backend);
}

export class Router extends Service({}) {
    /** The route on screen, or `undefined` for a URL nothing matches. */
    get current(): ReadonlySignal<RouteMatch | undefined> {
        return this.#backend().current;
    }

    navigate(href: string): void {
        this.#backend().navigate(href);
    }

    back(): void {
        this.#backend().back();
    }

    href<V extends ViewClass>(view: V, ...params: HrefArgs<V>): string {
        return this.#backend().href(view, params[0]);
    }

    #backend(): RouterBackend {
        const backend = backends.get(this);
        if (backend === undefined) {
            throw new Error('Router was injected, but this app was not mounted as a site, so there is no URL to route.');
        }
        return backend;
    }
}
