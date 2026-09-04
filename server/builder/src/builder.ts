/**
 * The builder — roadmap B2, spec/hosting.md §6.
 *
 * Fetch, build, publish. The one hard requirement, stated explicitly in the roadmap: **the code must
 * not have to be local to the server.** That was the defect in the previous generation, and it is
 * not a limitation you can work around later — it decides whether a build can happen anywhere, and
 * therefore whether builders can be added, replaced or run in a different region at all.
 *
 * So the shape is:
 *
 *   SourceRef  →  a scratch workspace this builder owns  →  files  →  content-addressed artifact
 *
 * Nothing outside gets a path. The workspace is created, used and destroyed inside `build`, and the
 * only thing that leaves is content plus a digest.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';

import type {
    Artifact, ArtifactFile, Build, BuildInputs, EnvironmentDescriptor, SourceRef,
} from '@flybyme/mesh-web-protocol';

import { artifactDigest, contentTypeOf, digestOf, inputHash } from './content.js';
import { DESCRIPTOR_FILE, environmentOf, loadDescriptor } from './descriptor.js';
import type { ArtifactStore } from './store.js';

const run = promisify(execFile);

/** Bumped when a change here could change the output. It is part of the cache key. */
export const BUILDER_VERSION = '1';

export interface BuilderOptions {
    readonly store: ArtifactStore;
    /** How long a build may take before it is killed. A hung build must not hold a worker forever. */
    readonly timeoutMs?: number;
    /** Largest artifact this builder will publish. */
    readonly maxBytes?: number;
    readonly now?: () => number;
    readonly onLog?: (line: string) => void;
    /** Overridable so a test can build from a directory without a git server. */
    readonly fetcher?: Fetcher;
}

/**
 * How a `SourceRef` becomes a workspace.
 *
 * Injected so the *rule* can be tested without a network: a fetcher receives a reference and a
 * destination it did not choose, which is what stops a source ever being "wherever it already is".
 */
export type Fetcher = (source: SourceRef, into: string) => Promise<void>;

export interface BuildRequest {
    /**
     * Which application this is.
     *
     * Optional, because the repository names itself (B8). A caller that passes one is overriding
     * what the repository says, which is a thing a test does and a deployment should not.
     */
    readonly application?: string;
    readonly environment: string;
    readonly source: SourceRef;
    /**
     * The environment to build, if the caller already has it.
     *
     * **Absent is the normal case**: the descriptor is read out of the fetched source, so the site's
     * own team owns where it runs (B8, spec/hosting.md §5). Present is how a test builds without a
     * descriptor file, and how a caller that already read one avoids a second parse.
     */
    readonly descriptor?: EnvironmentDescriptor;
}

export interface BuildResult {
    readonly build: Build;
    readonly artifact?: Artifact;
    /** True when an identical input hash had already been built and nothing ran. */
    readonly cached: boolean;
    /**
     * What the repository declared, when the descriptor came from it.
     *
     * The caller needs it to publish: the host is in here, and the host *is* the site.
     */
    readonly descriptor?: EnvironmentDescriptor;
}

/** A build that failed before its repository could say what application it is. */
const UNNAMED = '(unnamed)';

export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

