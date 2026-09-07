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
/**
 * Who may call this, as data rather than as a comment.
 *
 * The generated client used to record the gate only inside a JSDoc line — `GET /parts — auth:
 * public` — and that text was **wrong**: the console's site declares `auth: 'user'` for every one
 * of its contracts and the server answers 401. Nothing could detect the drift, because the value was
 * not a value.
 *
 * mesh-serve's emitter now writes it as a literal, so a page can ask *does this need a session?*
 * before firing a request that is certain to fail — which is the whole point of
 * [schema-driven-ui §1](../../spec/schema-driven-ui.md).
 *
 * Optional, because a client generated before this existed carries none, and an older client must
 * keep compiling against a newer kernel.
 */
export type Gate =
    | { readonly kind: 'auth'; readonly level: 'public' | 'user' | 'admin' | 'operator' }
    | { readonly kind: 'permission'; readonly permission: string };

export interface ApiCall<TInput, TOutput, TErrors extends string = never> {
    readonly method: HttpMethod;
    readonly path: string;
    readonly gate?: Gate;
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
     * The **gate** hash this client was generated from: what a site exposes and at what level.
     *
     * Per site, and a generated client cannot know it. A part declares what it *calls*, never the
     * gate it runs at, so `mesh-serve client` writes `auth: 'public'` uniformly and this hash is
     * computed over that placeholder. Kept because `api.describe` reports the site's own and a
     * caller with site context can compare them; **it is not the staleness check.**
     */
    readonly exposure: string;
    /**
     * The **shape** hash: contracts, methods, paths, and request/response schemas. Site-independent
     * and gate-independent, so it is identical between this client and any API serving those shapes.
     *
     * **This is the staleness check** (spec/network.md section 6, roadmap D4). Comparing `exposure`
     * instead meant every gated site reported `stale` forever, because the two are computed over
     * different things and cannot match by construction — the calls succeeded on the wire and the
     * client discarded every result.
     *
     * Optional so a client generated before D4 keeps working: absent means the check is skipped,
     * which is weaker than checking and honest about it, rather than failing everything.
     */
    readonly shapeHash?: string;
    /** Prefix for every path, so a descriptor is portable between environments. */
    readonly base?: string;
    readonly calls: TCalls;
}

export interface Api<TCalls extends Record<string, AnyApiCall>> extends ApiSpec<TCalls> {
    readonly base: string;
}

/** Every action name this API serves. The union `cx.mesh.call` accepts. */
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
    gate?: Gate,
): ApiCall<TInput, TOutput, TErrors> {
    return gate === undefined ? { method, path } : { method, path, gate };
}

/**
 * Declare an API.
 *
 * `const` on the parameter keeps the call names as literals, which is what turns
 * `cx.mesh.call('resolver.query')` into a checked name rather than a string.
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
    const { path, consumed } = fillPath(c.path, input);
    const url = `${api.base}${path}`;

    if (c.method !== 'GET' && c.method !== 'DELETE') {
        return { url, method: c.method, body: input === undefined ? undefined : JSON.stringify(input) };
    }

    if (input === undefined || input === null) return { url, method: c.method, body: undefined };

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(input as Record<string, Json>)) {
        if (value === undefined || value === null) continue;
        // Already in the path. Repeating it in the query is noise, and the server takes the path
        // value regardless — `api.service.ts` merges path params last, deliberately.
        if (consumed.has(key)) continue;
        query.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }

    const q = query.toString();
    return { url: q === '' ? url : `${url}?${q}`, method: c.method, body: undefined };
}

/**
 * Put the input's values into the path's `:param` segments.
 *
 * **This was not done at all**, so `POST /sites/:host/deploy` was requested with `:host` still in
 * it, literally. No route matched, and the answer was a 404 that named a path no caller had written
 * — reported exactly that way. It was true of every parameterised call the console has: `part.get`,
 * `partVersion.get`, `release.get`, `site.get` and `cdn.deploy`. The consoles list with `find` and
 * pick client-side, so five broken calls sat behind screens that never made them.
 *
 * The value stays in the body for a body-carrying method. That is not laziness: the server merges
 * path params **last** and says why — *"a route with `:id` in the path and `id` in the body is a
 * caller trying to act on one record through another's URL, and the URL is the one the router and
 * the gate agreed on."* So the path wins either way, and sending both cannot disagree.
 *
 * A missing value **throws**, rather than sending `:host` and letting the server answer 404. The
 * whole reason this took a bug report is that the failure looked like a routing problem on the
 * server instead of a missing argument on the client.
 */
function fillPath(path: string, input: unknown): { path: string; consumed: ReadonlySet<string> } {
    if (!path.includes(':')) return { path, consumed: new Set() };

    const values = (input ?? {}) as Record<string, Json>;
    const consumed = new Set<string>();

    const filled = path.split('/').map((segment) => {
        if (!segment.startsWith(':')) return segment;

        const name = segment.slice(1);
        const value = values[name];

        if (value === undefined || value === null) {
            throw new Error(
                `The call to ${path} needs "${name}" and the input does not have it. Without it the `
                + `request would ask for "${segment}" literally, which matches no route and answers `
                + `404 as though the endpoint did not exist.`,
            );
        }

        consumed.add(name);
        return encodeURIComponent(typeof value === 'object' ? JSON.stringify(value) : String(value));
    }).join('/');

    return { path: filled, consumed };
}
