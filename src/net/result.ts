/**
 * A result, and the failures it names.
 *
 * spec/type-safety.md section 5, and roadmap A3.1c — **decided, not open**: a call returns a result
 * naming its failures, and the value is only reachable after the check.
 *
 * The alternative is a promise that rejects, and the reason it is not used here is that a rejection
 * is untyped. `catch (e)` gives `unknown` and every caller writes the same three lines to find out
 * what happened, or — far more often — writes none and finds out in production. A discriminated
 * union puts the failures in the signature, where the compiler can insist they were considered.
 *
 * This is deliberately *not* a general-purpose Result library. No `map`, no `andThen`, no chaining:
 * one narrow type used at one boundary, because the value of it is that `r.value` does not exist
 * until `r.ok` has been checked, and that survives no matter how small the type is.
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
export type TransportError =
    | { readonly kind: 'unauthorized' }
    | { readonly kind: 'forbidden' }
    | { readonly kind: 'not_found' }
    | { readonly kind: 'invalid'; readonly detail: string }
    | { readonly kind: 'conflict'; readonly detail: string }
    | { readonly kind: 'rate_limited'; readonly retryAfterMs?: number }
    | { readonly kind: 'server'; readonly status: number; readonly detail: string }
    | { readonly kind: 'offline'; readonly detail: string }
    | { readonly kind: 'stale'; readonly expected: string; readonly actual: string };

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
        case 'stale': return 'This page is out of date with the API. Reload.';
        case 'declared': return error.detail;
    }
}
