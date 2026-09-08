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
