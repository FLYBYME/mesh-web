/**
 * One process, four modules — roadmap C2.1a, and the sentence M3 claims that nothing asserted.
 *
 * M3 reads: *push a repo, mesh-web builds it, a CDN node serves it, and signing in issues a ticket
 * the API validates once and caches.* Until now that was two tests in two repositories — the deploy
 * half here, the sign-in half in mesh-api — and neither faked the other, but they had never been in
 * the same room. This is the room:
 *
 *     MeshApp
 *       ├── identity   (mesh-identity)  no listener
 *       ├── builder    (this repo)      binds nothing
 *       ├── cdn        (this repo)      binds a port, serves the world
 *       └── api        (mesh-api)       binds a port, the only security boundary
 *
 * **A deploy becomes an authenticated HTTP call.** Not a mesh call from inside the cluster: a POST
 * from outside, gated, with a ticket identity issued, whose scope decides which tenant owns the
 * hostname that results.
 *
 * mesh-api and mesh-identity are **devDependencies** here and must stay that way. This package's
 * server modules answer contracts by key over the broker; a hard dependency would couple them to one
 * implementation of the API, and the whole point of §3 is that the four scale independently.
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
import { createApiModule, type ApiModule, type ExposeEntry } from '@flybyme/mesh-api';
import { createIdentityModule, type IdentityModule } from '@flybyme/mesh-identity';
import { afterEach, describe, expect, it } from 'vitest';

import { buildStartContract, createBuilderModule } from '../../server/builder/src/index.js';
import { createCdnModule, type CdnModule } from '../../server/cdn/src/index.js';
import type { Site } from '../../server/protocol/src/index.js';

const run = promisify(execFile);

// ---------------------------------------------------------------------------- a repository

const DESCRIPTOR = {
    application: 'blog',
    environments: {
        production: {
            host: 'blog.example.com',
            api: 'https://api.example.com',
            build: { command: 'sh ./build.sh', output: 'dist' },
        },
    },
};

const BUILD_SCRIPT = [
    '#!/bin/sh',
    'set -e',
    'mkdir -p dist',
    'printf \'<!doctype html><title>Blog</title>\' > dist/index.html',
    '',
].join('\n');

const temporary: string[] = [];

async function repository(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mesh-repo-'));
    temporary.push(dir);

    await writeFile(join(dir, 'mesh-web.json'), JSON.stringify(DESCRIPTOR));
    await writeFile(join(dir, 'build.sh'), BUILD_SCRIPT);

    await run('git', ['init', '--quiet', '--initial-branch', 'main'], { cwd: dir });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await run('git', ['config', 'user.name', 'Test'], { cwd: dir });
    await run('git', ['config', 'uploadpack.allowAnySHA1InWant', 'true'], { cwd: dir });
    await run('git', ['add', '-A'], { cwd: dir });
    await run('git', ['commit', '--quiet', '-m', 'the site'], { cwd: dir });

    return dir;
}

// ---------------------------------------------------------------------------- the cluster

interface Cluster {
    readonly identity: IdentityModule;
    readonly cdn: CdnModule;
    readonly api: string;
    readonly serving: string;
    call<T>(tool: string, params: unknown): Promise<T>;
    stop(): Promise<void>;
}

let clusters: Cluster[] = [];

afterEach(async () => {
    for (const cluster of clusters) await cluster.stop();
    clusters = [];
    for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function boot(): Promise<Cluster> {
    const app = new MeshApp({
        nodeID: `node-${String(Math.random()).slice(2, 8)}`,
        namespace: 'mesh-web-gated-test',
    });
    app.use(new RegistryModule());
    app.use(new BrokerModule());
    await app.start();

    const identity = createIdentityModule();
    await app.registerModule(identity);

    const builder = createBuilderModule({ onError: () => {} });
    await app.registerModule(builder);

    const cdn = createCdnModule({ port: 0, host: '127.0.0.1', onError: () => {} });
    await app.registerModule(cdn);

    const api = createApiModule({
        application: 'platform',
        // Deploying is a thing a signed-in person does. `auth: 'user'` is the coarse gate; the hook
        // below is what turns a user into an organization.
        expose: [{ contract: buildStartContract as unknown as ExposeEntry['contract'], auth: 'user' }],
        port: 0,
        host: '127.0.0.1',
        validateTool: 'identity.ticket_validate',
        revocationPollMs: 50,

        /**
         * The site's own answer to "in which organization".
         *
         * It reads identity's own membership records rather than anything the request carried, which
         * is the whole reason the hook returns the scope instead of the request naming it.
         */
        authorize: async ({ caller }) => {
            if (caller === undefined) return { authorized: false, status: 403 };

            const memberships = await identity.store.membershipsOf(caller.userId);
            const first = memberships[0];
            if (first === undefined) {
                return {
                    authorized: false,
                    status: 403,
                    message: 'You are not a member of any organization.',
                };
            }
            return { authorized: true, resolvedScope: first.organizationId };
        },

        onError: () => {},
    });
    await app.registerModule(api);

    const apiAddress = api.listener?.address() as AddressInfo;
    const cdnAddress = cdn.listener?.address() as AddressInfo;

    const cluster: Cluster = {
        identity,
        cdn,
        api: `http://127.0.0.1:${String(apiAddress.port)}`,
        serving: `http://127.0.0.1:${String(cdnAddress.port)}`,
        call: <T,>(tool: string, params: unknown): Promise<T> =>
            (app as unknown as { call(t: string, p: unknown): Promise<T> }).call(tool, params),
        async stop() {
            await (api as ApiModule).onStop?.(undefined as unknown as IServiceBroker);
            await cdn.onStop?.(undefined as unknown as IServiceBroker);
            await app.stop();
        },
    };

    clusters.push(cluster);
    return cluster;
}

