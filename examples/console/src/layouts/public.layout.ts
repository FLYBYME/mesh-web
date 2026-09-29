/**
 * The public pages' chrome: a header and the page. It persists across public pages, so the header
 * is built once, not once per page.
 */

import { Component, element, Link, props, Router, text, when, type LayoutProps, type Node } from '@flybyme/mesh-web';
import { HomeView } from '../pages/home.view.js';
import { SignInView } from '../pages/sign-in.view.js';
import { DomainListView } from '../pages/domains/domain-list.view.js';
import { Session } from '../services/session.service.js';

export class PublicLayout extends Component({ inject: { router: Router, session: Session }, props: props<LayoutProps>() }) {
    render(): Node {
        const { router, session } = this.inject;
        return element('Stack', {
            props: { class: 'public' },
            children: [
                element('Row', {
                    props: { class: 'public-header', role: 'banner' },
                    children: [
                        this.mount(Link, { href: router.href(HomeView), class: 'brand', children: [text('Harbor DNS')] }),
                        when(
                            () => session.signedIn(),
                            () => this.mount(Link, { href: router.href(DomainListView), children: [text('Console')] }),
                            () => this.mount(Link, { href: router.href(SignInView), children: [text('Sign in')] }),
                        ),
                    ],
                }),
                element('Stack', { props: { class: 'public-main', role: 'main' }, children: [this.props.outlet] }),
            ],
        });
    }
}
