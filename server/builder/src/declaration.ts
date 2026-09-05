/**
 * What a build says the artifact it produced provides — roadmap A9.1a, decided 2026-09-05.
 *
 * `declared`, in the sense of
 * [declared/desired/observed](https://github.com/FLYBYME/mesh/blob/master/docs/DECLARED_DESIRED_OBSERVED.md).
 * The artifact carries it, so registering one is a write rather than a compile, and an artifact
 * copied to another node arrives already able to say what it is.
 *
 * ## Why the versions are read from disk
 *
 * A9.1's decision — every Application and Extension is its own artifact — removes the one thing that
 * used to make a framework mismatch impossible. With a single build per site, everything compiled
 * together or nothing did. With parts built separately, a part built against `@flybyme/mesh-web` 1.2
 * and loaded into a site serving 2.0 is caught by nothing: there is no longer a compiler that sees
 * both. It fails at run time, in someone else's browser.
 *
 * So the build records what was *actually installed*, at the only moment it is known for certain,
 * from `node_modules/<name>/package.json` — never from the range in the repository's own
 * `package.json`. **`^1.2.0` is a wish; the installed version is the fact**, and the whole point of
 * this record is to be a fact something else can compare against.
 *
 * Direct dependencies only, and no allowlist. A filter naming `@flybyme/*` would be the framework
 * asserting which packages matter about a question it cannot see the whole of, and guessing that now
 * is how the wrong thing gets recorded. Narrowing later is easy; a missing fact is not recoverable.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    Declaration, DeclaredPart, DeploymentDescriptor, ResolvedDependency,
} from '@flybyme/mesh-web-protocol';

/**
 * Build the declaration for an artifact.
 *
 * `deployment` is absent when the caller supplied an environment descriptor rather than letting the
 * build read one from the source — in which case nothing declared any parts and `parts` is empty.
 * **That is a different statement from a repository declaring none**, which the descriptor parser
 * refuses outright; here it means the question was never asked.
 */
export async function declarationOf(
    root: string,
    deployment: DeploymentDescriptor | undefined,
    record: (line: string) => void,
): Promise<Declaration> {
    const parts: readonly DeclaredPart[] = (deployment?.ui?.parts ?? []).map((part) => ({
        kind: part.kind,
        id: part.id,
        entry: part.entry,
    }));

    const service = deployment?.service;
    const all = service?.domains === undefined || service.domains.length === 0
        ? parts
        : [...parts, {
            kind: 'service' as const,
            id: deployment?.application ?? 'service',
            entry: service.entry,
            domains: service.domains,
        }];

    const builtAgainst = await resolveDependencies(root, record);

    if (all.length > 0) {
        record(`declares ${String(all.length)} part(s): ${all.map((p) => p.id).join(', ')}`);
    }
    record(`built against ${String(builtAgainst.length)} resolved dependencies`);

    return { parts: all, builtAgainst };
}

/**
 * Every direct dependency, at the version actually installed in the built tree.
 *
 * A dependency that is declared but not installed is **skipped and said out loud**, never guessed at
 * and never recorded from its range. A build that succeeded without installing something is a fact
 * worth seeing in the log; inventing a version for it would put a false fact in the artifact, which
 * is worse than an absent one because something downstream would compare against it.
 *
 * ## Workspaces are the normal case, not an edge case
 *
 * The first draft read only the root `package.json`, and against the first real repository it
 * returned **nothing at all** — `surfdns-console` is an npm workspace whose root manifest declares
 * only `devDependencies`, with `@flybyme/mesh-web` declared in `ui/package.json` and installed
 * hoisted to the root `node_modules`. A fixture could not have caught it, because a fixture is
 * whatever shape the test author had in mind.
 *
 * That is not an unusual layout — it is the layout a repository with a service half and a UI half
 * naturally has, which is the one [hosting §0a](../../../spec/hosting.md) describes. So workspaces
 * are read, and a dependency is resolved workspace-first then root, because that is the order node
 * itself would resolve it.
 */