// ---------------------------------------------------------------------------- people

const PASSWORD = 'a-long-enough-password';

/** A person, in an organization, holding a ticket identity issued. */
async function member(cluster: Cluster, email: string, organization: string): Promise<string> {
    const { userId } = await cluster.call<{ userId: string }>('identity.register', {
        email, password: PASSWORD, displayName: email,
    });

    const org = await cluster.identity.store.createOrganization({
        name: organization,
        slug: organization.toLowerCase(),
        ownerId: userId,
    });
    await cluster.identity.store.createMembership({
        userId,
        organizationId: org.id,
        roleKey: 'owner',
        joinedAt: Date.now(),
    });

    const { token } = await cluster.call<{ token: string }>('identity.ticket_issue', {
        email, password: PASSWORD,
    });
    return token;
}

const organizationOf = async (cluster: Cluster, ticket: string): Promise<string> => {
    const validation = await cluster.call<{ userId: string }>('identity.ticket_validate', { ticket });
    const memberships = await cluster.identity.store.membershipsOf(validation.userId);
    return memberships[0]!.organizationId;
};

// ---------------------------------------------------------------------------- requests

interface Reply { readonly status: number; readonly body: unknown }

function post(url: string, path: string, body: unknown, ticket?: string): Promise<Reply> {
    const payload = JSON.stringify(body);
    const target = new URL(`${url}${path}`);

    return new Promise((resolve, reject) => {
        const req = httpRequest({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(payload)),
                ...(ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }),
            },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const text = Buffer.concat(chunks).toString();
                resolve({
                    status: res.statusCode ?? 0,
                    body: text === '' ? undefined : JSON.parse(text) as unknown,
                });
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

function serve(url: string, path: string, host: string): Promise<{ status: number; body: string }> {
    const target = new URL(`${url}${path}`);
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            hostname: target.hostname,
            port: target.port,
            path: target.pathname,
            headers: { host },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString(),
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

const deployRequest = (repo: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    source: { kind: 'git', repository: repo, ref: 'main' },
    environment: 'production',
    publish: true,
    ...over,
});

// ---------------------------------------------------------------------------- the tests

describe('a deploy is an authenticated call', () => {
    it('refuses an anonymous one', async () => {
        const repo = await repository();
        const cluster = await boot();

        const reply = await post(cluster.api, '/api/builder/builds', deployRequest(repo));

        expect(reply.status).toBe(401);
        // Refused at the gate, so nothing was cloned and nothing was built. A build is expensive and
        // runs code from a repository — refusing after doing it would be refusing the wrong thing.
        expect((await cluster.call<{ builds: unknown[] }>('builder.build_status', {})).builds)
            .toHaveLength(0);
    }, 60_000);

    it('refuses a signed-in caller who belongs to no organization', async () => {
        const repo = await repository();
        const cluster = await boot();

        await cluster.call('identity.register', {
            email: 'nobody@example.com', password: PASSWORD, displayName: 'Nobody',
        });
        const { token } = await cluster.call<{ token: string }>('identity.ticket_issue', {
            email: 'nobody@example.com', password: PASSWORD,
        });

        const reply = await post(cluster.api, '/api/builder/builds', deployRequest(repo), token);

        // A valid ticket and no scope. Authenticated is not authorized, and there is nobody for the
        // hostname to belong to.
        expect(reply.status).toBe(403);
    }, 60_000);

    it('builds, publishes and serves for a member, under their own organization', async () => {
        const repo = await repository();
        const cluster = await boot();
        const ticket = await member(cluster, 'alice@example.com', 'Acme');
        const acme = await organizationOf(cluster, ticket);

        const reply = await post(cluster.api, '/api/builder/builds', deployRequest(repo), ticket);
        expect(reply.status).toBe(200);

        const result = reply.body as { build: { state: string }; hostname?: string };
        expect(result.build.state).toBe('succeeded');
        expect(result.hostname).toBe('blog.example.com');

        // The tenant on the record is the organization the *ticket* resolved to. Nothing in the
        // request named it, and the repository could not have.
        const { site } = await cluster.call<{ site: Site }>('cdn.site_resolve', {
            hostname: 'blog.example.com',
        });
        expect(site.tenantId).toBe(acme);

        const page = await serve(cluster.serving, '/', 'blog.example.com');
        expect(page.status).toBe(200);
        expect(page.body).toContain('<title>Blog</title>');
    }, 90_000);
});

describe('the scope a ticket resolved to is not a suggestion', () => {
    it('refuses a caller who tries to publish under another tenant', async () => {
        const repo = await repository();
        const cluster = await boot();

        const alice = await member(cluster, 'alice@example.com', 'Acme');
        const bob = await member(cluster, 'bob@example.com', 'Umbrella');
        const umbrella = await organizationOf(cluster, bob);

        // Alice's ticket, Umbrella's id in the body. Before this was fixed the module read
        // `input.tenantId ?? scope`, so the typed value won and Alice could have published a
        // hostname owned by Bob's organization.
        const reply = await post(
            cluster.api,
            '/api/builder/builds',
            deployRequest(repo, { tenantId: umbrella }),
            alice,
        );

        expect(reply.status).toBeGreaterThanOrEqual(400);

        const { site } = await cluster.call<{ site?: Site }>('cdn.site_resolve', {
            hostname: 'blog.example.com',
        }) as { site?: Site };
        expect(site).toBeUndefined();

        // And refused *before* the build, not after it. The check can only fail and depends on
        // nothing the build produces, so running a stranger's build command first in order to tell
        // them no is work done for an answer already known.
        expect((await cluster.call<{ builds: unknown[] }>('builder.build_status', {})).builds)
            .toHaveLength(0);
    }, 90_000);

    it('accepts a caller who restates the scope they already had', async () => {
        const repo = await repository();
        const cluster = await boot();
        const ticket = await member(cluster, 'alice@example.com', 'Acme');
        const acme = await organizationOf(cluster, ticket);

        // Redundant rather than wrong. Refusing this would make the field useless to the internal
        // caller it exists for, and it asserts nothing the ticket did not already say.
        const reply = await post(
            cluster.api,
            '/api/builder/builds',
            deployRequest(repo, { tenantId: acme }),
            ticket,
        );

        expect(reply.status).toBe(200);
    }, 90_000);
});

describe('the ticket is validated once and cached', () => {
    it('does not re-validate per request', async () => {
        const repo = await repository();
        const cluster = await boot();
        const ticket = await member(cluster, 'alice@example.com', 'Acme');

        let validations = 0;
        const store = cluster.identity.store;
        const real = store.getTicket.bind(store);
        store.getTicket = async (token: string) => { validations += 1; return real(token); };

        await post(cluster.api, '/api/builder/builds', deployRequest(repo), ticket);
        await post(cluster.api, '/api/builder/builds', deployRequest(repo), ticket);
        await post(cluster.api, '/api/builder/builds', deployRequest(repo), ticket);

        // One mesh call per (ticket, instance), not per request — C2.1. Three deploys, one lookup.
        expect(validations).toBe(1);
    }, 120_000);

    it('stops accepting a revoked ticket', async () => {
        const repo = await repository();
        const cluster = await boot();
        const ticket = await member(cluster, 'alice@example.com', 'Acme');

        expect((await post(cluster.api, '/api/builder/builds', deployRequest(repo), ticket)).status)
            .toBe(200);

        await cluster.call('identity.ticket_revoke', { token: ticket, reason: 'testing' });
        // The event is what makes this immediate; the poll is what makes it certain. Either way it
        // must not still be accepted from the cache.
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect((await post(cluster.api, '/api/builder/builds', deployRequest(repo), ticket)).status)
            .toBe(401);
    }, 120_000);
});
