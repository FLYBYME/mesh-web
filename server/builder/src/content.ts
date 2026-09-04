/**
 * Content addressing, and the input hash.
 *
 * spec/hosting.md §6. Two of the builder's requirements are really one idea:
 *
 * - **the artifact is content, not a path** — so it can move between nodes
 * - **builds are cacheable by input hash** — so the same source and environment do not rebuild
 *
 * Both need a hash that means the same thing everywhere, which is what this file is for. Everything
 * here is pure and synchronous, because a hash that depended on when or where it was computed would
 * defeat the point of having one.
 */

import { createHash } from 'node:crypto';

import type { ArtifactFile, BuildInputs, SourceRef } from '@flybyme/mesh-web-protocol';

/** `sha256:` and 32 hex characters. Long enough to be safe, short enough to read in a log. */
export const digestOf = (content: Buffer | string): string =>
    `sha256:${createHash('sha256').update(content).digest('hex').slice(0, 32)}`;

/**
 * JSON with every object's keys sorted, so equal values serialise equally.
 *
 * `JSON.stringify` alone orders keys by insertion, so two descriptors that mean the same thing would
 * hash differently depending on how they were built — and a cache that missed on that would look
 * like a builder that never caches.
 */
export function canonical(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

    const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));

    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/**
 * The digest of a whole file set.
 *
 * Over the *names and digests*, sorted — not over the concatenated bytes. Two artifacts with the
 * same files in a different order are the same artifact, and a node that already holds one can skip
 * the fetch. Hashing the bytes in directory order would make that depend on a filesystem.
 */
export function artifactDigest(files: readonly ArtifactFile[]): string {
    const manifest = [...files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => `${file.path} ${file.digest}`)
        .join('\n');

    return digestOf(manifest);
}

/**
 * The hash of everything that determines the output.
 *
 * **A branch is not an input.** `main` hashes to itself forever while the code underneath it
 * changes, so a cache keyed on it would serve a stale artifact indefinitely — which is worse than
 * not caching. `resolveSource` must have turned a ref into a commit before this is called, and
 * this refuses anything that has not been.
 */
export function inputHash(inputs: BuildInputs): string {
    assertResolved(inputs.source);
    return digestOf(canonical(inputs));
}

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * A source reference that a hash can be trusted against.
 *
 * Throws rather than warning: a cache key computed from a branch name is a bug that shows up as
 * "the deploy did nothing", days later, with nothing in a log.
 */
export function assertResolved(source: SourceRef): void {
    if (source.kind === 'archive') {
        if (source.digest.trim() === '') {
            throw new Error('An archive source needs a digest, or nothing can tell whether it changed.');
        }
        return;
    }

    if (!COMMIT.test(source.ref)) {
        throw new Error(
            `Source ref "${source.ref}" is not a commit. A branch hashes to itself while the code ` +
            `underneath it changes, so a build cached on one would serve a stale artifact forever. ` +
            `Resolve it first.`,
        );
    }
}

/**
 * Content type from a file name.
 *
 * Kept here rather than pulled in, because the set that matters for a built site is small and a
 * wrong answer is a page that does not run. `.js` as `text/javascript` in particular: a browser
 * refuses a module served as `text/plain`, and that failure is silent in the network tab.
 */
const TYPES: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.txt': 'text/plain; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.wasm': 'application/wasm',
};

export function contentTypeOf(path: string): string {
    const dot = path.lastIndexOf('.');
    if (dot < 0) return 'application/octet-stream';
    return TYPES[path.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}
