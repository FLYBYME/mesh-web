import { element, Link, Router, text, View, when, type Node } from '@flybyme/mesh-web';
import { Session } from '../services/session.service.js';
import { DomainListView } from './domains/domain-list.view.js';
import { SignInView } from './sign-in.view.js';

export class HomeView extends View({ inject: { router: Router, session: Session }, title: 'Harbor DNS' }) {
    render(): Node {
        const { router, session } = this.inject;
        return element('Stack', {
            props: { 'data-page': 'home', class: 'home' },
            children: [
                element('Heading', { props: { level: 1 }, children: [text('DNS for the rest of us')] }),
                element('Text', { children: [text('A reference console for the mesh-web app model: services, layouts, guards, forms from commands, and state in the URL.')] }),
                when(
                    () => session.signedIn(),
                    () => this.mount(Link, { href: router.href(DomainListView), class: 'ui-primary', children: [text('Open the console')] }),
                    () => this.mount(Link, { href: router.href(SignInView), class: 'ui-primary', children: [text('Sign in')] }),
                ),
            ],
        });
    }
}
