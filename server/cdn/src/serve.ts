/**
 * The CDN server — roadmap B4, spec/hosting.md §1 and §2.
 *
 * Plain HTTP, no TLS, no certificates: it sits behind the surfdns proxy, which is where TLS
 * terminates. A CDN node that managed its own certificates would be a second certificate authority
 * to operate, for no benefit, on ten machines.
 *
 * **Small, stateless, many, everywhere** (§3). What it holds between requests is a site cache and
 * whatever artifact bytes it happens to have fetched — both derivable, both discardable, neither
 * making one node different from another.
 */

import type { Artifact, ArtifactFile } from '@flybyme/mesh-web-protocol';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';

import { assertTenant, normalizeHostname, siteCache, TenantMismatch, type SiteCache, type SiteSource } from './sites.js';

/**
 * Where the bytes come from when this node does not have them.
 *
 * The builder owns `artifact`, so this is `builder.artifact_get` over the mesh — one hop, paid once
 * per artifact per node, because content addressed by hash is cacheable forever.
 */
export interface ArtifactSource {
    getArtifact(digest: string): Promise<Artifact | undefined>;
    getBlob(digest: string): Promise<Buffer | undefined>;
}

export interface CdnOptions {
    readonly sites: SiteSource;
    readonly artifacts: ArtifactSource;
    /**
     * Which tenant this node is permitted to serve, if it is dedicated to one.
     *
     * Absent means a shared node serving many. Present means the invariant in `assertTenant` has
     * something to check against — B6.
     */
    readonly tenantId?: string;
    readonly siteTtlMs?: number;
    readonly onError?: (error: unknown, context: { readonly hostname: string; readonly path: string }) => void;
    readonly now?: () => number;
    /**
     * Take the hostname from `x-forwarded-host` when it is present.
     *
     * **Off by default, and it has to be a decision.** spec/hosting.md §1 puts this behind the
     * surfdns proxy — plain HTTP, no TLS — which means the proxy rewrites `Host` to reach the node
     * and forwards the original here. In that deployment the header is authoritative.
     *
     * A node reachable *directly* must not trust it: a caller could then name any hostname and be
     * served whatever that hostname serves. That is public content either way, so it is not a
     * disclosure — but it makes the origin a caller's choice, and the origin is the isolation
     * boundary (§3). So the deployment says whether it is behind a proxy; the code does not guess.
     */
    readonly trustForwardedHost?: boolean;
}

export interface CdnServer {
    readonly sites: SiteCache;
    handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
    listen(port: number, host?: string): Promise<Server>;
    /** A deploy happened for this hostname. From `cdn.site_changed`. */
    invalidate(hostname: string): void;
}

