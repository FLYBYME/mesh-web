/**
 * `Link` — the one way to go somewhere in an app-model site.
 *
 * An ordinary component, built from the model it serves: it injects `Router` and registers its own
 * handler. What it draws is the `Link` primitive, a real `<a href>`, so everything a browser does
 * with a link still works; a plain left click is intercepted and becomes `router.navigate`.
 *
 * ```ts
 * this.mount(Link, { href: this.inject.router.href(RecordsView, { zone }), children: [text('Records')] })
 * ```
 */

import { element } from '../description/build.js';
import type { Node } from '../description/types.js';
import { Router } from './router.js';
import { Component, props } from './units.js';

export class Link extends Component({
    inject: { router: Router },
    props: props<{
        /**
         * A function when the target changes while the link stays — "next page" is a different URL
         * on every page, and a link built once from a string would keep pointing at the first.
         */
        readonly href: string | (() => string);
        readonly children: readonly Node[];
        readonly class?: string;
    }>(),
}) {
    render(): Node {
        const { href, children } = this.props;
        const current = (): string => (typeof href === 'function' ? href() : href);
        return element('Link', {
            props: { href, ...(this.props.class !== undefined ? { class: this.props.class } : {}) },
            intents: { navigate: { action: this.on(() => this.inject.router.navigate(current())) } },
            children,
        });
    }
}
