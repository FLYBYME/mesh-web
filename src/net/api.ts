/**
 * A declared API: the shape the generator emits.
 *
 * spec/network.md section 4. Three decisions from section 3 are load-bearing here, and each one is
 * visible in the types rather than described in a comment:
 *
 * - **Structural types, never `z.infer` across a package boundary** (§3.1, surfdns #15). A generated
 *   file states the shapes it means. It does not reach into another package's schema objects and
 *   infer them, because that couples two builds and breaks on a zod version bump.
 * - **Scoped, not global** (§3.2). An API is a value an Application declares in its manifest. There
 *   is no `declare global`, so two Applications may talk to two APIs and neither can shadow the
 *   other.
 * - **Only what is exposed** (§3.3). The descriptor names the calls the site actually exposes, so
 *   calling something the API does not serve is a compile error rather than a 404 at run time.
 *
 * Everything here is written by hand today and generated tomorrow (roadmap A3.1a). That order is
 * deliberate: the emitter needs a target, and this is the target.
 */

import type { Json } from '../description/types.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * One call.
 *
 * `types` is a phantom: it is never present at run time, and it exists so that the input, output and
 * declared failures travel with the value. The alternative — a separate type map beside the runtime
 * table — lets the two drift, and a generator that emits two things which must agree will eventually
 * emit two things that do not.
 */
export interface ApiCall<TInput, TOutput, TErrors extends string = never> {
    readonly method: HttpMethod;
    readonly path: string;
    /** Never assigned. Present only so the compiler carries the shapes. */
    readonly types?: {
        readonly input: TInput;
        readonly output: TOutput;
        readonly errors: TErrors;
    };
}

/**
 * The constraint used wherever a call's parameters do not matter.
 *
 * Deliberately *not* `ApiCall<any, any, any>`: `any` in a constraint spreads to the inferred types
 * and takes the checking with it (spec/type-safety.md section 2). This names only the runtime
 * members, so `infer` can still recover the phantom shapes from the concrete type.
 */
export interface AnyApiCall {
    readonly method: HttpMethod;
    readonly path: string;
}

export type InputOf<C> = C extends ApiCall<infer I, infer _O, infer _E> ? I : never;
export type OutputOf<C> = C extends ApiCall<infer _I, infer O, infer _E> ? O : never;
export type ErrorsOf<C> = C extends ApiCall<infer _I, infer _O, infer E> ? E : never;

/**
 * A call takes no input, in the type rather than by convention.
 *
 * `void` rather than `undefined` so that `call('session.whoami')` needs no second argument, and
 * `never` is not used because a `never` parameter cannot be satisfied at all.
 */
export type NoInput = void;

// ---------------------------------------------------------------------------- the descriptor

export interface ApiSpec<TCalls extends Record<string, AnyApiCall>> {
    /** Names the API a call is scoped to. Appears in errors and in the manifest. */
    readonly id: string;
    /**
     * The exposure hash this client was generated from.
     *
     * spec/network.md section 6: the API reports its own, and a mismatch means this client is
     * describing a surface that has changed. Carried here so the check needs no configuration.
     */
    readonly exposure: string;
    /** Prefix for every path, so a descriptor is portable between environments. */
    readonly base?: string;
    readonly calls: TCalls;
}

export interface Api<TCalls extends Record<string, AnyApiCall>> extends ApiSpec<TCalls> {
    readonly base: string;
}

/** Every action name this API serves. The union `cx.net.call` accepts. */
export type ActionOf<A> = A extends Api<infer C> ? keyof C & string : never;

/** One call, by name. */
export type CallOf<A, K extends string> = A extends Api<infer C> ? (K extends keyof C ? C[K] : never) : never;

// ---------------------------------------------------------------------------- construction

/**
 * Declare one call.
 *
 * Written as a function with explicit type arguments rather than an object literal plus a cast,
 * because a cast is exactly the escape hatch the type-safety standard exists to close: it would let
 * a generator emit a shape that does not match its own descriptor and nothing would notice.
 */
export function call<TInput, TOutput, TErrors extends string = never>(
    method: HttpMethod,
    path: string,
): ApiCall<TInput, TOutput, TErrors> {
    return { method, path };
}

/**
 * Declare an API.
 *
 * `const` on the parameter keeps the call names as literals, which is what turns
 * `cx.net.call('resolver.query')` into a checked name rather than a string.
 */
export function defineApi<const TCalls extends Record<string, AnyApiCall>>(
    spec: ApiSpec<TCalls>,
): Api<TCalls> {
    return { base: '/api', ...spec };
}

// ---------------------------------------------------------------------------- request shapes

/**
 * How an input becomes a request.
 *
 * A `GET` puts its input in the query string and a body-carrying method puts it in the body. Stated
 * once here so a generated descriptor does not have to say it per call, and so the two sides cannot
 * disagree about where the arguments went.
 */
export function toRequest(api: Api<Record<string, AnyApiCall>>, c: AnyApiCall, input: unknown): {
    readonly url: string;
    readonly method: HttpMethod;
    readonly body: string | undefined;
} {
    const url = `${api.base}${c.path}`;

    if (c.method !== 'GET' && c.method !== 'DELETE') {
        return { url, method: c.method, body: input === undefined ? undefined : JSON.stringify(input) };
    }

    if (input === undefined || input === null) return { url, method: c.method, body: undefined };

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input as Record<string, Json>)) {
        if (value === undefined || value === null) continue;
        query.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }

    const q = query.toString();
    return { url: q === '' ? url : `${url}?${q}`, method: c.method, body: undefined };
}
