/**
 * The CDN — roadmap B4–B7, spec/hosting.md §1–§4.
 *
 * Over a real HTTP server, because most of what can go wrong is between the pieces: a content type
 * that makes a browser refuse a module, an ETag that never matches, a fallback that turns a missing
 * asset into an HTML page and a console error nobody can read.
 *
 * The one that matters most is B6, and it is a *serving-layer* invariant rather than a convention:
 * the origin is the isolation boundary, so two tenants on one hostname share storage, cookies and
 * the whole same-origin policy.
 */

import type { AddressInfo } from 'node:net';
import { request as httpRequest, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createCdn, normalizeHostname, pathOf, resolveFile, resolveMount, siteCache, TenantMismatch,
    type ArtifactSource, type SiteSource,
} from '../../server/cdn/src/index.js';
import { artifactDigest, contentTypeOf, digestOf } from '../../server/builder/src/index.js';
import type { Artifact, ArtifactFile, Site } from '../../server/protocol/src/index.js';

// ---------------------------------------------------------------------------- a built site

const fileOf = (path: string, content: string): { file: ArtifactFile; content: Buffer } => ({
    file: {
        path,
        digest: digestOf(content),
        size: Buffer.byteLength(content),
        contentType: contentTypeOf(path),
    },
    content: Buffer.from(content),
});

const built = [
    fileOf('index.html', '<!doctype html><title>Blog</title>'),
    fileOf('app.a1b2c3.js', 'console.log("app")'),
    fileOf('assets/style.css', 'body{margin:0}'),
    fileOf('about/index.html', '<!doctype html><title>About</title>'),
];

const artifact: Artifact = {
    digest: artifactDigest(built.map((b) => b.file)),
    files: built.map((b) => b.file),
    totalSize: built.reduce((n, b) => n + b.file.size, 0),
    builtAt: 0,
    buildId: 'b1',
};

/**
 * A second artifact, standing in for the shared kernel.
 *
 * Deliberately with **no `index.html`**: that is what makes a missing module 404 rather than being
 * answered with the site's page, which arrives in the console as `Unexpected token '<'`.
 */
const kernelFiles = [
    fileOf('index.js', 'export const kernel = 1'),
    fileOf('window/shell.js', 'export const shell = 1'),
];

const kernel: Artifact = {
    digest: artifactDigest(kernelFiles.map((b) => b.file)),
    files: kernelFiles.map((b) => b.file),
    totalSize: kernelFiles.reduce((n, b) => n + b.file.size, 0),
    builtAt: 0,
    buildId: 'k1',
};

const all = [...built, ...kernelFiles];

const artifacts: ArtifactSource = {
    async getArtifact(digest) {
        if (digest === artifact.digest) return artifact;
        return digest === kernel.digest ? kernel : undefined;
    },
    async getBlob(digest) { return all.find((b) => b.file.digest === digest)?.content; },
};

const site = (over: Partial<Site> = {}): Site => ({
    hostname: 'blog.example.com',
    application: 'blog',
    environment: 'production',
    tenantId: 'tenant-a',
    artifactDigest: artifact.digest,
    updatedAt: 0,
    ...over,
});

const sitesFrom = (records: readonly Site[]): SiteSource & { lookups: string[] } => {
    const lookups: string[] = [];
    return {
        lookups,
        async resolve(hostname) {
            lookups.push(hostname);
            return records.find((r) => r.hostname === hostname);
        },
    };
};

let servers: Server[] = [];

afterEach(async () => {
    for (const server of servers) await new Promise<void>((r) => server.close(() => r()));
    servers = [];
});

async function serve(options: Parameters<typeof createCdn>[0]): Promise<{ url: string; cdn: ReturnType<typeof createCdn> }> {
    const cdn = createCdn(options);
    const server = await cdn.listen(0, '127.0.0.1');
    servers.push(server);
    return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, cdn };
}

interface Reply {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
}

/**
 * A request with a `Host` header this test chose.
 *
 * `fetch` cannot do it: `Host` is a forbidden header name, and undici strips it **silently** — the
 * first version of this file used fetch and every request arrived as `127.0.0.1:port`, so every
 * lookup missed and every test failed with a 404 that had nothing to do with the code. `node:http`
 * sets it as given.
 */
async function fetchAs(
    url: string,
    path: string,
    host = 'blog.example.com',
    init: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }> {
    const reply = await request(url, path, host, init);
    return {
        status: reply.status,
        headers: { get: (name) => reply.headers[name.toLowerCase()] ?? null },
        text: async () => reply.body,
    };
}

