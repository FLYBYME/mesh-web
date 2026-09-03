/**
 * The auth Extension.
 *
 * A capability, not a process: one per site, activated once, spans every Application, and has no
 * route and no window of its own. Kill it and everything consuming it breaks — which is the test
 * that says this is an Extension rather than an Application (spec/extension.md §1).
 *
 * It is the site's, not the framework's. surfdns ships one; a blog ships a different one; both
 * satisfy the same token.
 */

import { needs, type Extension, type Context } from '@flybyme/mesh-web';

import { AUTH, type AuthApi, type Session } from '../contracts/auth.js';

/**
 * The list, written once, as a value.
 *
 * No `as const` — `needs()` is a rest parameter with a `const` type parameter, so the literal
 * tuple survives. Try adding 'windows' here and watch `activate` gain a capability; try
 * misspelling one and watch the error land on the typo.
 */
const NEEDS = needs('net', 'notifications', 'state', 'storage', 'events', 'log');

export default class AuthExtension implements Extension<typeof NEEDS, readonly [], typeof AUTH> {
    readonly needs = NEEDS;
    readonly provides = AUTH;

    /**
     * Construction is side-effect free. No DOM, no network, no registration.
     *
     * This is what lets the kernel construct every contribution, inspect the graph, and only then
     * start activating — spec/kernel.md §3, step 3.
     */
    constructor() {}

    activate(cx: Context<typeof NEEDS, readonly []>): AuthApi {
        const session = cx.state.signal<Session | null>(null);

        // Restore a cached session so the first paint is not blank while the network answers.
        // Storage is async and namespaced to this contributor; nobody else can read this key.
        void cx.storage.get<Session>('session').then((cached) => {
            if (cached) session.set(cached);
            void revalidate();
        });

        /**
         * Validate on first sight, cache, invalidate by event — spec/auth.md §3.
         *
         * The browser's copy is a hint. The API is what enforces, so a stale session here is a
         * cosmetic problem and not a security one.
         */
        async function revalidate(): Promise<void> {
            try {
                const fresh = await cx.net.get<Session | null>('/api/me');
                session.set(fresh);
                if (fresh) await cx.storage.set('session', fresh);
                else await cx.storage.remove('session');
            } catch (error) {
                cx.log.warn('session revalidation failed, keeping cached copy', error);
            }
        }

        // Revocation arrives over SSE. This is why revocation is near-immediate rather than
        // bounded by a ticket's expiry.
        cx.events.onNamed('identity.ticket_revoked', () => {
            session.set(null);
            void cx.storage.remove('session');
            cx.notifications.warn('Your session ended. Sign in again to continue.');
        });

        cx.events.onNamed('identity.grant_changed', () => {
            void revalidate();
        });

        cx.onDispose(() => {
            // Nothing to do. The kernel disposes the capabilities it scoped to this contributor,
            // and the event subscriptions go with them — spec/kernel.md §4.
        });

        return {
            session,

            signedIn: () => session() !== null,

            async signIn() {
                const done = cx.notifications.progress('Signing in…');
                try {
                    // A passkey identifies the person. The browser holds no long-lived credential
                    // and this Extension never sees a password — spec/auth.md §4.
                    const challenge = await cx.net.post<{ challenge: string }>('/api/auth/challenge', {});
                    const assertion = await navigator.credentials.get({
                        publicKey: { challenge: Uint8Array.from(atob(challenge.challenge), (c) => c.charCodeAt(0)) },
                    });

                    const fresh = await cx.net.post<Session>('/api/auth/verify', { assertion });
                    session.set(fresh);
                    await cx.storage.set('session', fresh);

                    done.update(`Signed in as ${fresh.displayName}`);
                    window.setTimeout(() => done.dismiss(), 2000);
                } catch (error) {
                    done.dismiss();
                    cx.notifications.error('Sign in failed', error);
                    throw error;
                }
            },

            async signOut() {
                await cx.net.post('/api/auth/sign-out', {});
                session.set(null);
                await cx.storage.remove('session');
                cx.notifications.info('Signed out.');
            },

            /**
             * A hint for the UI, and nothing more.
             *
             * "Locking the UI is not access control" — spec/storage-and-registry.md §2. Hiding a
             * button the API would refuse is a courtesy; the API refusing it is the control.
             */
            can(action: string): boolean {
                const current = session();
                if (!current) return false;
                return current.roles.some((role) => grants[role]?.some((p) => matches(p, action)) ?? false);
            },
        };
    }
}

/** Stand-in for grants fetched from mesh-identity. Grants are additive and deny by default. */
const grants: Record<string, readonly string[]> = {
    public: ['post.read'],
    author: ['post.read', 'post.write', 'post.publish'],
    admin: ['*'],
};

function matches(pattern: string, action: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith('.*')) return action.startsWith(pattern.slice(0, -1));
    return pattern === action;
}