export function createCdn(options: CdnOptions): CdnServer {
    const onError = options.onError ?? (() => {});
    const sites = siteCache({
        source: options.sites,
        ...(options.siteTtlMs === undefined ? {} : { ttlMs: options.siteTtlMs }),
        ...(options.now === undefined ? {} : { now: options.now }),
    });

    /** Artifact manifests this node has seen. The bytes are cached by the store beneath. */
    const manifests = new Map<string, Artifact>();

    const artifactFor = async (digest: string): Promise<Artifact | undefined> => {
        const held = manifests.get(digest);
        if (held !== undefined) return held;

        const fetched = await options.artifacts.getArtifact(digest);
        // Cached forever, and safely: the digest *is* the content, so an artifact under one digest
        // can never become a different artifact.
        if (fetched !== undefined) manifests.set(digest, fetched);
        return fetched;
    };

    const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        const hostname = normalizeHostname(hostOf(req, options.trustForwardedHost ?? false));
        const path = pathOf(req.url ?? '/');

        try {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                // A CDN serves. Anything that changes state goes to the API, which is the only
                // security boundary — a CDN accepting a POST would be a second one.
                return send(res, 405, { allow: 'GET, HEAD' }, 'Method not allowed');
            }

            const site = await sites.resolve(hostname);
            if (site === undefined) {
                return send(res, 404, {}, 'No site is configured for this hostname.');
            }

            // B6. Checked here, on the path that serves, rather than assumed by the path that
            // configures — the origin is the isolation boundary and this is where an origin is
            // decided.
            assertTenant(hostname, site, options.tenantId);

            const artifact = await artifactFor(site.artifactDigest);
            if (artifact === undefined) {
                // The site record points at content this node cannot get. Not a 404: the hostname is
                // configured and the answer exists somewhere, so this is the cluster failing rather
                // than the caller being wrong.
                return send(res, 503, {}, 'That site’s content is not available from this node yet.');
            }

            const file = resolveFile(artifact, path);
            if (file === undefined) {
                return send(res, 404, {}, 'Not found');
            }

            // The digest is the whole validator: an `If-None-Match` that matches means the client
            // holds this exact content, because a different byte would be a different digest.
            const etag = `"${file.digest}"`;
            if (req.headers['if-none-match'] === etag) {
                return send(res, 304, { etag }, '');
            }

            const body = await options.artifacts.getBlob(file.digest);
            if (body === undefined) {
                return send(res, 503, {}, 'That file is not available from this node yet.');
            }

            send(res, 200, {
                'content-type': file.contentType,
                etag,
                // A hashed asset can be cached forever; an entry document must not be, or a deploy
                // would never reach anyone. The difference is whether the *name* changes with the
                // content, and only the build knows that — so the rule is on the path, not the file.
                'cache-control': isEntryDocument(file.path)
                    ? 'no-cache'
                    : 'public, max-age=31536000, immutable',
                'x-artifact': artifact.digest,
            }, req.method === 'HEAD' ? '' : body);
        } catch (error) {
            onError(error, { hostname, path });

            if (error instanceof TenantMismatch) {
                // Refused, and deliberately not explained: which tenant owns a hostname is not
                // something an anonymous request gets to learn.
                return send(res, 404, {}, 'Not found');
            }

            send(res, 500, {}, 'Internal error');
        }
    };

    return {
        sites,
        handle,
        invalidate: (hostname) => sites.invalidate(hostname),
        listen(port, host = '0.0.0.0') {
            const server = createServer((req, res) => void handle(req, res));
            return new Promise((resolve, reject) => {
                server.listen(port, host, () => resolve(server));
                server.once('error', reject);
            });
        },
    };
}

/**
 * Which hostname this request is for.
 *
 * `x-forwarded-host` can carry a list when a request passed through more than one proxy. The
 * **first** entry is the client's original host and the rest are intermediaries, so anything else
 * would serve the site belonging to a proxy rather than to the caller.
 */
export function hostOf(req: IncomingMessage, trustForwarded: boolean): string {
    if (trustForwarded) {
        const forwarded = req.headers['x-forwarded-host'];
        const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
        const first = value?.split(',')[0]?.trim();
        if (first !== undefined && first !== '') return first;
    }
    return req.headers.host ?? '';
}

// ---------------------------------------------------------------------------- paths

/** The path, without a query string and percent-decoded. Never a filesystem path. */
export function pathOf(url: string): string {
    const [raw] = url.split('?');
    try {
        return decodeURIComponent(raw ?? '/');
    } catch {
        // Malformed encoding. Left as-is so it simply fails to match a file, rather than throwing.
        return raw ?? '/';
    }
}

/**
 * Which file in the artifact answers this path.
 *
 * Three rules, in order, and the third is what makes a single-page Application work:
 *
 * 1. an exact match
 * 2. a directory index — `/about` and `/about/` both mean `about/index.html`
 * 3. **the entry document**, for anything else, so a deep link into a client-routed app is served
 *    the app rather than a 404
 *
 * Rule 3 does not apply to anything that looks like an asset. A missing `app.js` must 404: serving
 * HTML in its place produces "Unexpected token '<'" in the console and nothing that says what
 * actually happened.
 */
export function resolveFile(artifact: Artifact, path: string): ArtifactFile | undefined {
    const clean = path.replace(/^\/+/, '');
    const byPath = new Map(artifact.files.map((f) => [f.path, f]));

    const exact = byPath.get(clean);
    if (exact !== undefined) return exact;

    const index = byPath.get(clean === '' ? 'index.html' : `${clean.replace(/\/+$/, '')}/index.html`);
    if (index !== undefined) return index;

    // An asset request is answered honestly or not at all.
    if (/\.[a-z0-9]+$/i.test(clean)) return undefined;

    return byPath.get('index.html');
}

const isEntryDocument = (path: string): boolean =>
    path === 'index.html' || path.endsWith('/index.html');

function send(
    res: ServerResponse,
    status: number,
    headers: Readonly<Record<string, string>>,
    body: string | Buffer,
): void {
    res.writeHead(status, {
        // The proxy in front may serve many sites from one connection; a cache between here and a
        // browser must key on the hostname it was asked for.
        vary: 'Host',
        ...headers,
    });
    res.end(body === '' ? undefined : body);
}
