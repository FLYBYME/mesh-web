/**
 * The `net` capability: how an Application reaches its site's API.
 *
 * spec/network.md sections 1 and 4. The ergonomics are `ctx.call`'s — a string action, inferred
 * input, inferred output — because that is what the user asked for and because the mesh already
 * proves the shape works. What is different is what it crosses: this is HTTP to mesh-api, the only
 * security boundary in the system ([kernel §4](../../spec/kernel.md)), and it can 401.
 *
 * The browser never joins the mesh (§2). There is no transport to a peer here and there must not be.
 */

import type { AnyApiCall, Api, ActionOf, CallOf, InputOf, OutputOf, ErrorsOf } from './api.js';
import { toRequest } from './api.js';
import { diffExposure, fetchApiSpec, type FetchApiSpecOutcome } from './describe.js';
import { err, ok, type CallError, type ExposureDifference, type Result } from './result.js';

// ---------------------------------------------------------------------------- transport

export interface NetRequest {
    readonly url: string;
    readonly method: string;
    readonly body: string | undefined;
    readonly headers: Readonly<Record<string, string>>;
}

export interface NetResponse {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
}

/**
 * Where a request actually goes.
 *
 * An interface rather than `fetch` directly, for three reasons that all turned out to be the same
 * reason: a test needs no server, the auth Extension attaches a ticket by *wrapping* one of these
 * rather than by every Application handling a credential (§4), and a retry or a circuit breaker is
 * another wrapper rather than a flag.
 */
export interface Transport {
    send(request: NetRequest): Promise<NetResponse>;
}

/** The real one. Kept tiny; everything interesting is a wrapper around it. */
export function fetchTransport(origin = ''): Transport {
    return {
        async send(request: NetRequest): Promise<NetResponse> {
            const response = await fetch(`${origin}${request.url}`, {
                method: request.method,
                headers: request.headers,
                body: request.body,
                credentials: 'omit',
            });

            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

            return { status: response.status, headers, body: await response.text() };
        },
    };
}

/**
 * Attach headers to every request.
 *
 * This is how the auth Extension puts a ticket on the wire without any Application seeing one
 * (spec/network.md section 4). `headers` is a function because a ticket is refreshed, and a value
 * captured once would go stale in exactly the case that matters.
 */
export function withHeaders(inner: Transport, headers: () => Readonly<Record<string, string>>): Transport {
    return {
        send: (request) => inner.send({ ...request, headers: { ...request.headers, ...headers() } }),
    };
}

// ---------------------------------------------------------------------------- the client

/**
 * What `needs('mesh')` hands a contribution: one API's actions, and nothing else reachable.
 *
 * Named for the capability rather than for the transport under it. There is no `get`, no `post` and
 * no URL on this interface, because there is nowhere else to go — a call names an action on the API
 * the manifest declared, the way `ctx.call` does on a node ([network §2a](../../spec/network.md)).
 * The `Transport` above is the HTTP underneath; this is the thing a page is actually given.
 */
export interface MeshClient<A> {
    /** The API this client is scoped to. Present so a log line can say which one failed. */
    readonly api: string;
    /** The API descriptor this client was created from, if available at runtime. */
    readonly descriptor?: unknown;

    call<K extends ActionOf<A>>(
        action: K,
        ...input: InputOf<CallOf<A, K>> extends void ? [] : [input: InputOf<CallOf<A, K>>]
    ): Promise<Result<OutputOf<CallOf<A, K>>, CallError<ErrorsOf<CallOf<A, K>>>>>;
}

export interface ClientOptions {
    readonly transport: Transport;
    /**
     * Check the API's exposure hash against the one this client was generated from.
     *
     * On by default. spec/network.md section 6 — a client that describes a surface the API has moved
     * on from is a lie, and it is better to say so once than to fail confusingly later. Off for the
     * case where a site deploys the API and the client independently and accepts the window.
     */
    readonly checkExposure?: boolean;
}

