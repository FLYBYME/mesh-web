/**
 * The builder — roadmap B2, spec/hosting.md §6.
 *
 * Two of these tests are the two defects the spec names from the previous generation, written as
 * things that must stay impossible:
 *
 * > source had to be a directory on the building node's disk, and the artifact record was an
 * > absolute path on whichever node built it. So nothing could be built from elsewhere and nothing
 * > could move once built.
 *
 * The rest are about the cache key, because a build cached on the wrong thing is worse than a build
 * that never caches: it serves stale content and looks like it worked.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
    BUILDER_VERSION, artifactDigest, assertResolved, canonical, contentTypeOf, createBuilder,
    digestOf, inputHash, memoryArtifactStore,
    type Fetcher,
} from '../../server/builder/src/index.js';
import type { EnvironmentDescriptor, SourceRef } from '../../server/protocol/src/index.js';

const COMMIT = 'a'.repeat(40);

const source = (over: Partial<Extract<SourceRef, { kind: 'git' }>> = {}): SourceRef => ({
    kind: 'git',
    repository: 'https://example.com/blog.git',
    ref: COMMIT,
    ...over,
});

const environment = (over: Partial<EnvironmentDescriptor> = {}): EnvironmentDescriptor => ({
    host: 'blog.example.com',
    api: 'https://api.example.com',
    build: { command: 'true', output: 'dist' },
    ...over,
});

/** A fetcher that writes a small site into whatever directory it is handed. */
const sourceOf = (files: Readonly<Record<string, string>>): Fetcher =>
    async (_ref, into) => {
        for (const [path, content] of Object.entries(files)) {
            const full = join(into, path);
            await mkdir(join(full, '..'), { recursive: true });
            await writeFile(full, content);
        }
    };

const A_SITE = {
    'dist/index.html': '<!doctype html><title>Blog</title><script type="module" src="/app.js"></script>',
    'dist/app.js': 'console.log("hello")',
    'dist/assets/style.css': 'body { margin: 0 }',
};

let temporary: string[] = [];

afterEach(async () => {
    for (const dir of temporary) await rm(dir, { recursive: true, force: true });
    temporary = [];
});

// ---------------------------------------------------------------------------- the two defects

describe('the code does not have to be local to the server', () => {
    it('is handed a destination it did not choose', async () => {
        const seen: { source: SourceRef; into: string }[] = [];

        const builder = createBuilder({
            store: memoryArtifactStore(),
            fetcher: async (ref, into) => {
                seen.push({ source: ref, into });
                await sourceOf(A_SITE)(ref, into);
            },
        });

        await builder.build({
            application: 'blog', environment: 'production', source: source(), descriptor: environment(),
        });

        // The workspace is the builder's, created and destroyed inside `build`. A source that could
        // name its own directory is a source that has to already be on this machine — which is the
        // defect, and it is not expressible here.
        expect(seen).toHaveLength(1);
        expect(seen[0]!.into).toContain('mesh-build-');
        expect(JSON.stringify(seen[0]!.source)).not.toContain(seen[0]!.into);
    });

    it('destroys the workspace whether the build works or fails', async () => {
        const workspaces: string[] = [];
        const builder = createBuilder({
            store: memoryArtifactStore(),
            fetcher: async (_ref, into) => {
                workspaces.push(into);
                throw new Error('the repository is gone');
            },
        });

        const result = await builder.build({
            application: 'blog', environment: 'production', source: source(), descriptor: environment(),
        });

        expect(result.build.state).toBe('failed');
        // Nothing is left behind on a builder that runs a thousand builds a day.
        const { access } = await import('node:fs/promises');
        await expect(access(workspaces[0]!)).rejects.toThrow();
    });
});

