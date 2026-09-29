/**
 * **Who is signed in — the shape, not the acquiring of it.**
 *
 * The kernel owns the shape: `services.session` is a `ReadonlySignal<Session | null>`, `models` reads
 * it to scope a query, and `credentials.attach` takes one. None of that knows how a session is
 * obtained. Something on the page does the acquiring — signing in, holding a ticket, giving it back —
 * and a site decides whether it wants one at all; a blog that never signs anybody in carries none.
 * In the app model that something is an ordinary service (the company site's `AuthService`).
 *
 * The fields are the ones every consumer in this package actually reads. Anything an identity
 * provider knows beyond them — memberships, organizations — belongs to that provider's own API.
 *
 * (The part model also defined `AUTH`, `AuthApi` and `Credentialed` here: the token an auth
 * Extension was found by, and what it offered. A service is found by its class, so they went with
 * that model — docs/app-model.md, phase 5c.)
 */

export interface Session {
    readonly userId: string;
    readonly displayName: string;
    /**
     * What this session may do, as the site named it.
     *
     * Read by a part deciding whether to render a control, and never by the kernel — which does not
     * know what any of these mean. The **server** decides what a role permits; a role here is a hint
     * for a screen, and a screen that treats it as an authorization has misunderstood the boundary.
     */
    readonly roles: readonly string[];
    /** When the credential stops being accepted. Whatever holds it signs out at that point. */
    readonly expiresAt: number;
}