export async function resolveDependencies(
    root: string,
    record: (line: string) => void,
): Promise<readonly ResolvedDependency[]> {
    const manifest = await readJson(join(root, 'package.json'));
    if (manifest === undefined) {
        record('no package.json in the source — nothing to resolve versions from');
        return [];
    }

    // Name → the directories to look in, nearest first. A package declared by two workspaces is
    // resolved once, from whichever declared it first; if they disagree, node has already picked one
    // and the hoisted copy is what both are running.
    const wanted = new Map<string, string[]>();

    const take = (from: Record<string, unknown>, dir: string): void => {
        for (const name of [...Object.keys(asRecord(from['dependencies'])),
            ...Object.keys(asRecord(from['peerDependencies']))]) {
            const dirs = wanted.get(name) ?? [];
            if (!dirs.includes(dir)) dirs.push(dir);
            wanted.set(name, dirs);
        }
    };

    take(manifest, root);

    const workspaces = await workspaceDirs(root, manifest);
    for (const dir of workspaces) {
        const inner = await readJson(join(dir, 'package.json'));
        if (inner !== undefined) take(inner, dir);
    }
    if (workspaces.length > 0) {
        record(`reading ${String(workspaces.length)} workspace package(s)`);
    }

    const commits = await gitCommits(root);

    const resolved: ResolvedDependency[] = [];
    const missing: string[] = [];

    for (const name of [...wanted.keys()].sort()) {
        // Workspace-local first, then the hoisted root — the order node resolves in.
        const from = [...(wanted.get(name) ?? []), root];
        let version: string | undefined;

        for (const dir of from) {
            const installed = await readJson(join(dir, 'node_modules', ...name.split('/'), 'package.json'));
            const found = installed?.['version'];
            if (typeof found === 'string' && found.trim() !== '') {
                version = found;
                break;
            }
        }

        if (version === undefined) {
            missing.push(name);
            continue;
        }

        const commit = commits.get(name);
        resolved.push(commit === undefined ? { package: name, version } : { package: name, version, commit });
    }

    if (missing.length > 0) {
        record(`not installed, so not recorded: ${missing.join(', ')}`);
    }

    const fromGit = resolved.filter((r) => r.commit !== undefined);
    if (fromGit.length > 0) {
        record(`from git, pinned by commit: ${fromGit.map((r) => r.package).join(', ')}`);
    }

    return resolved;
}

/**
 * Package name → the commit it was installed from, for git dependencies.
 *
 * From the lockfile, because nothing else knows. An installed package's own `package.json` carries
 * the version its author wrote and no trace of which commit was fetched — see `ResolvedDependency`
 * for why that makes `version` useless for the one dependency it most needs to describe.
 *
 * One lockfile at the root, even with workspaces, which is why this reads a single file.
 */
async function gitCommits(root: string): Promise<Map<string, string>> {
    const found = new Map<string, string>();

    const lock = await readJson(join(root, 'package-lock.json'));
    if (lock === undefined) return found;

    for (const [path, entry] of Object.entries(asRecord(lock['packages']))) {
        const at = path.lastIndexOf('node_modules/');
        if (at === -1) continue;

        const name = path.slice(at + 'node_modules/'.length);
        const resolved = asRecord(entry)['resolved'];
        if (typeof resolved !== 'string') continue;

        // `git+ssh://git@github.com/owner/repo.git#<sha>` — a registry tarball URL has no fragment,
        // so this selects git dependencies without having to recognise a host.
        const hash = resolved.lastIndexOf('#');
        if (hash === -1) continue;

        const commit = resolved.slice(hash + 1);
        if (/^[0-9a-f]{40}$/.test(commit)) found.set(name, commit);
    }

    return found;
}

/**
 * The workspace directories a manifest declares.
 *
 * A trailing `/*` is expanded one level, which is the form nearly every workspace repository uses.
 * Deeper globs are not, and a directory that does not exist is skipped rather than throwing — this
 * runs after a successful build, and refusing to record a version because a glob was exotic would
 * trade a whole artifact's declaration for a formatting opinion.
 */
async function workspaceDirs(root: string, manifest: Record<string, unknown>): Promise<string[]> {
    const raw = manifest['workspaces'];
    const patterns = Array.isArray(raw)
        ? raw.filter((p): p is string => typeof p === 'string')
        : (asRecord(raw)['packages'] as unknown[] | undefined ?? [])
            .filter((p): p is string => typeof p === 'string');

    const dirs: string[] = [];

    for (const pattern of patterns) {
        if (!pattern.includes('*')) {
            dirs.push(join(root, pattern));
            continue;
        }
        if (!pattern.endsWith('/*')) continue;

        const parent = join(root, pattern.slice(0, -2));
        const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.isDirectory()) dirs.push(join(parent, entry.name));
        }
    }

    return dirs;
}

const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};

/** Absent and unreadable are the same answer here: there is no fact to record. */
async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
    try {
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        return asRecord(parsed);
    } catch {
        return undefined;
    }
}
