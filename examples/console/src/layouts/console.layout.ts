/**
 * The signed-in console's chrome — and its guard.
 *
 * Every console route is drawn inside this, so the guard is written once: signed in, the page;
 * otherwise a `Redirect` to sign-in carrying where the visitor was going. There is no guard concept
 * in the framework; this `when` is all a guard is.
 *
 * The layout stays mounted while the visitor moves between console pages. Its state — here, the
 * collapsed sidebar — survives that, and the nav is built once.
 */

import {
    command, Component, element, Link, props, Redirect, Router, signal, text, when,
    type LayoutProps, type Node,
} from '@flybyme/mesh-web';
import { DomainListView } from '../pages/domains/domain-list.view.js';
import { HomeView } from '../pages/home.view.js';
import { SignInView } from '../pages/sign-in.view.js';
import { Session } from '../services/session.service.js';

export class ConsoleLayout extends Component({ inject: { router: Router, session: Session }, props: props<LayoutProps>() }) {
    readonly collapsed = signal(false);

    /** Live while the layout is: alt+o signs out from any console page, and from nowhere else. */
    readonly signOut = command({
        title: 'Sign out',
        key: 'alt+o',
        run: async () => {
            await this.inject.session.signOut.run();
            this.inject.router.navigate(this.inject.router.href(HomeView));
        },
    });

    readonly toggleSidebar = command({
        title: 'Toggle sidebar',
        key: 'alt+b',
        run: () => this.collapsed.set(!this.collapsed()),
    });

    render(): Node {
        const { router, session } = this.inject;
        return when(
            () => session.signedIn(),
            () => element('Grid', {
                props: { class: 'console', 'data-collapsed': () => String(this.collapsed()) },
                children: [
                    element('Stack', {
                        props: { class: 'console-nav', role: 'navigation', 'aria-label': 'Console' },
                        children: [
                            this.mount(Link, { href: router.href(HomeView), class: 'brand', children: [text('Harbor DNS')] }),
                            this.mount(Link, { href: router.href(DomainListView), children: [text('Domains')] }),
                            element('Stack', { props: { class: 'console-spacer' }, children: [] }),
                            element('Text', { props: { class: 'console-user' }, children: [text(() => session.user()?.email ?? '')] }),
                            element('Button', {
                                props: { 'aria-label': 'Sign out', title: 'Sign out (alt+o)' },
                                intents: { activate: { action: this.on(() => void this.signOut.run()) } },
                                children: [text('Sign out')],
                            }),
                            element('Button', {
                                props: { class: 'console-collapse', expanded: () => !this.collapsed(), title: 'Toggle sidebar (alt+b)' },
                                intents: { activate: { action: this.on(() => void this.toggleSidebar.run()) } },
                                children: [text(() => (this.collapsed() ? '»' : '«'))],
                            }),
                        ],
                    }),
                    element('Stack', { props: { class: 'console-main', role: 'main' }, children: [this.props.outlet] }),
                ],
            }),
            () => this.mount(Redirect, { to: router.href(SignInView, { next: router.here() }) }),
        );
    }
}