export function createBuilder(options: BuilderOptions) {
    const store = options.store;
    const now = options.now ?? Date.now;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const fetch = options.fetcher ?? gitFetcher;
    const log = options.onLog ?? (() => {});

    /** Input hash → artifact digest. What makes a repeat build not a build at all. */
    const built = new Map<string, string>();

    let counter = 0;

    return {
        /** Exposed so `build_status` can answer, and so a test can assert a cache hit. */
        knownInputs: (): ReadonlyMap<string, string> => built,

        async build(request: BuildRequest): Promise<BuildResult> {
            const id = `b${String(++counter)}`;
            const startedAt = now();

            const inputsFor = (descriptor: EnvironmentDescriptor | undefined): BuildInputs => ({
                source: request.source,
                environment: request.environment,
                policy: descriptor?.policy ?? {},
                builderVersion: BUILDER_VERSION,
            });

            // Throws on an unresolved ref, before a workspace exists. A branch hashes to itself while
            // the code changes, so a build cached on one would serve a stale artifact forever.
            let base = {
                id,
                application: request.application ?? UNNAMED,
                environment: request.environment,
                source: request.source,
                inputHash: inputHash(inputsFor(request.descriptor)),
                startedAt,
            };

            /** A hit, or nothing. Content-addressed, so "built before" and "still held" are one question. */
            const hit = async (hash: string): Promise<Artifact | undefined> => {
                const previous = built.get(hash);
                return previous === undefined ? undefined : store.getArtifact(previous);
            };

            const succeededFromCache = (artifact: Artifact, log?: string): BuildResult => ({
                cached: true,
                artifact,
                build: {
                    ...base,
                    state: 'succeeded',
                    finishedAt: now(),
                    artifactDigest: artifact.digest,
                    ...(log === undefined ? {} : { log }),
                },
            });

            // Same source, same environment, same policy, same builder. §6: reproducible enough to be
            // cached by input hash — so nothing runs, not even a clone.
            //
            // Only possible when the caller supplied the descriptor. When it comes from the
            // repository (B8) the policy is *in* the source, so the hash is not knowable until after
            // the fetch and the check happens below instead. A shallow clone is what it costs to let
            // a repository own its own deployment, and it is cheap beside a build.
            if (request.descriptor !== undefined) {
                const artifact = await hit(base.inputHash);
                if (artifact !== undefined) return succeededFromCache(artifact);
            }

            // The workspace is *ours*, and it is destroyed below. A caller never learns where it was,
            // which is the whole of "the code need not be local to the server".
            const workspace = await mkdtemp(join(tmpdir(), 'mesh-build-'));
            const lines: string[] = [];
            const record = (line: string): void => { lines.push(line); log(line); };

            let environment: EnvironmentDescriptor | undefined = request.descriptor;

            try {
                record(`fetching ${describeSource(request.source)}`);
                await fetch(request.source, workspace);

                const root = request.source.kind === 'git' && request.source.subdirectory !== undefined
                    ? join(workspace, request.source.subdirectory)
                    : workspace;

                if (environment === undefined) {
                    const declared = await loadDescriptor(root);
                    environment = environmentOf(declared, request.environment);
                    base = {
                        ...base,
                        // What the repository calls itself wins, unless the caller insisted.
                        application: request.application ?? declared.application,
                        inputHash: inputHash(inputsFor(environment)),
                    };
                    record(
                        `${declared.application} ${request.environment} → ${environment.host} ` +
                        `(api ${environment.api})`,
                    );

                    const artifact = await hit(base.inputHash);
                    if (artifact !== undefined) {
                        record(`cached: ${artifact.digest}`);
                        return { ...succeededFromCache(artifact, lines.join('\n')), descriptor: environment };
                    }
                }

                const command = environment.build?.command;
                if (command !== undefined) {
                    record(`building: ${command}`);
                    const { stdout, stderr } = await run('sh', ['-c', command], {
                        cwd: root,
                        timeout,
                        maxBuffer: 8 * 1024 * 1024,
                        env: {
                            ...process.env,
                            // The build sees the environment it is being built for, so a site can
                            // bake its API origin in without the builder knowing what an API is.
                            MESH_ENVIRONMENT: request.environment,
                            MESH_API: environment.api,
                            MESH_HOST: environment.host,
                        },
                    });
                    if (stdout.trim() !== '') record(stdout.trim());
                    if (stderr.trim() !== '') record(stderr.trim());
                }

                const output = environment.build?.output ?? 'dist';
                const outputDir = join(root, output);

                // Checked before walking, so a missing directory is reported as *that* rather than
                // as an ENOENT naming a scratch path the caller has never heard of and cannot act
                // on. The name in the message is the one they configured.
                const exists = await stat(outputDir).then((s) => s.isDirectory()).catch(() => false);
                if (!exists) {
                    throw new Error(
                        `The build produced no "${output}" directory. Check "ui.build" and ` +
                        `"ui.output" in ${DESCRIPTOR_FILE}.`,
                    );
                }

                const files = await collect(outputDir, store, maxBytes, record);

                if (files.length === 0) {
                    throw new Error(
                        `The build produced no files in "${output}". An empty artifact would serve a ` +
                        `blank site rather than fail, so it is refused here.`,
                    );
                }

                const artifact: Artifact = {
                    digest: artifactDigest(files),
                    files,
                    totalSize: files.reduce((sum, f) => sum + f.size, 0),
                    builtAt: now(),
                    buildId: id,
                };

                await store.putArtifact(artifact);
                built.set(base.inputHash, artifact.digest);
                record(`published ${artifact.digest} (${String(files.length)} files, ${String(artifact.totalSize)} bytes)`);

                return {
                    cached: false,
                    artifact,
                    descriptor: environment,
                    build: {
                        ...base,
                        state: 'succeeded',
                        finishedAt: now(),
                        artifactDigest: artifact.digest,
                        log: lines.join('\n'),
                    },
                };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                record(`failed: ${message}`);

                // The log travels with the failure. A failed build with no output is a bug report
                // nobody can act on, and the workspace it happened in is already gone.
                return {
                    cached: false,
                    ...(environment === undefined ? {} : { descriptor: environment }),
                    build: { ...base, state: 'failed', finishedAt: now(), error: message, log: lines.join('\n') },
                };
            } finally {
                await rm(workspace, { recursive: true, force: true });
            }
        },
    };
}