describe('the artifact is content, not a location', () => {
    it('names files by their path inside the artifact and nothing else', async () => {
        const store = memoryArtifactStore();
        const builder = createBuilder({ store, fetcher: sourceOf(A_SITE) });

        const { artifact } = await builder.build({
            application: 'blog', environment: 'production', source: source(), descriptor: environment(),
        });

        expect(artifact!.files.map((f) => f.path).sort()).toEqual(['app.js', 'assets/style.css', 'index.html']);

        // The previous generation stored an absolute path on the building node, so an artifact could
        // not move. Nothing here mentions a machine.
        const serialised = JSON.stringify(artifact);
        expect(serialised).not.toContain(tmpdir());
        expect(serialised).not.toContain('/home');
        expect(serialised).not.toMatch(/"[^"]*\/tmp\//);
    });

    it('addresses the whole set by digest, so a node can tell whether it has it', async () => {
        const builder = createBuilder({ store: memoryArtifactStore(), fetcher: sourceOf(A_SITE) });
        const first = await builder.build({
            application: 'blog', environment: 'production', source: source(), descriptor: environment(),
        });

        const other = createBuilder({ store: memoryArtifactStore(), fetcher: sourceOf(A_SITE) });
        const second = await other.build({
            application: 'blog', environment: 'production', source: source(), descriptor: environment(),
        });

        // Two builders, two stores, same input: the same digest. That is what lets a CDN node say
        // "I already have this" without trusting a name.
        expect(second.artifact!.digest).toBe(first.artifact!.digest);
    });

    it('shares blobs between artifacts that share a file', async () => {
        const store = memoryArtifactStore();
        const builder = createBuilder({ store, fetcher: sourceOf(A_SITE) });

        await builder.build({ application: 'blog', environment: 'production', source: source(), descriptor: environment() });
        const after = await store.usage();

        const changed = createBuilder({
            store,
            fetcher: sourceOf({ ...A_SITE, 'dist/app.js': 'console.log("changed")' }),
        });
        await changed.build({
            application: 'blog', environment: 'production',
            source: source({ ref: 'b'.repeat(40) }), descriptor: environment(),
        });

        const later = await store.usage();
        // One file changed, so one blob was added — not a second copy of the whole site. That falls
        // out of content addressing rather than being an optimisation anybody wrote.
        expect(later.blobs).toBe(after.blobs + 1);
    });
});

// ---------------------------------------------------------------------------- the cache key

describe('a build is cached by what determines its output', () => {
    it('does not rebuild for the same inputs', async () => {
        let fetches = 0;
        const builder = createBuilder({
            store: memoryArtifactStore(),
            fetcher: async (ref, into) => { fetches += 1; await sourceOf(A_SITE)(ref, into); },
        });

        const request = {
            application: 'blog', environment: 'production', source: source(), descriptor: environment(),
        };

        const first = await builder.build(request);
        const second = await builder.build(request);

        expect(first.cached).toBe(false);
        expect(second.cached).toBe(true);
        expect(second.build.artifactDigest).toBe(first.build.artifactDigest);
        expect(fetches).toBe(1);
    });

    it('rebuilds when the policy changes, because the policy is in the bundle', async () => {
        const builder = createBuilder({ store: memoryArtifactStore(), fetcher: sourceOf(A_SITE) });

        const plain = await builder.build({
            application: 'blog', environment: 'production', source: source(), descriptor: environment(),
        });
        const locked = await builder.build({
            application: 'blog', environment: 'production', source: source(),
            descriptor: environment({ policy: { 'window-manager/mode': 'tiled' } }),
        });

        // B3: the build is where policy is frozen in. A locked blog and an unlocked one are
        // different bundles, so they must be different builds.
        expect(locked.cached).toBe(false);
        expect(inputHash({
            source: source(), environment: 'production', policy: {}, builderVersion: BUILDER_VERSION,
        })).not.toBe(inputHash({
            source: source(), environment: 'production',
            policy: { 'window-manager/mode': 'tiled' }, builderVersion: BUILDER_VERSION,
        }));
        void plain;
    });

    it('refuses to hash a branch', () => {
        // The trap this exists for: `main` hashes to itself forever while the code underneath it
        // changes, so a build cached on it would serve a stale artifact indefinitely — which is
        // worse than not caching, because it looks like it worked.
        expect(() => assertResolved(source({ ref: 'main' }))).toThrow(/not a commit/);
        expect(() => assertResolved(source())).not.toThrow();
        expect(() => assertResolved({ kind: 'archive', url: 'https://x/a.tgz', digest: '' })).toThrow(/digest/);
    });

    it('does not depend on the order keys were written in', () => {
        const one = inputHash({
            source: source(), environment: 'production',
            policy: { a: 1, b: 2 }, builderVersion: '1',
        });
        const other = inputHash({
            source: source(), environment: 'production',
            policy: { b: 2, a: 1 }, builderVersion: '1',
        });

        // A cache that missed on key order would look like a builder that never caches.
        expect(one).toBe(other);
        expect(canonical({ b: 1, a: 2 })).toBe(canonical({ a: 2, b: 1 }));
    });

    it('includes the builder itself, because a builder change can change the output', () => {
        const inputs = { source: source(), environment: 'production', policy: {} };
        expect(inputHash({ ...inputs, builderVersion: '1' }))
            .not.toBe(inputHash({ ...inputs, builderVersion: '2' }));
    });
});

