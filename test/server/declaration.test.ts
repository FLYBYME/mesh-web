/**
 * What a build records about what it produced — roadmap A9.1a.
 *
 * The reason this is worth its own file: **A9.1 removed the thing that used to make a framework
 * mismatch impossible.** With one build per site, everything compiled together or nothing did. With
 * every Application and Extension built separately, a part built against `@flybyme/mesh-web` 1.2 and
 * loaded into a site serving 2.0 is caught by no compiler, because no compiler sees both. It fails in
 * someone else's browser.
 *
 * So the assertions below are all really one assertion: **the recorded version is the installed one,
 * never the requested one.** A range recorded as a fact would be worse than nothing, because whatever
 * compares against it would be comparing against a wish.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { DeploymentDescriptor } from '../../server/protocol/src/index.js';
import { declarationOf, resolveDependencies } from '../../server/builder/src/declaration.js';

const dirs: string[] = [];

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Tree {
    /** Extra `package.json` files, keyed by directory relative to the root. */
    readonly packages?: Record<string, Record<string, unknown>>;
    /** Installed packages, keyed by the directory whose `node_modules` holds them. */
    readonly installedIn?: Record<string, Record<string, string>>;
    /** `package-lock.json` entries: `node_modules/<name>` → `resolved`. */
    readonly lock?: Record<string, string>;
}

/** A source tree as a build would find it: manifests, and whatever is actually installed. */
async function tree(
    manifest: Record<string, unknown> | undefined,
    installed: Record<string, string> = {},
    extra: Tree = {},
): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'mesh-decl-'));
    dirs.push(dir);

    if (manifest !== undefined) {
        await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
    }

    for (const [at, contents] of Object.entries(extra.packages ?? {})) {
        await mkdir(join(dir, at), { recursive: true });
        await writeFile(join(dir, at, 'package.json'), JSON.stringify(contents));
    }

    const install = async (where: string, packages: Record<string, string>): Promise<void> => {
        for (const [name, version] of Object.entries(packages)) {
            const at = join(dir, where, 'node_modules', ...name.split('/'));
            await mkdir(at, { recursive: true });
            await writeFile(join(at, 'package.json'), JSON.stringify({ name, version }));
        }
    };

    await install('.', installed);
    for (const [where, packages] of Object.entries(extra.installedIn ?? {})) {
        await install(where, packages);
    }

    if (extra.lock !== undefined) {
        const packages = Object.fromEntries(
            Object.entries(extra.lock).map(([path, resolved]) => [path, { resolved }]),
        );
        await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ packages }));
    }

    return dir;
}

const lines: string[] = [];
const record = (line: string): void => { lines.push(line); };

describe('the recorded version is the installed one, not the requested one', () => {
    it('records what is in node_modules, not the range in package.json', async () => {
        const root = await tree(
            { dependencies: { '@flybyme/mesh-web': '^1.2.0' } },
            { '@flybyme/mesh-web': '1.4.7' },
        );

        expect(await resolveDependencies(root, record))
            .toEqual([{ package: '@flybyme/mesh-web', version: '1.4.7' }]);
    });

    it('resolves a scoped package through both path segments', async () => {
        const root = await tree(
            { dependencies: { '@flybyme/mesh-api': '*' } },
            { '@flybyme/mesh-api': '0.9.1' },
        );

        expect(await resolveDependencies(root, record))
            .toEqual([{ package: '@flybyme/mesh-api', version: '0.9.1' }]);
    });

    it('reads peerDependencies too — a framework is usually one', async () => {
        const root = await tree(
            { peerDependencies: { '@flybyme/mesh-web': '^2' } },
            { '@flybyme/mesh-web': '2.0.0' },
        );

        expect(await resolveDependencies(root, record))
            .toEqual([{ package: '@flybyme/mesh-web', version: '2.0.0' }]);
    });

    it('skips a declared but uninstalled dependency, and says so', async () => {
        lines.length = 0;
        const root = await tree(
            { dependencies: { installed: '1', ghost: '^3.0.0' } },
            { installed: '1.0.0' },
        );

        const resolved = await resolveDependencies(root, record);

        // The absent one is absent — not recorded as '^3.0.0', which is the failure this exists to
        // prevent: a false fact is worse than a missing one, because something will compare to it.
        expect(resolved).toEqual([{ package: 'installed', version: '1.0.0' }]);
        expect(lines.join('\n')).toContain('ghost');
    });

    it('says so rather than throwing when there is no package.json at all', async () => {
        lines.length = 0;
        const root = await tree(undefined);

        expect(await resolveDependencies(root, record)).toEqual([]);
        expect(lines.join('\n')).toContain('no package.json');
    });

    it('ignores devDependencies — they are not linked into what shipped', async () => {
        const root = await tree(
            { devDependencies: { vitest: '^2' } },
            { vitest: '2.1.9' },
        );

        expect(await resolveDependencies(root, record)).toEqual([]);
    });
});

