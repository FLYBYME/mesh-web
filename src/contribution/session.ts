/**
 * **Who is signed in — the shape, not the acquiring of it.**
 *
 * This type lived in `src/auth/extension.ts` alongside the Extension that produced it, which meant
 * three files in the kernel (`capabilities.ts`, `broker.ts`, `models/query.ts`) imported from an
 * implementation in order to name a type. That is the wrong direction: the kernel defines the seam,
 * and something else fills it.
 *
 * So the split is:
 *
 * - **The kernel owns the shape.** `services.session` is a `ReadonlySignal<Session | null>`,
 *   `models` reads it to scope a query, and `credentials.attach` takes one. All of that is framework
 *   and none of it knows how a session is obtained.
 * - **A part owns the acquiring.** Signing in, holding a ticket, refreshing it, storing it, giving
 *   it back — that is an Extension's job, it lives in mesh-core, and a site decides whether it wants
 *   one at all. A blog that never signs anybody in should not be carrying a session.
 *
 * The fields are the ones every consumer in this package actually reads. Anything an *identity
 * provider* knows beyond them — memberships, organizations, a chosen scope — belongs on that
 * provider's own published API, not here, because the kernel cannot have an opinion about what a
 * tenant is.
 */
import { provider } from './provider.js';

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

// ---------------------------------------------------------------------------- the seam's token

/**
 * **What something that holds a session offers, and the token it is found by.**
 *
 * These were in mesh-core beside `AuthExtension`, and that placement was wrong for the same reason
 * `Session` itself was wrong there — one step further out, and the failure it caused is louder.
 *
 * `ProviderToken`'s own doc states the rule: *"A consumer must get `AuthApi`'s type without
 * importing `AuthExtension` — otherwise it has pulled in the whole Extension and the token bought
 * nothing. The interface and the token live in a third place both sides import."* There is exactly
 * one third place a part may import: `@flybyme/mesh-web` is the single specifier the builder marks
 * external, and everything else is bundled from the part's own tree. So a token that lives in
 * mesh-core cannot be named by any part that is not mesh-core.
 *
 * That is not a style argument. flowboard declared `consumes(AUTH)`, typechecked against a
 * hand-made symlink, and the builder answered `Could not resolve "@flybyme/mesh-core"` — three
 * times, and the release was recorded as published-with-no-artifact each time, so the failure
 * surfaced two steps later as a composition error naming neither the import nor the file.
 *
 * The division is unchanged and now actually holds: **the kernel defines the shape of the hole, a
 * part fills it.** `AuthExtension` — signing in, holding a ticket, refreshing it, storing it — stays
 * in mesh-core, is what a site chooses to load or not, and is imported by nobody.
 */
export interface Credentialed {
    readonly email: string;
    readonly password: string;
}

/**
 * What other contributions may do with the session.
 *
 * Note what is **not** here: the ticket. A consumer can ask who is signed in and can ask to sign
 * out; it cannot obtain the credential, because the moment it can, "the auth Extension attaches the
 * ticket" becomes advice rather than a property.
 */
export interface AuthApi {
    readonly session: import('../reactivity/types.js').Signal<Session | null>;
    signIn(credentials: Credentialed): Promise<Session>;
    signOut(): Promise<void>;
}

/**
 * The id is unchanged — `mesh-web/auth` — because a token's identity *is* its id string, and
 * changing it would silently stop resolving for anything already declaring it.
 */
export const AUTH: import('./provider.js').ProviderToken<AuthApi> =
    provider<AuthApi>('mesh-web/auth');
