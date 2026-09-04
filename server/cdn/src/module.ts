/**
 * The `cdn` ServiceModule — roadmap B1a.
 *
 * spec/service-modules.md §2: **binds a port**, behind the surfdns proxy, and is small, stateless,
 * many and everywhere. This is the module that turns `serve.ts` from a function into a node.
 *
 * ## The two halves, and why they do not look alike
 *
 * A CDN node answers two very different callers:
 *
 * - **the world**, over HTTP, asking for a hostname and a path. That path touches no mesh call at
 *   all once the node's caches are warm, which is what lets a node be small and many.
 * - **the cluster**, over the mesh, telling it a hostname changed and asking what it is serving.
 *
 * The bytes come from the builder, because the builder owns `artifact` (B1c). One hop per artifact
 * per node, never per request — content addressed by a hash can be cached forever, so a cold cache
 * is slower, not wrong (spec/hosting.md §2).
 */

import type { IServiceBroker, IServiceContext, IServiceModule, ToolContract, z } from '@flybyme/mesh';
import type { Server } from 'node:http';

import type { Artifact, Site } from '@flybyme/mesh-web-protocol';

import { cdnContracts, SITE_CHANGED_EVENT, type SiteChanged } from './contracts.js';
import { createCdn, type ArtifactSource, type CdnServer } from './serve.js';
import { normalizeHostname, type SiteSource } from './sites.js';

/**
 * The one dynamic cast in this file, named.
 *
 * `IServiceBroker` does not declare `call`, `emit` or `on` in a form this module can use directly;
 * confining the cast to one declaration is the containment mesh-api's `ApiBroker` uses, and it means
 * a wrong assumption about the broker is wrong in exactly one place.
 */
interface CdnBroker {
    call(tool: string, params: unknown): Promise<unknown>;
    emit(event: string, payload: unknown): void;
    on(event: string, handler: (payload: unknown) => void): unknown;
}

/**
 * Where `site` records live.
 *
 * An interface for the reason `ArtifactStore` is one: *where* is a deployment decision. The memory
 * implementation is a real single-node deployment as well as what tests use; B5a replaces it with a
 * mesh collection, at which point every node sees every deploy without a line changing here.
 */
export interface SiteStore {
    get(hostname: string): Promise<Site | undefined>;
    put(site: Site): Promise<Site | undefined>;
    delete(hostname: string): Promise<boolean>;
    list(filter: { tenantId?: string; application?: string }): Promise<readonly Site[]>;
}

export function memorySiteStore(): SiteStore {
    const sites = new Map<string, Site>();

    return {
        async get(hostname) { return sites.get(normalizeHostname(hostname)); },

        async put(site) {
            const key = normalizeHostname(site.hostname);
            const previous = sites.get(key);
            sites.set(key, { ...site, hostname: key });
            return previous;
        },

        async delete(hostname) { return sites.delete(normalizeHostname(hostname)); },

        async list(filter) {
            return [...sites.values()].filter((site) =>
                (filter.tenantId === undefined || site.tenantId === filter.tenantId) &&
                (filter.application === undefined || site.application === filter.application));
        },
    };
}

export interface CdnModuleOptions {
    readonly store?: SiteStore;
    /** The HTTP port the world reaches. `0` picks one, which is what a test wants. */
    readonly port?: number;
    readonly host?: string;
    /** Which tenant this node may serve, if it is dedicated to one — B6. */
    readonly tenantId?: string;
    readonly siteTtlMs?: number;
    readonly trustForwardedHost?: boolean;
    /** The builder's published contracts. Strings, so this package never imports the builder. */
    readonly artifactTool?: string;
    readonly blobTool?: string;
    readonly now?: () => number;
    readonly onError?: (error: unknown, context: { readonly action: string }) => void;
}

export interface CdnModule extends IServiceModule {
    readonly store: SiteStore;
    /** The HTTP server, once started. Present so a test can address it without guessing a port. */
    readonly listener: Server | undefined;
    readonly cdn: CdnServer | undefined;
}

