/**
 * Who is signed in. One per page; everything that cares injects it.
 *
 * The guard reads `user()`, the nav reads `user()`, the sign-in form runs `signIn`. None of them
 * know how signing in works — that is the point of a service.
 */

import { command, computed, Service, signal } from '@flybyme/mesh-web';
import { z } from 'zod';
import { FakeApi, type User } from '../api/fake-api.js';

export class Session extends Service({ inject: { api: FakeApi } }) {
    readonly user = signal<User | undefined>(undefined);
    readonly signedIn = computed(() => this.user() !== undefined);

    /**
     * The form for this is built from this schema (`ui/command-form.ts`): the labels are the form's,
     * the rules are here, once. A rule added here is enforced by every form that signs someone in.
     */
    readonly signIn = command({
        title: 'Sign in',
        input: z.object({
            email: z.string().trim().email('Enter an email address.'),
            password: z.string().min(8, 'At least 8 characters.'),
        }),
        run: async ({ email, password }) => {
            this.user.set(await this.inject.api.signIn(email, password));
        },
    });

    readonly signOut = command({
        title: 'Sign out',
        run: () => { this.user.set(undefined); },
    });
}
