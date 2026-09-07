/**
 * Runtime exposure descriptor fetching.
 *
 * spec/schema-driven-ui.md §1 and §3.1. Obtains an ApiSpec from a live site's `GET /api/_describe`
 * endpoint rather than only from build-time generated code.
 *
 * Structural types throughout, never z.infer across a package boundary (spec/network.md §3.1).
 * Carries shapeHash (never exposure hash) for staleness checking (net/client.ts:154).
 * Never sends `x-exposure-shape` on the discovery request, avoiding recovery deadlock.
 */

import type { AnyApiCall, ApiSpec, HttpMethod } from './api.js';
import type { NetResponse, Transport } from './client.js';
import { fetchTransport } from './client.js';
import { err, ok, type CallError, type Result } from './result.js';

/**
 * One exposed call as reported by `GET /api/_describe`.
 */
export interface DescribedCall {
    readonly key: string;
    readonly domain?: string;
    readonly action?: string;
    readonly description?: string;
    readonly method: string;
    readonly path: string;
    readonly gate?: string;
    readonly input?: unknown;
    readonly output?: unknown;
    readonly destructive?: boolean;
    readonly stream?: boolean;
    readonly errors?: readonly string[];
}

/**
 * The descriptor payload returned by `GET /api/_describe`.
 */
export interface ExposureDescriptor {
    readonly application?: string;
    readonly host?: string;
    readonly base?: string;
    readonly exposure?: string;
    readonly shapeHash?: string;
    readonly calls: readonly DescribedCall[];
}

/**
 * An ApiCall augmented with runtime schema and contract metadata.
 */
export interface DescribedApiCall extends AnyApiCall {
    readonly key: string;
    readonly description?: string;
    readonly gate?: string;
    readonly destructive?: boolean;
    readonly stream?: boolean;
    readonly errors?: readonly string[];
    readonly input?: unknown;
    readonly output?: unknown;
}

export function toHttpMethod(method: string): HttpMethod {
    switch (method.toUpperCase()) {
        case 'GET': return 'GET';
        case 'POST': return 'POST';
        case 'PUT': return 'PUT';
        case 'PATCH': return 'PATCH';
        case 'DELETE': return 'DELETE';
        default: return 'GET';
    }
}

/**
 * Convert an ExposureDescriptor into a typed ApiSpec.
 */
export function toApiSpec(descriptor: ExposureDescriptor): ApiSpec<Record<string, DescribedApiCall>> {
    const calls: Record<string, DescribedApiCall> = {};
    for (const c of descriptor.calls ?? []) {
        calls[c.key] = {
            method: toHttpMethod(c.method),
            path: c.path,
            key: c.key,
            ...(c.description !== undefined ? { description: c.description } : {}),
            ...(c.gate !== undefined ? { gate: c.gate } : {}),
            ...(c.destructive !== undefined ? { destructive: c.destructive } : {}),
            ...(c.stream !== undefined ? { stream: c.stream } : {}),
            ...(c.errors !== undefined ? { errors: c.errors } : {}),
            ...(c.input !== undefined ? { input: c.input } : {}),
            ...(c.output !== undefined ? { output: c.output } : {}),
        };
    }

    return {
        id: descriptor.application ?? descriptor.host ?? 'api',
        base: descriptor.base ?? '/api',
        exposure: descriptor.exposure ?? '',
        shapeHash: descriptor.shapeHash,
        calls,
    };
}

export interface FetchApiSpecOptions {
    readonly transport?: Transport;
    readonly origin?: string;
    readonly path?: string;
    readonly etag?: string;
}

export type FetchApiSpecOutcome =
    | { readonly notModified: true; readonly etag?: string; readonly spec?: undefined }
    | { readonly notModified: false; readonly spec: ApiSpec<Record<string, DescribedApiCall>>; readonly etag?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function interpretError(response: NetResponse): Result<never, CallError<string>> {
    let body: unknown;
    try {
        body = response.body ? JSON.parse(response.body) : undefined;
    } catch {
        body = response.body;
    }

    if (isRecord(body) && body['declared'] === true && typeof body['error'] === 'string') {
        return err({
            kind: 'declared',
            name: body['error'],
            detail: typeof body['message'] === 'string' ? body['message'] : body['error'],
        });
    }

    const detail = isRecord(body) && typeof body['message'] === 'string'
        ? body['message']
        : typeof body === 'string' ? body : response.body;

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

function isDescribedCall(value: unknown): value is DescribedCall {
    if (!isRecord(value)) return false;
    return typeof value['key'] === 'string'
        && typeof value['method'] === 'string'
        && typeof value['path'] === 'string';
}

function isExposureDescriptor(value: unknown): value is ExposureDescriptor {
    if (!isRecord(value)) return false;
    if (!Array.isArray(value['calls'])) return false;
    return value['calls'].every(isDescribedCall);
}

/**
 * Fetch the exposure descriptor from a live API and construct an ApiSpec.
 *
 * Never sends `x-exposure-shape` on this request to prevent recovery deadlock.
 */
export async function fetchApiSpec(
    options: FetchApiSpecOptions = {},
): Promise<Result<FetchApiSpecOutcome, CallError<string>>> {
    const transport = options.transport ?? fetchTransport(options.origin ?? '');
    const path = options.path ?? '/api/_describe';

    const headers: Record<string, string> = {
        accept: 'application/json',
    };
    if (options.etag !== undefined) {
        headers['if-none-match'] = options.etag;
    }

    let response: NetResponse;
    try {
        response = await transport.send({
            url: path,
            method: 'GET',
            body: undefined,
            headers,
        });
    } catch (cause) {
        return err({ kind: 'offline', detail: cause instanceof Error ? cause.message : String(cause) });
    }

    const responseEtag = response.headers['etag'];

    if (response.status === 304) {
        return ok({
            notModified: true,
            etag: responseEtag ?? options.etag,
        });
    }

    if (response.status >= 200 && response.status < 300) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(response.body);
        } catch {
            return err({
                kind: 'server',
                status: response.status,
                detail: `Failed to parse exposure descriptor: ${response.body}`,
            });
        }

        if (!isExposureDescriptor(parsed)) {
            return err({
                kind: 'server',
                status: response.status,
                detail: 'Exposure descriptor payload is missing required fields (e.g. calls)',
            });
        }

        const spec = toApiSpec(parsed);
        return ok({
            notModified: false,
            spec,
            etag: responseEtag,
        });
    }

    return interpretError(response);
}