// ---------------------------------------------------------------------------- refusals

describe('what the builder refuses', () => {
    it('refuses an empty output rather than publishing a blank site', async () => {
        const builder = createBuilder({
            store: memoryArtifactStore(),
            fetcher: sourceOf({ 'README.md': 'no dist here' }),
        });

        const result = await builder.build({
            application: 'blog', environment: 'production', source: source(), descriptor: environment(),
        });

        // An empty artifact would serve a blank page rather than fail, and a blank page is a much
        // harder thing to diagnose than a failed build.
        expect(result.build.state).toBe('failed');

        // Named by what the descriptor calls it. The first version of this reported a raw ENOENT
        // naming a scratch directory the caller has never heard of and cannot act on.
        expect(result.build.error).toMatch(/no "dist" directory/);
        expect(result.build.error).not.toContain('ENOENT');
        expect(result.build.error).not.toContain('mesh-build-');
    });

    it('refuses an output directory that exists but is empty', async () => {
        const builder = createBuilder({
            store: memoryArtifactStore(),
            fetcher: sourceOf({ 'dist/.keep': '' }),
            // The `.keep` is collected, so an *actually* empty directory needs the command to make
            // one. Simpler: build into a directory the command creates and leaves empty.
        });

        const result = await builder.build({
            application: 'blog', environment: 'production', source: source(),
            descriptor: environment({ build: { command: 'mkdir -p out', output: 'out' } }),
        });

        expect(result.build.state).toBe('failed');
        expect(result.build.error).toMatch(/no files in "out"/);
    });

    it('keeps the log on a failure', async () => {
        const builder = createBuilder({
            store: memoryArtifactStore(),
            fetcher: sourceOf({ 'dist/index.html': 'x' }),
        });

        const result = await builder.build({
            application: 'blog', environment: 'production', source: source(),
            descriptor: environment({ build: { command: 'echo building && exit 3', output: 'dist' } }),
        });

        expect(result.build.state).toBe('failed');
        // A failed build with no output is a bug report nobody can act on, and the workspace it
        // happened in is already gone.
        expect(result.build.log).toContain('building');
    });

    it('refuses an artifact larger than it is willing to publish', async () => {
        const builder = createBuilder({
            store: memoryArtifactStore(),
            fetcher: sourceOf({ 'dist/big.txt': 'x'.repeat(5000) }),
            maxBytes: 1000,
        });

        const result = await builder.build({
            application: 'blog', environment: 'production', source: source(), descriptor: environment(),
        });

        expect(result.build.state).toBe('failed');
        expect(result.build.error).toMatch(/more than/);
    });
});

describe('content types', () => {
    it('serves a module as JavaScript, not plain text', () => {
        // A browser refuses a module served as text/plain, and the failure is silent in the network
        // tab — the request is a 200 and the page simply does not run.
        expect(contentTypeOf('app.js')).toContain('text/javascript');
        expect(contentTypeOf('app.mjs')).toContain('text/javascript');
        expect(contentTypeOf('index.html')).toContain('text/html');
        expect(contentTypeOf('style.css')).toContain('text/css');
        expect(contentTypeOf('font.woff2')).toBe('font/woff2');
        expect(contentTypeOf('unknown')).toBe('application/octet-stream');
    });
});

describe('digests', () => {
    it('are stable and short enough to read', () => {
        expect(digestOf('hello')).toBe(digestOf('hello'));
        expect(digestOf('hello')).toMatch(/^sha256:[0-9a-f]{32}$/);
        expect(digestOf('hello')).not.toBe(digestOf('hellp'));
    });

    it('do not depend on the order files were walked in', () => {
        const files = [
            { path: 'b.js', digest: digestOf('b'), size: 1, contentType: 'text/javascript' },
            { path: 'a.js', digest: digestOf('a'), size: 1, contentType: 'text/javascript' },
        ];

        // Hashing bytes in directory order would make an artifact's identity depend on a filesystem.
        expect(artifactDigest(files)).toBe(artifactDigest([...files].reverse()));
    });
});
