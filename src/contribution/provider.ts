/**
 * Provider tokens: how one contributor offers something to another, with the type intact.
 *
 * An Extension says what it `provides`. An Application says what it `consumes` and what it
 * `provides`. Both name a **token** rather than a string id, and the token is what carries the
 * type across a boundary the two sides never import across.
 *
 * The problem this solves: auth lives in one repo, the console in another. The console needs
 * `session` from auth, typed. It cannot import auth's implementation — that is the whole point of
 * them being separate bundles loaded at runtime — so something else has to carry the type.
 *
 * A shared types-only module declares the token:
 *
 * ```ts
 * // @surfdns/tokens — no runtime dependency on either side
 * export interface AuthApi {
 *     readonly session: ReadonlySignal<Session | null>;
 *     signOut(): Promise<void>;
 * }
 * export const Auth = provider<AuthApi>('identity.auth');
 * ```
 *
 * The provider implements it:
 *
 * ```ts
 * export default class AuthExtension implements Extension<['net'], readonly [], AuthApi> {
 *     readonly needs = ['net'] as const;
 *     readonly provides = Auth;
 *     activate(cx): AuthApi { ... }     // must return AuthApi — the token says so
 * }
 * ```
 *
 * The consumer names it and gets it typed:
 *
 * ```ts
 * export default class Console implements Application<['net'], readonly [typeof Auth]> {
 *     readonly consumes = [Auth] as const;
 *     onLoad(cx) {
 *         cx.use(Auth).session();       // ReadonlySignal<Session | null>, inferred
 *         cx.use(SomethingElse);        // compile error: not in `consumes`
 *     }
 * }
 * ```
 *
 * Two things fall out that a bare string id does not give you:
 *
 * - **`activate`'s return type is checked against the token.** A provider that drifts from what it
 *   promised fails to compile in its own repo, before anyone consuming it finds out at runtime.
 * - **`use` is restricted to what was declared.** Reaching for a provider you did not list is a
 *   compile error, so `consumes` is a complete statement of a bundle's dependencies and the host
 *   can resolve the whole graph — and refuse a bundle whose providers are missing — before running
 *   any of it.
 */

/**
 * Phantom marker. Never present at runtime; exists so the token's type parameter survives into
 * `Provided` and `use`. A `unique symbol` rather than a named property so nothing can collide with
 * it and nobody can be tempted to read it.
 */
declare const PROVIDED: unique symbol;

/** A typed name for something one contributor offers another. */
export interface ProviderToken<T> {
    readonly id: string;
    readonly [PROVIDED]?: T;
}

/**
 * Declares a provider token.
 *
 * The `id` is what the host matches on at runtime and what appears in a manifest; the type
 * parameter is what makes both sides agree at compile time. Declare it once, in a module both
 * sides can import types from — a token declared twice is two tokens.
 */
export function provider<T>(id: string): ProviderToken<T> {
    return { id };
}

/** The type a token carries. */
export type Provided<TToken> = TToken extends ProviderToken<infer T> ? T : never;

/** A list of tokens, as `consumes` declares them. */
export type ProviderTokens = readonly ProviderToken<unknown>[];

/**
 * The half of a contributor's context that resolves what it declared in `consumes`.
 *
 * `use` accepts only the declared tokens, and returns exactly what each carries. Anything the host
 * could not resolve was refused at load, so this never returns undefined — a missing provider is a
 * load failure naming both sides, not a null check at every call site.
 */
export interface Consumer<TConsumes extends ProviderTokens> {
    use<TToken extends TConsumes[number]>(token: TToken): Provided<TToken>;
}