function request(
    url: string,
    path: string,
    host = 'blog.example.com',
    init: { method?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
    const target = new URL(`${url}${path}`);

    return new Promise((resolve, reject) => {
        const req = httpRequest({
            hostname: target.hostname,
            port: target.port,
            path: `${target.pathname}${target.search}`,
            method: init.method ?? 'GET',
            headers: { host, ...(init.headers ?? {}) },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode ?? 0,
                headers: res.headers as Record<string, string>,
                body: Buffer.concat(chunks).toString(),
            }));
        });

        req.on('error', reject);
        req.end();
    });
}

// ---------------------------------------------------------------------------- serving

describe('a hostname is a site', () => {
    it('serves the entry document, with the types a browser needs', async () => {
        const { url } = await serve({ sites: sitesFrom([site()]), artifacts });

        const page = await fetchAs(url, '/');
        expect(page.status).toBe(200);
        expect(page.headers.get('content-type')).toContain('text/html');

        // A module served as text/plain is refused by the browser, and the request is still a 200 —
        // so the page simply does not run and nothing in the network tab says why.
        const script = await fetchAs(url, '/app.a1b2c3.js');
        expect(script.headers.get('content-type')).toContain('text/javascript');
        expect(await script.text()).toBe('console.log("app")');
    });

    it('404s a hostname nobody has configured', async () => {
        const { url } = await serve({ sites: sitesFrom([site()]), artifacts });
        expect((await fetchAs(url, '/', 'nobody.example.com')).status).toBe(404);
    });

    it('serves a directory index for a path with or without a slash', async () => {
        const { url } = await serve({ sites: sitesFrom([site()]), artifacts });

        expect(await (await fetchAs(url, '/about')).text()).toContain('About');
        expect(await (await fetchAs(url, '/about/')).text()).toContain('About');
    });

    it('falls back to the entry document for a client-routed path', async () => {
        const { url } = await serve({ sites: sitesFrom([site()]), artifacts });

        // A deep link into an Application that routes in the browser must get the Application.
        const deep = await fetchAs(url, '/posts/hello-world');
        expect(deep.status).toBe(200);
        expect(await deep.text()).toContain('<title>Blog</title>');
    });

    it('404s a missing asset instead of serving HTML in its place', async () => {
        const { url } = await serve({ sites: sitesFrom([site()]), artifacts });

        // The trap the fallback creates: serving index.html for a missing `.js` produces
        // "Unexpected token '<'" in the console and nothing that says what actually happened.
        expect((await fetchAs(url, '/missing.js')).status).toBe(404);
        expect((await fetchAs(url, '/assets/gone.css')).status).toBe(404);
    });

    it('refuses anything that would change state', async () => {
        const { url } = await serve({ sites: sitesFrom([site()]), artifacts });

        // A CDN serves. The API is the only security boundary; a CDN accepting a POST would be a
        // second one.
        const posted = await fetchAs(url, '/', 'blog.example.com', { method: 'POST' });
        expect(posted.status).toBe(405);
    });
});

