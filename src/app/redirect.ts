/**
 * `Redirect` — mounting it sends the visitor somewhere else, in place of here.
 *
 * A guard is not a separate concept in the app model. It is a `when` over a service's state, with a
 * `Redirect` on the other side:
 *
 * ```ts
 * render(): Node {
 *     return when(() => this.inject.session.user() !== undefined, () => this.props.outlet, () =>
 *         this.mount(Redirect, { to: this.inject.router.href(SignInView, { next: location.pathname }) }));
 * }
 * ```
 *
 * The navigation is deferred to a microtask, never run during render: it changes the route, which
 * is what the renderer is in the middle of reconciling. If the redirect is unmounted before then (the
 * session arrived in the same tick), nothing happens.
 */

import { empty } from '../description/build.js';
import type { Node } from '../description/types.js';
import { Router } from './router.js';
import { Component, props } from './units.js';

export class Redirect extends Component({
    inject: { router: Router },
    props: props<{ readonly to: string }>(),
}) {
    #gone = false;

    render(): Node {
        this.cx.onDispose(() => { this.#gone = true; });
        queueMicrotask(() => {
            if (!this.#gone) this.inject.router.replace(this.props.to);
        });
        return empty();
    }
}
