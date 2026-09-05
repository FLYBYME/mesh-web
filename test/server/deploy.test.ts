/**
 * Push a repo; serve it from a hostname. Roadmap M3, and the first time any of it runs together.
 *
 * Everything below this file has been tested against something it could not disagree with: the
 * builder against a fetcher that wrote files into a directory, the CDN against an `ArtifactSource`
 * made of two `Map` lookups, and the two modules against nothing at all. That is the same gap
 * mesh-api closed at C3.1b, and it is worth closing the same way — with the real thing.
 *
 * So: a **real git repository** on disk (with a `mesh.json` nobody in the test parses), a real
 * `MeshApp` with the builder and CDN registered as modules, a real clone, a real `sh -c` build, a
 * real port, and a real HTTP GET carrying a `Host` header. The only thing faked is the network
 * between the two modules, and that is faked by being absent — one process, which is what M3 says.
 *
 * What this proves that the unit tests cannot:
 *
 * - the descriptor in the repo is what decides the hostname (B8) — the test never passes one
 * - `build_start` → `cdn.site_put` is a real mesh call across a module boundary (B1a, B1b)
 * - the CDN reads artifact bytes through the builder's published contract (B1c), over the broker
 * - a second build of the same commit rebuilds nothing (B2)
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { BrokerModule, MeshApp, RegistryModule } from '@flybyme/mesh';
import type { IServiceBroker } from '@flybyme/mesh';
import { afterEach, describe, expect, it } from 'vitest';

import { createBuilderModule, type BuilderModule } from '../../server/builder/src/index.js';
import { createCdnModule, type CdnModule } from '../../server/cdn/src/index.js';
import type { Build, Site } from '../../server/protocol/src/index.js';

const run = promisify(execFile);

// ---------------------------------------------------------------------------- a repository

/** What the site declares about itself. The test never reads this back; the builder does. */
// B8b's shape. This fixture used to carry `build` inside each environment, identical in both —
// which is exactly the duplication that moved it out to `ui`.
const DESCRIPTOR = {
    application: 'blog',
    ui: { build: 'sh ./build.sh', output: 'dist' },
    environments: {
        production: {
            host: 'blog.example.com',
            api: 'https://api.example.com',
            policy: { 'window-manager/mode': 'tiled' },
        },
        preview: {
            host: 'preview.blog.example.com',
            api: 'https://api.example.com',
        },
    },
};

const BUILD_SCRIPT = [
    '#!/bin/sh',
    'set -e',
    'mkdir -p dist/assets',
    // The environment the builder hands a build. A site bakes its API origin in without the builder
    // knowing what an API is, and this is the assertion that it actually arrives.
    'printf \'<!doctype html><title>Blog</title><script src="/assets/app.js"></script>\' > dist/index.html',
    'printf \'window.API=%s\' "$MESH_API" > dist/assets/app.js',
    '',
].join('\n');

const temporary: string[] = [];

