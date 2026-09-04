/**
 * What the builder answers over the mesh — roadmap B1b, and the published half of B1c.
 *
 * B1c decided who owns `artifact`: **the builder**, because a module owns what it writes and
 * publishes contracts for what others need. `artifact_get` and `artifact_blob` below *are* that
 * published contract — the CDN and the API read an artifact through them and never through a store
 * they share, which is what keeps "where the bytes live" a deployment decision rather than a fact
 * two modules both depend on.
 *
 * Everything here is `internal`. A builder on the public internet is a stranger's build command
 * running on your machine, and `artifact_blob` would serve any tenant's bytes to anyone who could
 * guess a digest. What the world sees is a CDN serving a hostname; this is how the cluster talks to
 * itself.
 */

import { defineContract, z } from '@flybyme/mesh';

// ---------------------------------------------------------------------------- shapes

const SourceRefSchema = z.union([
    z.object({
        kind: z.literal('git'),
        repository: z.string().min(1),
        ref: z.string().min(1),
        subdirectory: z.string().optional(),
    }),
    z.object({
        kind: z.literal('archive'),
        url: z.string().min(1),
        digest: z.string().min(1),
    }),
]);

const ArtifactFileSchema = z.object({
    path: z.string(),
    digest: z.string(),
    size: z.number(),
    contentType: z.string(),
});

const ArtifactSchema = z.object({
    digest: z.string(),
    files: z.array(ArtifactFileSchema),
    totalSize: z.number(),
    builtAt: z.number(),
    buildId: z.string(),
});

const BuildSchema = z.object({
    id: z.string(),
    application: z.string(),
    environment: z.string(),
    source: SourceRefSchema,
    inputHash: z.string(),
    state: z.enum(['queued', 'fetching', 'building', 'publishing', 'succeeded', 'failed']),
    startedAt: z.number(),
    finishedAt: z.number().optional(),
    artifactDigest: z.string().optional(),
    error: z.string().optional(),
    log: z.string().optional(),
});

// ---------------------------------------------------------------------------- builds

/**
 * Build a repository.
 *
 * The environment is named, not described: **the descriptor comes from the repository** (B8), so a
 * caller says "build `production` of this ref" and cannot say what production means. That is the
 * same decision C3.2 made for exposure — the site's own team owns what it exposes and where it runs,
 * and a caller who could pass a descriptor could point a site's production build at another API.
 */
export const buildStartContract = defineContract({
    domain: 'builder',
    action: 'build_start',
    description: 'Build an environment of a repository into an artifact.',
    inputSchema: z.object({
        source: SourceRefSchema,
        environment: z.string().min(1).default('production'),
        /**
         * Publish the resulting artifact to this hostname when the build succeeds.
         *
         * The deploy and the build are one call because they are one intention, and separating them
         * leaves a cluster full of artifacts nobody can name. Absent means build only.
         */
        publish: z.boolean().default(false),
    }),
    outputSchema: z.object({
        build: BuildSchema,
        artifact: ArtifactSchema.optional(),
        /** True when an identical input hash had already been built and nothing ran. */
        cached: z.boolean(),
        /** The hostname this artifact was published to, when `publish` was set and it succeeded. */
        hostname: z.string().optional(),
    }),
    rest: { method: 'POST', path: '/builder/builds' },
    destructive: true,
    timeout: 10 * 60_000,
    print: (o) => `${o.build.state} ${o.build.id}${o.cached ? ' (cached)' : ''}`,
});

export const buildStatusContract = defineContract({
    domain: 'builder',
    action: 'build_status',
    description: 'A build by id, or the most recent builds.',
    inputSchema: z.object({
        id: z.string().optional(),
        application: z.string().optional(),
        limit: z.number().optional(),
    }),
    outputSchema: z.object({ builds: z.array(BuildSchema) }),
    rest: { method: 'GET', path: '/builder/builds' },
    print: (o) => `${String(o.builds.length)} builds`,
});

// ---------------------------------------------------------------------------- artifacts

export const artifactGetContract = defineContract({
    domain: 'builder',
    action: 'artifact_get',
    description: 'An artifact manifest by digest.',
    inputSchema: z.object({ digest: z.string().min(1) }),
    // `optional` rather than a throw: a CDN node asking for something it may not have is a normal
    // question, and an exception per cache miss makes a miss look like a fault.
    outputSchema: z.object({ artifact: ArtifactSchema.optional() }),
    rest: { method: 'GET', path: '/builder/artifacts/:digest' },
    print: (o) => (o.artifact === undefined ? 'not found' : `${String(o.artifact.files.length)} files`),
});

/**
 * The bytes of one file.
 *
 * Base64 over the mesh, which is the honest cost of a JSON serializer: a CDN node pays it **once per
 * file per node**, because content addressed by a hash can be cached forever and never re-fetched.
 * A binary transport would make it cheaper without making it different.
 */
export const artifactBlobContract = defineContract({
    domain: 'builder',
    action: 'artifact_blob',
    description: 'The bytes of one file, by content digest.',
    inputSchema: z.object({ digest: z.string().min(1) }),
    outputSchema: z.object({
        content: z.string().optional().describe('base64'),
        size: z.number(),
    }),
    rest: { method: 'GET', path: '/builder/blobs/:digest' },
    print: (o) => `${String(o.size)} bytes`,
});

export const builderContracts = [
    buildStartContract,
    buildStatusContract,
    artifactGetContract,
    artifactBlobContract,
] as const;

// ---------------------------------------------------------------------------- events

/**
 * What the builder announces.
 *
 * Latency, never correctness — the same rule auth §3.1 arrived at for revocation, for the same
 * reason: the mesh delivers events **at-most-once**, so a CDN that was down when
 * `builder.build_completed` fired must still end up serving the new artifact. It does, because the
 * deploy is a `site` record and the CDN's site cache has a TTL. The event is what makes it fast.
 */
export const BUILD_STARTED_EVENT = 'builder.build_started';
export const BUILD_COMPLETED_EVENT = 'builder.build_completed';
export const BUILD_FAILED_EVENT = 'builder.build_failed';
