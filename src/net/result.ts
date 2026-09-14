/**
 * A result, and the failures it names.
 *
 * Superseded for `MeshClient.call` (spec/type-safety.md §5's original "decided, not open" position,
 * reversed): `cx.mesh.call` now throws `MeshCallError` on failure and returns the raw value on
 * success, matching `ctx.call`/`broker.call` inside the mesh framework itself. `fillPath` already
 * threw synchronously out of `client.call()` for a missing path parameter before this change —
 * "never throws" was already not quite true.
 *
 * What the original design protected is kept: `CallError` stays a *named*, exhaustively-switched
 * union (`describe()` below has no `default`), so a caller catching `MeshCallError` still gets
 * `e.error.kind` to discriminate on, not an untyped `catch (e: unknown)`. `MeshCallError` is that
 * bridge — a thrown value carrying the same structured failure a `Result` used to.
 *
 * `Result`/`ok`/`err` remain, for the one place they're still real: a `models` collection's
 * *background reactive read* (`.rows()`/`.status()`/`.error()`) has no call site to throw at — it's a
 * signal read from a render function, not an awaited expression — so it keeps `.error()` as an
 * inspectable value. A collection *write* you directly await (`.create`/`.update`/`.delete`/`.get`)
 * throws, same as `.call()`.
 *
 * Deliberately *not* a general-purpose Result library. No `map`, no `andThen`, no chaining.
 */

export interface Ok<T> {
    readonly ok: true;
    readonly value: T;
}

export interface Err<E> {
    readonly ok: false;
    readonly error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

// ---------------------------------------------------------------------------- the failures every call has

/**
 * What can go wrong on the way, regardless of what was called.
 *
 * Every one of these is a *named* case rather than a status code, because the caller's decision
 * differs per case and a number does not say which decision to make. `unauthorized` means sign in;
 * `forbidden` means do not offer the action at all; `offline` means retry later and say so.
 *
 * `stale` is the one that is not an HTTP condition. spec/network.md section 6: a client generated
 * from an exposure that has since moved on is a lie, and it is worth an error of its own rather than
 * a confusing 404 somewhere downstream.
 */
/**
 * What differed between the client's expectations and the API's exposure.
 *
 * mesh-serve descriptor vocabulary: which contract key changed and how.
 */
export interface ExposureDifference {
    /** The contract key that differed, e.g. `domains.zone_find`. */
    readonly contract: string;
    /** What aspect changed. */
    readonly kind: 'missing' | 'method' | 'path' | 'input' | 'output' | 'gate';
    /** Human-readable explanation of what changed. */
    readonly message: string;
}

export type TransportError =
    | { readonly kind: 'unauthorized' }
    | { readonly kind: 'forbidden' }
    | { readonly kind: 'not_found' }
    | { readonly kind: 'invalid'; readonly detail: string }
    | { readonly kind: 'conflict'; readonly detail: string }
    | { readonly kind: 'rate_limited'; readonly retryAfterMs?: number }
    | { readonly kind: 'server'; readonly status: number; readonly detail: string }
    | { readonly kind: 'offline'; readonly detail: string }
    | {
        readonly kind: 'stale';
        readonly expected: string;
        readonly actual: string;
        readonly differences?: readonly ExposureDifference[];
    };

/** A failure the exposure declared for one call, carried as a literal so it can be discriminated. */
export interface DeclaredError<TName extends string> {
    readonly kind: 'declared';
    readonly name: TName;
    readonly detail: string;
}

export type CallError<TDeclared extends string> = TransportError | DeclaredError<TDeclared>;

/**
 * A message for a failure.
 *
 * Lives here rather than at each call site so that a site's error copy is one thing to change, and
 * so that a new case in `TransportError` is a compile error here rather than a silent `undefined`
 * in a toast — `switch` with no default, checked exhaustively.
 */
export function describe(error: CallError<string>): string {
    switch (error.kind) {
        case 'unauthorized': return 'You need to sign in.';
        case 'forbidden': return 'You do not have access to that.';
        case 'not_found': return 'That does not exist.';
        case 'invalid': return `That request was not valid: ${error.detail}`;
        case 'conflict': return `That conflicts with something else: ${error.detail}`;
        case 'rate_limited': return 'Too many requests. Try again shortly.';
        case 'server': return `The server failed (${error.status}).`;
        case 'offline': return 'Could not reach the server.';
        case 'stale': {
            if (error.differences !== undefined && error.differences.length > 0) {
                const details = error.differences.map((d) => d.message).join(' ');
                return `This page is out of date with the API: ${details}`;
            }
            return 'This page is out of date with the API. Reload.';
        }
        case 'declared': return error.detail;
    }
}

/**
 * What `MeshClient.call` throws on failure, and what a `models` write throws too.
 *
 * Carries the exact `CallError` a `Result`'s `.error` used to, as `.error` here — every existing
 * discriminator (`describe()`, `describeCallFailure()` in kernel/broker.ts, any `switch
 * (error.kind)`) keeps working unchanged; only how you obtain the `CallError` changes: catch +
 * `.error`, instead of check `.ok` + `.error`.
 */
export class MeshCallError<TName extends string = string> extends Error {
    constructor(public readonly error: CallError<TName>) {
        super(describe(error));
        this.name = 'MeshCallError';
    }
}