/**
 * Both groups below were written *after* running this against `surfdns-console` and getting an empty
 * result, then a useless one. Neither shape occurred to me while writing the fixtures above, which is
 * the argument for running a thing against a real repository before believing its tests.
 */
describe('a workspace declares dependencies the root does not', () => {
    it('reads a dependency declared in a workspace and installed hoisted at the root', async () => {
        // surfdns-console exactly: the root manifest has only devDependencies, `@flybyme/mesh-web` is
        // declared in ui/package.json, and npm hoisted it to the root node_modules. Reading only the
        // root manifest returned nothing at all.
        const root = await tree(
            { workspaces: ['service', 'ui'], devDependencies: { typescript: '^5' } },
            { '@flybyme/mesh-web': '0.1.0' },
            { packages: { ui: { dependencies: { '@flybyme/mesh-web': 'github:FLYBYME/mesh-web' } } } },
        );

        expect(await resolveDependencies(root, record))
            .toEqual([{ package: '@flybyme/mesh-web', version: '0.1.0' }]);
    });

    it('prefers a workspace-local install over the hoisted one, as node would', async () => {
        const root = await tree(
            { workspaces: ['ui'] },
            { pkg: '1.0.0' },
            {
                packages: { ui: { dependencies: { pkg: '*' } } },
                installedIn: { ui: { pkg: '2.0.0' } },
            },
        );

        expect(await resolveDependencies(root, record)).toEqual([{ package: 'pkg', version: '2.0.0' }]);
    });

    it('expands a trailing /* workspace glob', async () => {
        const root = await tree(
            { workspaces: ['packages/*'] },
            { pkg: '3.1.4' },
            { packages: { 'packages/one': { dependencies: { pkg: '^3' } } } },
        );

        expect(await resolveDependencies(root, record)).toEqual([{ package: 'pkg', version: '3.1.4' }]);
    });

    it('reads the object form of workspaces', async () => {
        const root = await tree(
            { workspaces: { packages: ['ui'] } },
            { pkg: '1.2.3' },
            { packages: { ui: { dependencies: { pkg: '*' } } } },
        );

        expect(await resolveDependencies(root, record)).toEqual([{ package: 'pkg', version: '1.2.3' }]);
    });
});

