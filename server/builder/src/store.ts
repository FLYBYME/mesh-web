/**
 * Where artifact bytes live.
 *
 * An interface, because *where* is a deployment decision and the builder must not know it. The
 * previous generation's `UIArtifact.filePath` was an absolute path on whichever node built it, so an
 * artifact could not move; here the only address is a content digest, and a store is anything that
 * can hold bytes under one.
 *
 * The memory implementation below is a real single-node deployment as well as what tests use. A
 * mesh-backed one (B9) puts the bytes in a collection so any node can fetch what it does not hold.
 */

import type { Artifact } from '@flybyme/mesh-web-protocol';

export interface ArtifactStore {
    /** Has this node got these bytes already? The question that makes a cold cache merely slow. */
    hasBlob(digest: string): Promise<boolean>;
    getBlob(digest: string): Promise<Buffer | undefined>;
    putBlob(digest: string, content: Buffer): Promise<void>;

    getArtifact(digest: string): Promise<Artifact | undefined>;
    putArtifact(artifact: Artifact): Promise<void>;

    usage(): Promise<{ readonly blobs: number; readonly bytes: number }>;
}

/**
 * Everything in Maps.
 *
 * Blobs are keyed by digest and therefore **shared between artifacts**: two builds that changed one
 * file store one new blob, not two whole sites. That falls out of content addressing rather than
 * being an optimisation anybody wrote.
 */
export function memoryArtifactStore(): ArtifactStore {
    const blobs = new Map<string, Buffer>();
    const artifacts = new Map<string, Artifact>();

    return {
        async hasBlob(digest) { return blobs.has(digest); },
        async getBlob(digest) { return blobs.get(digest); },
        async putBlob(digest, content) {
            // Immutable by construction: the digest *is* the content, so a second write of the same
            // key is either identical or a hash collision, and overwriting would be wrong either way.
            if (!blobs.has(digest)) blobs.set(digest, content);
        },

        async getArtifact(digest) { return artifacts.get(digest); },
        async putArtifact(artifact) { artifacts.set(artifact.digest, artifact); },

        async usage() {
            let bytes = 0;
            for (const blob of blobs.values()) bytes += blob.length;
            return { blobs: blobs.size, bytes };
        },
    };
}