// ---------------------------------------------------------------------------- collecting

/**
 * Walk the output directory into content-addressed files.
 *
 * Every path is checked to be inside the output directory. A build that writes a symlink out of its
 * own tree would otherwise publish whatever it pointed at — the builder runs untrusted code from a
 * repository, and that is the whole threat model.
 */
async function collect(
    outputDir: string,
    store: ArtifactStore,
    maxBytes: number,
    log: (line: string) => void,
): Promise<ArtifactFile[]> {
    const files: ArtifactFile[] = [];
    let total = 0;

    const walk = async (dir: string): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
            const full = join(dir, entry.name);

            // Resolved against the real output root, so `..` and symlinks cannot escape.
            const rel = relative(outputDir, full);
            if (rel.startsWith('..') || rel.startsWith(sep)) {
                log(`skipped ${entry.name}: outside the output directory`);
                continue;
            }

            if (entry.isSymbolicLink()) {
                const target = await stat(full).catch(() => undefined);
                if (target === undefined) continue;
                if (target.isDirectory()) continue;   // a symlinked directory is not walked
            }

            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }

            const content = await readFile(full);
            total += content.length;
            if (total > maxBytes) {
                throw new Error(`The build produced more than ${String(maxBytes)} bytes.`);
            }

            const digest = digestOf(content);
            await store.putBlob(digest, content);

            files.push({
                // Always forward slashes: this is a name inside an artifact, not a path on the
                // machine that happened to build it.
                path: rel.split(sep).join('/'),
                digest,
                size: content.length,
                contentType: contentTypeOf(entry.name),
            });
        }
    };

    await walk(outputDir);
    return files;
}

// ---------------------------------------------------------------------------- fetching

const describeSource = (source: SourceRef): string =>
    source.kind === 'git' ? `${source.repository}@${source.ref}` : source.url;

/**
 * Clone one commit into a workspace the builder owns.
 *
 * `--depth 1` of a single revision: a builder needs the tree at one commit and nothing else, and
 * fetching a project's whole history to build one page is the difference between a fast builder and
 * a slow one.
 */
export const gitFetcher: Fetcher = async (source, into) => {
    if (source.kind !== 'git') {
        throw new Error(`gitFetcher cannot fetch a ${source.kind} source.`);
    }

    await run('git', ['init', '--quiet'], { cwd: into });
    await run('git', ['remote', 'add', 'origin', source.repository], { cwd: into });
    await run('git', ['fetch', '--quiet', '--depth', '1', 'origin', source.ref], { cwd: into });
    await run('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: into });
};

/**
 * Turn a branch or tag into the commit it currently points at.
 *
 * Called *before* a build so the input hash is over a commit. Without it a cache keyed on `main`
 * would answer the same forever while the code moved underneath it.
 */
export async function resolveSource(source: SourceRef): Promise<SourceRef> {
    if (source.kind !== 'git') return source;
    if (/^[0-9a-f]{40}$/.test(source.ref)) return source;

    const { stdout } = await run('git', ['ls-remote', source.repository, source.ref]);
    const commit = stdout.split(/\s/)[0];

    if (commit === undefined || commit === '') {
        throw new Error(`${source.repository} has no ref "${source.ref}".`);
    }

    return { ...source, ref: commit };
}