export function createCdnModule(options: CdnModuleOptions = {}): CdnModule {
    const store = options.store ?? memorySiteStore();
    const now = options.now ?? Date.now;
    const artifactTool = options.artifactTool ?? 'builder.artifact_get';
    const blobTool = options.blobTool ?? 'builder.artifact_blob';
    const onError = options.onError ?? (() => {});

    let broker: CdnBroker | undefined;
    let cdn: CdnServer | undefined;
    let listener: Server | undefined;
    let port: number | undefined;

    /**
     * Bytes this node has fetched, by content digest.
     *
     * Cached forever and safely: the digest *is* the content, so a blob under one digest can never
     * become different bytes. This is what makes the hop to the builder once per file per node.
     */
    const blobs = new Map<string, Buffer>();

    const artifacts: ArtifactSource = {
        async getArtifact(digest) {
            if (broker === undefined) return undefined;
            const answer = await broker.call(artifactTool, { digest });
            return (answer as { artifact?: Artifact }).artifact;
        },

        async getBlob(digest) {
            const held = blobs.get(digest);
            if (held !== undefined) return held;
            if (broker === undefined) return undefined;

            const answer = await broker.call(blobTool, { digest }) as
                { content?: string; size: number };
            if (answer.content === undefined) return undefined;

            const content = Buffer.from(answer.content, 'base64');
            blobs.set(digest, content);
            return content;
        },
    };

    const sites: SiteSource = { resolve: (hostname) => store.get(hostname) };

    const announce = (event: string, payload: unknown): void => {
        try {
            broker?.emit(event, payload);
        } catch (error) {
            onError(error, { action: event });
        }
    };

    const contracts = cdnContracts as unknown as ToolContract<z.ZodTypeAny, z.ZodTypeAny>[];

    return {
        domain: 'cdn',
        store,
        get listener(): Server | undefined { return listener; },
        get cdn(): CdnServer | undefined { return cdn; },

        getContracts: () => contracts,
        isCrud: () => false,
        async beforeCrud(_d, _a, input) { return input; },
        async afterCrud(_d, _a, output) { return output; },

        /**
         * Every node drops the hostname it was told about — including the one that published it,
         * which costs a single resolve and means there is no "was it me?" branch to get wrong.
         */
        getEventHandlers: () => new Map([
            ['cdn.site_changed', (payload: SiteChanged) => { cdn?.invalidate(payload.hostname); }],
        ]),

        async onStart(started: IServiceBroker): Promise<void> {
            broker = started as unknown as CdnBroker;

            cdn = createCdn({
                sites,
                artifacts,
                ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
                ...(options.siteTtlMs === undefined ? {} : { siteTtlMs: options.siteTtlMs }),
                ...(options.trustForwardedHost === undefined
                    ? {}
                    : { trustForwardedHost: options.trustForwardedHost }),
                ...(options.now === undefined ? {} : { now: options.now }),
                onError: (error, context) => { onError(error, { action: `serve ${context.hostname}` }); },
            });

            // Thrown from onStart when the port is taken, so the mesh sees a module that failed to
            // start rather than a node registered as a CDN that answers nothing.
            listener = await cdn.listen(options.port ?? 0, options.host ?? '0.0.0.0');
            const address = listener.address();
            port = typeof address === 'object' && address !== null ? address.port : options.port;

            started.logger.info(`[cdn] serving on ${String(port)}`);
        },

        async onStop(): Promise<void> {
            const open = listener;
            listener = undefined;
            if (open === undefined) return;
            await new Promise<void>((resolve) => { open.close(() => { resolve(); }); });
        },

        async execute(domain: string, action: string, input: unknown, _ctx: IServiceContext): Promise<unknown> {
            switch (`${domain}.${action}`) {
                case 'cdn.site_resolve': {
                    const site = await store.get((input as { hostname: string }).hostname);
                    return { ...(site === undefined ? {} : { site }) };
                }

                case 'cdn.site_put': {
                    const requested = input as Omit<Site, 'updatedAt'>;
                    const site: Site = { ...requested, updatedAt: now() };
                    const previous = await store.put(site);

                    // Locally first, so this node is correct before anything is announced. The event
                    // is what makes every *other* node fast; the TTL is what makes them right.
                    cdn?.invalidate(site.hostname);
                    announce(SITE_CHANGED_EVENT, {
                        hostname: normalizeHostname(site.hostname),
                        application: site.application,
                        environment: site.environment,
                        artifactDigest: site.artifactDigest,
                        at: site.updatedAt,
                    });

                    return {
                        site: { ...site, hostname: normalizeHostname(site.hostname) },
                        ...(previous === undefined ? {} : { previousDigest: previous.artifactDigest }),
                    };
                }

                case 'cdn.site_list':
                    return { sites: await store.list(input as { tenantId?: string; application?: string }) };

                case 'cdn.site_delete': {
                    const { hostname } = input as { hostname: string };
                    const deleted = await store.delete(hostname);
                    if (deleted) {
                        cdn?.invalidate(hostname);
                        announce(SITE_CHANGED_EVENT, {
                            hostname: normalizeHostname(hostname), deleted: true, at: now(),
                        });
                    }
                    return { deleted };
                }

                case 'cdn.status':
                    return {
                        listening: listener !== undefined,
                        ...(port === undefined ? {} : { port }),
                        ...(options.tenantId === undefined ? {} : { tenantId: options.tenantId }),
                        sites: (await store.list({})).length,
                        cachedArtifacts: blobs.size,
                    };

                default:
                    throw new Error(`cdn has no action "${action}"`);
            }
        },
    };
}
