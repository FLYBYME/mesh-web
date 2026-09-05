/**
 * What the CDN answers over the mesh — roadmap B1a.
 *
 * The CDN owns `site`: the hostname → artifact map, which is the only thing that makes a deploy a
 * deploy. A build produces content; changing what a hostname points at is what publishes it.
 *
 * These are the *mesh* contracts, not the serving path. What the world sees is a GET on a hostname,
 * answered by `serve.ts` with no mesh call at all when the node's caches are warm. Nothing here is
 * `public`: `site_put` is the deploy, and `site_list` would enumerate every tenant's hostnames.
 *
 * `site` is a set of tools rather than a `defineCrud` collection because a collection needs a
 * database, and a CDN node that will not start without mongo is a worse CDN node — **small,
 * stateless, many, everywhere** (spec/service-modules.md §2). B5a is the item that makes it a
 * collection, once the deployment that needs one exists.
 */

import { defineContract, z } from '@flybyme/mesh';

const MountSchema = z.object({
    at: z.string().min(1),
    artifactDigest: z.string().min(1),
});

// A field missing here is a field deleted from the wire — zod strips what a schema does not
// mention, which is how `Artifact.declaration` was built, stored and then dropped by its own
// contract the same day. Adding to `Site` in the protocol package means adding it here.
const SiteSchema = z.object({
    hostname: z.string(),
    application: z.string(),
    environment: z.string(),
    tenantId: z.string(),
    artifactDigest: z.string(),
    mounts: z.array(MountSchema).optional(),
    updatedAt: z.number(),
});

/**
 * What a hostname serves.
 *
 * The read every serving node makes on a cold cache, and the reason a node asked for a hostname it
 * has never seen can answer at all: everything needed is in the record and the content it names.
 * `optional` rather than a throw — an unknown hostname is a 404, not a fault.
 */
export const siteResolveContract = defineContract({
    domain: 'cdn',
    action: 'site_resolve',
    description: 'What a hostname currently serves.',
    inputSchema: z.object({ hostname: z.string().min(1) }),
    outputSchema: z.object({ site: SiteSchema.optional() }),
    rest: { method: 'GET', path: '/cdn/sites/:hostname' },
    print: (o) => (o.site === undefined ? 'no site' : `${o.site.application} → ${o.site.artifactDigest}`),
});

/**
 * Point a hostname at an artifact. **This is the deploy.**
 *
 * An upsert rather than create-then-update, because a deploy does not care whether the site existed
 * a moment ago, and a two-step publish has a window where the hostname exists and serves nothing.
 */
export const sitePutContract = defineContract({
    domain: 'cdn',
    action: 'site_put',
    description: 'Point a hostname at an artifact — the deploy.',
    inputSchema: z.object({
        hostname: z.string().min(1),
        application: z.string().min(1),
        environment: z.string().min(1),
        tenantId: z.string().min(1),
        artifactDigest: z.string().min(1),
        /** Further artifacts under a path — the shared kernel, and later each part. See `Mount`. */
        mounts: z.array(MountSchema).optional(),
    }),
    outputSchema: z.object({ site: SiteSchema, previousDigest: z.string().optional() }),
    rest: { method: 'PUT', path: '/cdn/sites/:hostname' },
    destructive: true,
    print: (o) => `${o.site.hostname} → ${o.site.artifactDigest}`,
});

export const siteListContract = defineContract({
    domain: 'cdn',
    action: 'site_list',
    description: 'Sites, optionally for one tenant or application.',
    inputSchema: z.object({
        tenantId: z.string().optional(),
        application: z.string().optional(),
    }),
    outputSchema: z.object({ sites: z.array(SiteSchema) }),
    rest: { method: 'GET', path: '/cdn/sites' },
    print: (o) => `${String(o.sites.length)} sites`,
});

export const siteDeleteContract = defineContract({
    domain: 'cdn',
    action: 'site_delete',
    description: 'Stop serving a hostname.',
    inputSchema: z.object({ hostname: z.string().min(1) }),
    outputSchema: z.object({ deleted: z.boolean() }),
    rest: { method: 'DELETE', path: '/cdn/sites/:hostname' },
    destructive: true,
    print: (o) => (o.deleted ? 'deleted' : 'no such site'),
});

export const cdnStatusContract = defineContract({
    domain: 'cdn',
    action: 'status',
    description: 'What this node is serving and what it is holding.',
    inputSchema: z.object({}),
    outputSchema: z.object({
        listening: z.boolean(),
        port: z.number().optional(),
        /** Absent on a shared node. Present on one dedicated to a tenant — B6. */
        tenantId: z.string().optional(),
        sites: z.number(),
        cachedArtifacts: z.number(),
    }),
    rest: { method: 'GET', path: '/cdn/status' },
    print: (o) => `${String(o.sites)} sites, ${String(o.cachedArtifacts)} artifacts cached`,
});

export const cdnContracts = [
    siteResolveContract,
    sitePutContract,
    siteListContract,
    siteDeleteContract,
    cdnStatusContract,
] as const;

/**
 * A hostname now serves something else.
 *
 * Every CDN node listens, and drops that hostname from its cache. **Latency, not correctness**: the
 * mesh delivers events at-most-once (spec/auth.md §3.1), so a node that was down when this fired
 * still picks the change up when its site cache entry expires. The event is what makes a deploy
 * visible in a second rather than in a TTL.
 */
export const SITE_CHANGED_EVENT = 'cdn.site_changed';

export interface SiteChanged {
    readonly hostname: string;
    readonly application?: string;
    readonly environment?: string;
    readonly artifactDigest?: string;
    readonly deleted?: boolean;
    readonly at: number;
}

/**
 * Declared in mesh's registry rather than cast into it.
 *
 * `getEventHandlers` is keyed by `keyof EventRegistry`, so an event this package invented is either
 * declared here or forced past the compiler with `as never` at every use — and `as never` in this
 * codebase is a bug, not a style (spec/type-safety.md).
 */
declare global {
    interface EventRegistry {
        'cdn.site_changed': SiteChanged;
    }
}