describe('a git dependency is identified by commit, because its version never moves', () => {
    const GIT = 'git+ssh://git@github.com/FLYBYME/mesh-web.git#3482d5d41c47f184490b956c73701f6868799961';

    it('records the commit from the lockfile', async () => {
        const root = await tree(
            { dependencies: { '@flybyme/mesh-web': 'github:FLYBYME/mesh-web' } },
            { '@flybyme/mesh-web': '0.1.0' },
            { lock: { 'node_modules/@flybyme/mesh-web': GIT } },
        );

        expect(await resolveDependencies(root, record)).toEqual([{
            package: '@flybyme/mesh-web',
            version: '0.1.0',
            commit: '3482d5d41c47f184490b956c73701f6868799961',
        }]);
    });

    it('is the only thing that distinguishes two builds of the same git dependency', async () => {
        // The whole point. A package consumed from a branch keeps the version its author wrote, so
        // `version` is identical across every framework change and would catch no skew at all.
        const before = await tree(
            { dependencies: { fw: 'github:x/fw' } },
            { fw: '0.1.0' },
            { lock: { 'node_modules/fw': 'git+ssh://git@github.com/x/fw.git#' + 'a'.repeat(40) } },
        );
        const after = await tree(
            { dependencies: { fw: 'github:x/fw' } },
            { fw: '0.1.0' },
            { lock: { 'node_modules/fw': 'git+ssh://git@github.com/x/fw.git#' + 'b'.repeat(40) } },
        );

        const [one] = await resolveDependencies(before, record);
        const [two] = await resolveDependencies(after, record);

        expect(one?.version).toBe(two?.version);
        expect(one?.commit).not.toBe(two?.commit);
    });

    it('records no commit for a registry dependency', async () => {
        const root = await tree(
            { dependencies: { vitest: '^2' } },
            { vitest: '2.1.9' },
            { lock: { 'node_modules/vitest': 'https://registry.npmjs.org/vitest/-/vitest-2.1.9.tgz' } },
        );

        const [only] = await resolveDependencies(root, record);

        expect(only).toEqual({ package: 'vitest', version: '2.1.9' });
        expect(only?.commit).toBeUndefined();
    });

    it('ignores a fragment that is not a commit sha', async () => {
        const root = await tree(
            { dependencies: { fw: 'github:x/fw#main' } },
            { fw: '0.1.0' },
            { lock: { 'node_modules/fw': 'git+ssh://git@github.com/x/fw.git#main' } },
        );

        expect((await resolveDependencies(root, record))[0]?.commit).toBeUndefined();
    });
});

describe('a declaration says what the artifact provides', () => {
    const deployment = (ui?: DeploymentDescriptor['ui'], service?: DeploymentDescriptor['service']) =>
        ({
            application: 'console',
            ...(ui === undefined ? {} : { ui }),
            ...(service === undefined ? {} : { service }),
            environments: { local: { host: 'localhost', api: 'http://127.0.0.1:5005' } },
        }) as DeploymentDescriptor;

    it('carries the declared UI parts through', async () => {
        const root = await tree({});
        const declaration = await declarationOf(root, deployment({
            build: 'x', output: 'out',
            parts: [{ kind: 'extension', id: 'console.chrome', entry: 'app/chrome.js' }],
        }), record);

        expect(declaration.parts).toEqual([
            { kind: 'extension', id: 'console.chrome', entry: 'app/chrome.js' },
        ]);
    });

    it('adds the service half as a part, carrying its domains', async () => {
        const root = await tree({});
        const declaration = await declarationOf(root, deployment(undefined, {
            entry: './service/dist/index.js', domains: ['console'],
        }), record);

        expect(declaration.parts).toEqual([{
            kind: 'service',
            id: 'console',
            entry: './service/dist/index.js',
            domains: ['console'],
        }]);
    });

    it('declares no parts when the caller supplied an environment and no file was read', async () => {
        // Different from a repository declaring none, which the descriptor parser refuses outright.
        // Here the question was never asked, and the versions are still recorded.
        const root = await tree(
            { dependencies: { '@flybyme/mesh-web': '^1' } },
            { '@flybyme/mesh-web': '1.4.7' },
        );

        const declaration = await declarationOf(root, undefined, record);

        expect(declaration.parts).toEqual([]);
        expect(declaration.builtAgainst).toEqual([{ package: '@flybyme/mesh-web', version: '1.4.7' }]);
    });

    it('records versions even for an artifact with no parts at all', async () => {
        const root = await tree(
            { dependencies: { '@flybyme/mesh-web': '^1' } },
            { '@flybyme/mesh-web': '1.4.7' },
        );

        const declaration = await declarationOf(root, deployment({ build: 'x', output: 'out' }), record);

        expect(declaration.parts).toEqual([]);
        expect(declaration.builtAgainst).toHaveLength(1);
    });
});