describe('caching', () => {
    it('caches a hashed asset forever and the entry document never', async () => {
        const { url } = await serve({ sites: sitesFrom([site()]), artifacts });

        // A hashed name changes with its content, so it can be immutable. An entry document's name
        // does not, so caching it would mean a deploy never reaches anyone.
        expect((await fetchAs(url, '/app.a1b2c3.js')).headers.get('cache-control')).toContain('immutable');
        expect((await fetchAs(url, '/')).headers.get('cache-control')).toBe('no-cache');
    });

    it('answers a matching ETag with 304', async () => {
        const { url } = await serve({ sites: sitesFrom([site()]), artifacts });

        const first = await fetchAs(url, '/app.a1b2c3.js');
        const etag = first.headers.get('etag')!;
        expect(etag).toContain('sha256:');

        // The digest *is* the validator: a different byte would be a different digest, so a match
        // means the client holds exactly this content.
        const second = await fetchAs(url, '/app.a1b2c3.js', 'blog.example.com', { headers: { 'if-none-match': etag } });
        expect(second.status).toBe(304);
    });

    it('varies on Host, because one connection may ask for many sites', async () => {
        const { url } = await serve({ sites: sitesFrom([site()]), artifacts });
        expect((await fetchAs(url, '/')).headers.get('vary')).toBe('Host');
    });

    it('looks a hostname up once, and again after a deploy', async () => {
        const sites = sitesFrom([site()]);
        const { url, cdn } = await serve({ sites, artifacts });

        await fetchAs(url, '/');
        await fetchAs(url, '/');
        expect(sites.lookups).toHaveLength(1);

        // `cdn.site_changed`. The TTL underneath is a backstop, because the mesh delivers events
        // at-most-once — the same finding as auth §3.1, and just as true here.
        cdn.invalidate('blog.example.com');
        await fetchAs(url, '/');
        expect(sites.lookups).toHaveLength(2);
    });

    it('caches a miss, so an unknown hostname is not a lookup per request', async () => {
        const sites = sitesFrom([site()]);
        const { url } = await serve({ sites, artifacts });

        for (let i = 0; i < 5; i++) await fetchAs(url, '/', 'nobody.example.com');

        // Otherwise a node being asked for a hostname nobody configured does the mesh's work for
        // whoever is asking.
        expect(sites.lookups.filter((h) => h === 'nobody.example.com')).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------- isolation

describe('never two tenants from one hostname — B6', () => {
    it('refuses a site owned by another tenant, and does not explain', async () => {
        const onError = vi.fn();
        const { url } = await serve({
            sites: sitesFrom([site({ tenantId: 'tenant-b' })]),
            artifacts,
            tenantId: 'tenant-a',
            onError,
        });

        const response = await fetchAs(url, '/');

        // 404 rather than 403: which tenant owns a hostname is not something an anonymous request
        // gets to learn. The operator finds out through onError.
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain('tenant');
        expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(TenantMismatch);
    });

    it('does not let a caller choose its own hostname unless the deployment says so', async () => {
        // The origin is the isolation boundary, so which origin a request is for must not be the
        // caller's choice on a node that is reachable directly.
        const direct = await serve({ sites: sitesFrom([site()]), artifacts });
        const spoofed = await fetchAs(direct.url, '/', 'nobody.example.com', {
            headers: { 'x-forwarded-host': 'blog.example.com' },
        });
        expect(spoofed.status).toBe(404);

        // Behind the proxy (hosting §1) the header is authoritative, because the proxy rewrote Host
        // to reach this node and forwarded the original. That is a deployment fact, so it is a
        // deployment option rather than something the code guesses.
        const proxied = await serve({ sites: sitesFrom([site()]), artifacts, trustForwardedHost: true });
        const forwarded = await fetchAs(proxied.url, '/', 'cdn-node-7.internal', {
            headers: { 'x-forwarded-host': 'blog.example.com' },
        });
        expect(forwarded.status).toBe(200);
    });

    it('takes the client’s host from a forwarded chain, not an intermediary’s', async () => {
        const { url } = await serve({ sites: sitesFrom([site()]), artifacts, trustForwardedHost: true });

        // Two proxies deep. The first entry is the client's original host; anything else serves the
        // site belonging to a proxy.
        const chained = await fetchAs(url, '/', 'cdn-node-7.internal', {
            headers: { 'x-forwarded-host': 'blog.example.com, edge-3.internal' },
        });
        expect(chained.status).toBe(200);
    });

    it('serves normally when the tenant matches, and when the node serves many', async () => {
        const dedicated = await serve({ sites: sitesFrom([site()]), artifacts, tenantId: 'tenant-a' });
        expect((await fetchAs(dedicated.url, '/')).status).toBe(200);

        const shared = await serve({ sites: sitesFrom([site()]), artifacts });
        expect((await fetchAs(shared.url, '/')).status).toBe(200);
    });
});

// ---------------------------------------------------------------------------- any node

describe('any node can serve any site — B7', () => {
    it('is slower with a cold cache, not wrong', async () => {
        let artifactFetches = 0;
        const counting: ArtifactSource = {
            async getArtifact(digest) { artifactFetches += 1; return artifacts.getArtifact(digest); },
            getBlob: artifacts.getBlob,
        };

        const { url } = await serve({ sites: sitesFrom([site()]), artifacts: counting });

        await fetchAs(url, '/');
        await fetchAs(url, '/about');
        await fetchAs(url, '/app.a1b2c3.js');

        // Fetched once and kept: an artifact under one digest can never become a different
        // artifact, so caching it forever is safe rather than a risk anybody is taking.
        expect(artifactFetches).toBe(1);
    });

    it('says the cluster failed, not the caller, when content is unreachable', async () => {
        const { url } = await serve({
            sites: sitesFrom([site({ artifactDigest: 'sha256:not-here' })]),
            artifacts,
        });

        // The hostname *is* configured and the answer exists somewhere. A 404 would blame the
        // caller for a node that has not caught up.
        expect((await fetchAs(url, '/')).status).toBe(503);
    });
});

// ---------------------------------------------------------------------------- the pure bits

describe('resolution details', () => {
    it('treats one host spelled several ways as one site', () => {
        for (const host of ['Blog.Example.com', 'blog.example.com:443', 'blog.example.com.', ' blog.example.com ']) {
            expect(normalizeHostname(host)).toBe('blog.example.com');
        }
    });

    it('reads a path without its query, and survives bad encoding', () => {
        expect(pathOf('/a/b?c=d')).toBe('/a/b');
        expect(pathOf('/a%20b')).toBe('/a b');
        // Malformed encoding fails to match a file rather than throwing on the serving path.
        expect(pathOf('/a%zz')).toBe('/a%zz');
    });

    it('resolves exact, then index, then the entry document', () => {
        expect(resolveFile(artifact, '/index.html')?.path).toBe('index.html');
        expect(resolveFile(artifact, '/')?.path).toBe('index.html');
        expect(resolveFile(artifact, '/about')?.path).toBe('about/index.html');
        expect(resolveFile(artifact, '/anything/at/all')?.path).toBe('index.html');
        expect(resolveFile(artifact, '/missing.js')).toBeUndefined();
    });

    it('resolves a mounted artifact by longest prefix, on a segment boundary', () => {
        const mounted = site({
            mounts: [
                { at: '/framework', artifactDigest: kernel.digest },
                { at: '/framework/window', artifactDigest: 'sha256:deeper' },
            ],
        });

        // The site's own artifact answers everything unclaimed.
        expect(resolveMount(mounted, '/index.html')).toEqual({
            digest: artifact.digest, path: '/index.html',
        });

        // A mount answers under its prefix, with the prefix stripped.
        expect(resolveMount(mounted, '/framework/index.js')).toEqual({
            digest: kernel.digest, path: '/index.js',
        });

        // Longest wins, so a mount can sit inside another.
        expect(resolveMount(mounted, '/framework/window/shell.js')).toEqual({
            digest: 'sha256:deeper', path: '/shell.js',
        });

        // **A prefix matches a path segment, never a substring.** Otherwise adding a mount would
        // silently steal pages the site already served.
        expect(resolveMount(mounted, '/frameworks-of-the-world.html')).toEqual({
            digest: artifact.digest, path: '/frameworks-of-the-world.html',
        });

        // The mount point itself asks the mounted artifact for its root.
        expect(resolveMount(mounted, '/framework')).toEqual({ digest: kernel.digest, path: '/' });
    });

    it('serves the kernel from a mount and the page from the site, over real HTTP', async () => {
        const { url } = await serve({
            sites: sitesFrom([site({ mounts: [{ at: '/framework', artifactDigest: kernel.digest }] })]),
            artifacts,
        });

        const page = await fetchAs(url, '/');
        const module_ = await fetchAs(url, '/framework/index.js');

        expect(await page.text()).toContain('<title>Blog</title>');
        expect(await module_.text()).toBe('export const kernel = 1');
        // A module must arrive as one, or the browser refuses to execute it.
        expect(module_.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    });

    it('404s a missing module under a mount instead of answering with the page', async () => {
        // The failure this prevents reaches a developer as `Unexpected token '<'`, which says
        // nothing about what happened. `resolveFile`'s entry-document fallback applies within the
        // *mounted* artifact, and the kernel has no index.html — so the fallback finds nothing.
        const { url } = await serve({
            sites: sitesFrom([site({ mounts: [{ at: '/framework', artifactDigest: kernel.digest }] })]),
            artifacts,
        });

        const missing = await fetchAs(url, '/framework/not-a-module.js');

        expect(missing.status).toBe(404);
        expect(await missing.text()).not.toContain('<title>');
    });

    it('503s when a mounted artifact is not on this node, naming neither as a 404', async () => {
        const { url } = await serve({
            sites: sitesFrom([site({ mounts: [{ at: '/framework', artifactDigest: 'sha256:absent' }] })]),
            artifacts,
        });

        // The hostname is configured and the content exists somewhere: this node failing is not the
        // caller being wrong, and B7 says any node can fetch what it lacks.
        expect((await fetchAs(url, '/framework/index.js')).status).toBe(503);
        // The site's own artifact is unaffected — one missing mount does not take the page down.
        expect((await fetchAs(url, '/')).status).toBe(200);
    });

    it('shares one lookup between concurrent requests for a cold hostname', async () => {
        const sites = sitesFrom([site()]);
        const cache = siteCache({ source: sites });

        await Promise.all([
            cache.resolve('blog.example.com'),
            cache.resolve('blog.example.com'),
            cache.resolve('blog.example.com'),
        ]);

        // A burst on a cold node would otherwise be one mesh lookup per request, at exactly the
        // moment the node is busiest.
        expect(sites.lookups).toHaveLength(1);
    });
});
