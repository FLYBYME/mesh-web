/**
 * Sign in, then go where the visitor was going.
 *
 * `next` is query state, put there by the console's guard. It is only ever a path on this site —
 * the schema refuses anything else, so a crafted link cannot bounce a visitor to another origin
 * after they type their password.
 */

import { element, Router, text, View, type Node } from '@flybyme/mesh-web';
import { z } from 'zod';
import { Session } from '../services/session.service.js';
import { commandForm } from '../ui/command-form.js';
import { DomainListView } from './domains/domain-list.view.js';

export class SignInView extends View({
    inject: { router: Router, session: Session },
    query: z.object({ next: z.string().regex(/^\/(?!\/)/).optional() }),
    title: 'Sign in · Harbor DNS',
}) {
    /** A form class for this page's command. Built once per page instance, mounted below. */
    readonly SignInForm = commandForm(this.inject.session.signIn, {
        email: { label: 'Email', type: 'email', autocomplete: 'username' },
        password: { label: 'Password', type: 'password', autocomplete: 'current-password' },
    });

    render(): Node {
        const { router } = this.inject;
        return element('Stack', {
            props: { 'data-page': 'sign-in', class: 'sign-in' },
            children: [
                element('Heading', { props: { level: 1 }, children: [text('Sign in')] }),
                element('Text', { props: { class: 'hint' }, children: [text('Any email; the password is “correct horse”.')] }),
                this.mount(this.SignInForm, {
                    onDone: () => router.replace(this.query().next ?? router.href(DomainListView)),
                }),
            ],
        });
    }
}