export function createClient<TCalls extends Record<string, AnyApiCall>>(
    api: Api<TCalls>,
    options: ClientOptions,
): MeshClient<Api<TCalls>> {
    const check = options.checkExposure ?? true;
    let describePromise: Promise<Result<FetchApiSpecOutcome, CallError<string>>> | undefined;
    const diffCache = new Map<string, readonly ExposureDifference[]>();

    return {
        api: api.id,
        descriptor: api,

        async call(action, ...rest): Promise<Result<never, CallError<string>>> {
            const decl = api.calls[action];
            if (decl === undefined) {
                // Unreachable through the types; reachable through a hand-built bundle.
                return err({ kind: 'invalid', detail: `${api.id} does not expose "${action}"` });
            }

            const request = toRequest(api, decl, rest[0]);

            let response: NetResponse;
            try {
                response = await options.transport.send({
                    url: request.url,
                    method: request.method,
                    body: request.body,
                    headers: request.body === undefined ? {} : { 'content-type': 'application/json' },
                });
            } catch (cause) {
                return err({ kind: 'offline', detail: cause instanceof Error ? cause.message : String(cause) });
            }

            /**
             * The **shape** hash, not the gate hash.
             *
             * `x-exposure` is what a site exposes and at what level; a generated client cannot know
             * it, because a part declares what it calls and never the gate it runs at. Comparing
             * against it meant every gated site answered `stale` forever — the request succeeded,
             * the response arrived, and the client threw it away. Found on `console.localhost`,
             * where dev tools showed two successful requests and a view that never updated.
             *
             * `x-exposure-shape` is site-independent, which is the only thing a client generated
             * from a part's own descriptor can honestly be compared against.
             *
             * Both sides are optional: a client generated before D4 carries no `shapeHash`, and an
             * older API sends no header. Either absence skips the check rather than failing it —
             * an unverifiable client is weaker than a verified one and infinitely better than one
             * that refuses every call.
             */
            const reported = response.headers['x-exposure-shape'];
            if (check && reported !== undefined && api.shapeHash !== undefined
                && reported !== api.shapeHash) {
                let differences = diffCache.get(reported);
                if (differences === undefined) {
                    if (describePromise === undefined) {
                        const describePath = `${api.base.replace(/\/+$/, '')}/_describe`;
                        // Discovery request must NEVER send x-exposure-shape to prevent 409 deadlock
                        const discoveryTransport: Transport = {
                            send: (req) => {
                                const headers: Record<string, string> = {};
                                for (const [k, v] of Object.entries(req.headers)) {
                                    if (k.toLowerCase() !== 'x-exposure-shape') {
                                        headers[k] = v;
                                    }
                                }
                                return options.transport.send({ ...req, headers });
                            },
                        };
                        describePromise = fetchApiSpec({
                            transport: discoveryTransport,
                            path: describePath,
                        });
                    }
                    try {
                        const describeResult = await describePromise;
                        if (describeResult.ok && !describeResult.value.notModified) {
                            differences = diffExposure(api, describeResult.value.spec);
                            diffCache.set(reported, differences);
                        }
                    } catch {
                        // ignore discovery failures; differences remains undefined
                    } finally {
                        describePromise = undefined;
                    }
                }

                return err({
                    kind: 'stale',
                    expected: api.shapeHash,
                    actual: reported,
                    ...(differences !== undefined ? { differences } : {}),
                });
            }

            return interpret(response) as Result<never, CallError<string>>;
        },
    } as MeshClient<Api<TCalls>>;
}

/**
 * A response becomes a result.
 *
 * Status codes are mapped to named cases here and nowhere else, so a caller never sees a number and
 * never has to remember which number meant what.
 */
function interpret(response: NetResponse): Result<unknown, CallError<string>> {
    const parsed = parse(response.body);

    if (response.status >= 200 && response.status < 300) return ok(parsed.value);

    const body = parsed.value;

    // A declared failure says so. It is **not** inferred from the shape of the body, and that
    // distinction was found the hard way: the first time a real browser called a real API, every
    // 401 and 403 arrived here as a declared failure, because a gate refusal is also
    // `{ error: string, message: string }` and this used to read any such body as the site naming
    // its own error. Both sides were reasonable alone; they meant different things by one shape.
    //
    // The marker is explicit so a site can answer a declared failure with whatever status suits it
    // — 400, 409, 422 — and the caller still knows which kind of failure it has.
    if (isRecord(body) && body['declared'] === true && typeof body['error'] === 'string') {
        return err({
            kind: 'declared',
            name: body['error'],
            detail: typeof body['message'] === 'string' ? body['message'] : body['error'],
        });
    }

    // The API's own message where it sent one, so a 400 says which field was wrong rather than
    // handing the caller the raw body to parse a second time.
    const detail = isRecord(body) && typeof body['message'] === 'string'
        ? body['message']
        : typeof body === 'string' ? body : parsed.raw;

    switch (response.status) {
        case 400: return err({ kind: 'invalid', detail });
        case 401: return err({ kind: 'unauthorized' });
        case 403: return err({ kind: 'forbidden' });
        case 404: return err({ kind: 'not_found' });
        case 409: return err({ kind: 'conflict', detail });
        case 429: return err({ kind: 'rate_limited' });
        default: return err({ kind: 'server', status: response.status, detail });
    }
}

function parse(body: string): { readonly value: unknown; readonly raw: string } {
    if (body === '') return { value: undefined, raw: '' };
    try {
        return { value: JSON.parse(body), raw: body };
    } catch {
        return { value: body, raw: body };
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