/** A git repository with one commit, on disk, reachable by path. */
async function repository(descriptor: unknown = DESCRIPTOR): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mesh-repo-'));
    temporary.push(dir);

    await writeFile(join(dir, 'mesh.json'), JSON.stringify(descriptor, null, 2));
    await writeFile(join(dir, 'build.sh'), BUILD_SCRIPT);

    await run('git', ['init', '--quiet', '--initial-branch', 'main'], { cwd: dir });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await run('git', ['config', 'user.name', 'Test'], { cwd: dir });
    // The builder fetches a *commit*, because a branch hashes to itself while the code moves. Git
    // refuses to serve an arbitrary sha to a fetch unless the repository allows it, and a real
    // forge does; a bare local repository has to be told.
    await run('git', ['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: dir });

    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', ['commit', '--quiet', '-m', 'the site'], { cwd: dir });

    return dir;
}

// ---------------------------------------------------------------------------- a cluster

interface Cluster {
    readonly app: MeshApp;
    readonly builder: BuilderModule;
    readonly cdn: CdnModule;
    readonly url: string;
    call<T>(tool: string, params: unknown): Promise<T>;
    stop(): Promise<void>;
}

let clusters: Cluster[] = [];

afterEach(async () => {
    for (const cluster of clusters) await cluster.stop();
    clusters = [];
    for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function boot(options: { tenantId?: string } = {}): Promise<Cluster> {
    const app = new MeshApp({
        nodeID: `node-${String(Math.random()).slice(2, 8)}`,
        namespace: 'mesh-web-deploy-test',
    });
    app.use(new RegistryModule());
    app.use(new BrokerModule());
    await app.start();

    // After `start()`, never before: `MeshApp.registerModule` queues into `pendingModules` and that
    // flush is unawaited, so a module registered early may not be ready when the first call lands.
    const builder = createBuilderModule({ onError: () => {} });
    await app.registerModule(builder);

    const cdn = createCdnModule({
        port: 0,
        host: '127.0.0.1',
        ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
        onError: () => {},
    });
    await app.registerModule(cdn);

    const address = cdn.listener?.address() as AddressInfo;

    const cluster: Cluster = {
        app,
        builder,
        cdn,
        url: `http://127.0.0.1:${String(address.port)}`,
        call: <T,>(tool: string, params: unknown): Promise<T> =>
            (app as unknown as { call(t: string, p: unknown): Promise<T> }).call(tool, params),
        async stop() {
            await cdn.onStop?.(undefined as unknown as IServiceBroker);
            await app.stop();
        },
    };

    clusters.push(cluster);
    return cluster;
}

interface Deployed {
    readonly build: Build;
    readonly cached: boolean;
    readonly hostname?: string;
}

const deploy = (cluster: Cluster, repo: string, over: Record<string, unknown> = {}): Promise<Deployed> =>
    cluster.call<Deployed>('builder.build_start', {
        source: { kind: 'git', repository: repo, ref: 'main' },
        environment: 'production',
        publish: true,
        tenantId: 'tenant-a',
        ...over,
    });

/**
 * A GET with a `Host` this test chose.
 *
 * `fetch` cannot: `Host` is a forbidden header name and undici strips it silently, so every request
 * would arrive as `127.0.0.1:port` and every lookup would miss.
 */
function get(url: string, path: string, host: string): Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}> {
    const target = new URL(`${url}${path}`);

    return new Promise((resolve, reject) => {
        const req = httpRequest({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            method: 'GET',
            headers: { host },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString(),
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

// ---------------------------------------------------------------------------- the tests

describe('a repository becomes a site on a hostname', () => {
    it('builds what the repo declares and serves it under the host the repo named', async () => {
        const repo = await repository();
        const cluster = await boot();

        const deployed = await deploy(cluster, repo);

        expect(deployed.build.state).toBe('succeeded');
        // Nothing in this test passed a hostname or an application name. Both came out of the
        // repository's own descriptor, which is the whole of B8.
        expect(deployed.build.application).toBe('blog');
        expect(deployed.hostname).toBe('blog.example.com');

        const page = await get(cluster.url, '/', 'blog.example.com');
        expect(page.status).toBe(200);
        expect(page.body).toContain('<title>Blog</title>');
        expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
        // The digest the CDN served, so a deploy can be traced back to a build without a log.
        expect(page.headers['x-artifact']).toBe(deployed.build.artifactDigest);
    }, 60_000);

    it('hands the build the environment it is being built for', async () => {
        const repo = await repository();
        const cluster = await boot();
        await deploy(cluster, repo);

        const asset = await get(cluster.url, '/assets/app.js', 'blog.example.com');

        expect(asset.status).toBe(200);
        // Written by the build script from $MESH_API, which the builder set from the descriptor.
        expect(asset.body).toBe('window.API=https://api.example.com');
        expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    }, 60_000);

    it('serves an unknown hostname nothing at all', async () => {
        const repo = await repository();
        const cluster = await boot();
        await deploy(cluster, repo);

        const page = await get(cluster.url, '/', 'nobody.example.com');
        expect(page.status).toBe(404);
    }, 60_000);

    it('deploys the environment it was asked for, not the first one declared', async () => {
        const repo = await repository();
        const cluster = await boot();

        const deployed = await deploy(cluster, repo, { environment: 'preview' });

        expect(deployed.hostname).toBe('preview.blog.example.com');
        expect((await get(cluster.url, '/', 'preview.blog.example.com')).status).toBe(200);
        // The production host was never published, so it is not merely unbuilt — it is unserved.
        expect((await get(cluster.url, '/', 'blog.example.com')).status).toBe(404);
    }, 60_000);
});

describe('the modules talk to each other over the mesh', () => {
    it('records the deploy on the cdn, not on the builder', async () => {
        const repo = await repository();
        const cluster = await boot();
        const deployed = await deploy(cluster, repo);

        // `site` is the CDN's. The builder wrote it by calling `cdn.site_put`, which is the one hop
        // B1c's rule costs and the reason neither module imports the other.
        const { site } = await cluster.call<{ site: Site }>('cdn.site_resolve', {
            hostname: 'blog.example.com',
        });

        expect(site.application).toBe('blog');
        expect(site.environment).toBe('production');
        expect(site.tenantId).toBe('tenant-a');
        expect(site.artifactDigest).toBe(deployed.build.artifactDigest);
    }, 60_000);

    it('reads artifact bytes through the builder and then stops asking', async () => {
        const repo = await repository();
        const cluster = await boot();
        await deploy(cluster, repo);

        await get(cluster.url, '/', 'blog.example.com');
        const after = await cluster.call<{ cachedArtifacts: number }>('cdn.status', {});
        expect(after.cachedArtifacts).toBe(1);

        // The digest *is* the content, so a second request is answered from the node. A CDN that
        // paid a mesh hop per request would not be small, stateless, many and everywhere.
        await get(cluster.url, '/', 'blog.example.com');
        const again = await cluster.call<{ cachedArtifacts: number }>('cdn.status', {});
        expect(again.cachedArtifacts).toBe(1);
    }, 60_000);

    it('answers a conditional request without sending the body again', async () => {
        const repo = await repository();
        const cluster = await boot();
        await deploy(cluster, repo);

        const first = await get(cluster.url, '/assets/app.js', 'blog.example.com');
        const etag = first.headers['etag'];
        expect(typeof etag).toBe('string');

        const second = await new Promise<number>((resolve, reject) => {
            const target = new URL(`${cluster.url}/assets/app.js`);
            const req = httpRequest({
                hostname: target.hostname,
                port: target.port,
                path: target.pathname,
                headers: { host: 'blog.example.com', 'if-none-match': etag as string },
            }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
            req.on('error', reject);
            req.end();
        });

        expect(second).toBe(304);
    }, 60_000);
});

describe('a second push of the same commit', () => {
    it('rebuilds nothing and serves the same artifact', async () => {
        const repo = await repository();
        const cluster = await boot();

        const first = await deploy(cluster, repo);
        const second = await deploy(cluster, repo);

        expect(first.cached).toBe(false);
        expect(second.cached).toBe(true);
        expect(second.build.artifactDigest).toBe(first.build.artifactDigest);
        expect((await get(cluster.url, '/', 'blog.example.com')).status).toBe(200);
    }, 90_000);

    it('rebuilds when the commit changes, and the hostname follows', async () => {
        const repo = await repository();
        const cluster = await boot();
        const first = await deploy(cluster, repo);

        await writeFile(join(repo, 'build.sh'), BUILD_SCRIPT.replace('<title>Blog</title>', '<title>Blog 2</title>'));
        await run('git', ['commit', '--quiet', '-am', 'retitle'], { cwd: repo });

        const second = await deploy(cluster, repo);

        expect(second.cached).toBe(false);
        expect(second.build.artifactDigest).not.toBe(first.build.artifactDigest);

        // The deploy is the site record changing, so the new content is what the hostname serves the
        // moment the build finishes — no cache to wait out, because `site_put` invalidated it.
        const page = await get(cluster.url, '/', 'blog.example.com');
        expect(page.body).toContain('<title>Blog 2</title>');
    }, 90_000);
});

describe('what a build refuses', () => {
    it('fails with a message naming the file when the repo declares nothing', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'mesh-repo-'));
        temporary.push(dir);
        await writeFile(join(dir, 'README.md'), 'no descriptor here');
        await run('git', ['init', '--quiet', '--initial-branch', 'main'], { cwd: dir });
        await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
        await run('git', ['config', 'user.name', 'Test'], { cwd: dir });
        await run('git', ['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: dir });
        await run('git', ['add', '-A'], { cwd: dir });
        await run('git', ['commit', '--quiet', '-m', 'nothing'], { cwd: dir });

        const cluster = await boot();
        const deployed = await deploy(cluster, dir);

        expect(deployed.build.state).toBe('failed');
        expect(deployed.build.error).toContain('mesh.json');
        // A failed build is an answer, not an exception: the log is the only thing that says why,
        // and a thrown error loses it.
        expect(deployed.build.log).toContain('mesh.json');
    }, 60_000);

    it('names the environments the repo does declare', async () => {
        const repo = await repository();
        const cluster = await boot();

        const deployed = await deploy(cluster, repo, { environment: 'staging' });

        expect(deployed.build.state).toBe('failed');
        expect(deployed.build.error).toContain('production');
        expect(deployed.build.error).toContain('preview');
    }, 60_000);

    it('refuses to serve a site belonging to another tenant', async () => {
        const repo = await repository();
        // A node dedicated to one tenant. B6 is a *serving-layer* invariant because the origin is
        // the isolation boundary — two tenants on one hostname share storage and cookies.
        const cluster = await boot({ tenantId: 'tenant-b' });

        const deployed = await deploy(cluster, repo, { tenantId: 'tenant-a' });
        expect(deployed.build.state).toBe('succeeded');

        // Deployed, recorded, and still not served here. Deliberately a 404 rather than a 403:
        // which tenant owns a hostname is not something an anonymous request gets to learn.
        expect((await get(cluster.url, '/', 'blog.example.com')).status).toBe(404);
    }, 60_000);

    it('refuses to publish a deploy that names no tenant', async () => {
        const repo = await repository();
        const cluster = await boot();

        // A repository cannot name its own owner, so with no caller scope there is nobody to
        // attribute the hostname to and the publish must not proceed.
        await expect(cluster.call('builder.build_start', {
            source: { kind: 'git', repository: repo, ref: 'main' },
            environment: 'production',
            publish: true,
        })).rejects.toThrow(/tenant/i);
    }, 60_000);
});

/**
 * Roadmap B8c. [hosting §2](../../spec/hosting.md) says any CDN node asked for a hostname can serve
 * it, and every deploy so far has published **exactly one** — `deploy.mjs` builds a single `--repo`
 * and then sits. So the claim that one node serves many sites has never been asked for anything, and
 * an untested claim in a hosting layer is the kind that fails the first time it matters.
 *
 * Two repositories, one CDN, two hostnames, on one port.
 */
describe('one node serves many sites', () => {
    it('serves two repositories on one port, told apart by Host alone', async () => {
        const blog = await repository();
        const shop = await repository({
            application: 'shop',
            ui: { build: 'sh ./build.sh', output: 'dist' },
            environments: {
                // A different `api`, which the build bakes into the page — so the two artifacts
                // differ in content. With identical descriptors they hash to the *same* digest,
                // which is content addressing working correctly and makes "served the wrong one"
                // unobservable. The first draft of this test asserted they differed and was wrong.
                production: { host: 'shop.example.com', api: 'https://shop.example.com/api' },
            },
        });

        const cluster = await boot();

        const first = await deploy(cluster, blog);
        const second = await deploy(cluster, shop);

        expect(first.hostname).toBe('blog.example.com');
        expect(second.hostname).toBe('shop.example.com');

        // Different artifacts, because the descriptors differ — so serving the wrong one is visible
        // rather than a coincidence of identical fixtures.
        expect(first.build.artifactDigest).not.toBe(second.build.artifactDigest);

        const one = await get(cluster.url, '/', 'blog.example.com');
        const two = await get(cluster.url, '/', 'shop.example.com');

        expect(one.status).toBe(200);
        expect(two.status).toBe(200);
        expect(one.headers['x-artifact']).toBe(first.build.artifactDigest);
        expect(two.headers['x-artifact']).toBe(second.build.artifactDigest);

        // A hostname nobody published is still a 404 on a node that is serving two others.
        expect((await get(cluster.url, '/', 'unknown.example.com')).status).toBe(404);
    }, 120_000);

    it('tells localhost and 127.0.0.1 apart, which is what makes two local sites possible', async () => {
        // `normalizeHostname` lowercases and strips the port, and these normalise to different keys.
        // It is how one deployer on one port can serve a site *and* the thing you are comparing it
        // against — the case that found A6.3g by putting the harness and the console side by side.
        const loopback = await repository({
            application: 'blog',
            ui: { build: 'sh ./build.sh', output: 'dist' },
            environments: { production: { host: '127.0.0.1', api: 'https://api.example.com' } },
        });
        const named = await repository({
            application: 'other',
            ui: { build: 'sh ./build.sh', output: 'dist' },
            environments: { production: { host: 'localhost', api: 'https://elsewhere.example.com' } },
        });

        const cluster = await boot();
        const first = await deploy(cluster, loopback);
        const second = await deploy(cluster, named);

        expect((await get(cluster.url, '/', '127.0.0.1:8080')).headers['x-artifact'])
            .toBe(first.build.artifactDigest);
        expect((await get(cluster.url, '/', 'localhost:8080')).headers['x-artifact'])
            .toBe(second.build.artifactDigest);
    }, 120_000);
});

/**
 * Roadmap A9.1a. The declaration is built in `declaration.test.ts` against a directory; this is the
 * assertion that it survives a **real build** — fetched from a commit, built by a shell script,
 * collected, hashed and stored — and comes back out of the artifact store attached to the artifact.
 */
describe('a published artifact carries its declaration', () => {
    it('records the parts the repository declared', async () => {
        const repo = await repository({
            application: 'blog',
            ui: {
                build: 'sh ./build.sh',
                output: 'dist',
                parts: [{ kind: 'application', id: 'reader', entry: 'assets/app.js' }],
            },
            environments: {
                production: { host: 'blog.example.com', api: 'https://api.example.com' },
            },
        });

        const cluster = await boot();
        const deployed = await deploy(cluster, repo);
        // Read back through the contract, not out of the store: the schema is where a field silently
        // disappears, because zod strips what it does not mention. Reading the store would have
        // asserted the build's memory rather than what a caller receives.
        const { artifact } = await cluster.call<{
            artifact?: { declaration?: { parts: unknown[]; builtAgainst: unknown[] } };
        }>('builder.artifact_get', { digest: deployed.build.artifactDigest });

        expect(artifact?.declaration?.parts).toEqual([
            { kind: 'application', id: 'reader', entry: 'assets/app.js' },
        ]);
        expect(artifact?.declaration?.builtAgainst).toEqual([]);
    }, 120_000);
});
