/**
 * The `builder` ServiceModule — roadmap B1b.
 *
 * spec/service-modules.md §2: **binds nothing.** It is woken by mesh calls and events, it is large
 * and few, and it scales with pushes rather than with traffic. Running one inside every CDN node
 * would put a build's memory and CPU next to page serving, which is exactly the coupling §3 split
 * them to avoid.
 *
 * Duck-typed rather than `extends ServiceModule`, for the reason mesh-api's and mesh-identity's
 * modules are: `registerModule` takes the `IServiceModule` interface and never checks `instanceof`,
 * so implementing the members it calls keeps this a plain object with no inherited lifecycle.
 *
 * ## What it owns, and what it asks for
 *
 * It owns `build` and `artifact` (B1c) and publishes `artifact_get` / `artifact_blob` so the CDN can
 * read them. It does **not** own `site`: publishing a deploy is a call to `cdn.site_put`, because a
 * module owns what it writes and the hostname map is the CDN's. That is one hop in the deploy path,
 * which happens once per push.
 */

import type { IServiceBroker, IServiceContext, IServiceModule, ToolContract, z } from '@flybyme/mesh';

import type { Artifact, Build, EnvironmentDescriptor, SourceRef } from '@flybyme/mesh-web-protocol';

import { createBuilder, resolveSource, type BuildResult, type Fetcher } from './builder.js';
import {
    builderContracts, BUILD_COMPLETED_EVENT, BUILD_FAILED_EVENT, BUILD_STARTED_EVENT,
} from './contracts.js';
import { memoryArtifactStore, type ArtifactStore } from './store.js';

/**
 * The two members of the broker this module uses beyond the ones mesh calls on it.
 *
 * Named, so the one dynamic cast in the file is confined to a single declaration — the same
 * containment mesh-api's `ApiBroker` uses, and for the same reason: a cast that appears in ten
 * places is ten places where the shape can be wrong.
 */
interface BuilderBroker {
    call(tool: string, params: unknown): Promise<unknown>;
    emit(event: string, payload: unknown): void;
}

export interface BuilderModuleOptions {
    readonly store?: ArtifactStore;
    /** Overridable so a test can build from a directory without a git server. */
    readonly fetcher?: Fetcher;
    readonly timeoutMs?: number;
    readonly maxBytes?: number;
    /** How many finished builds to keep for `build_status`. */
    readonly history?: number;
    /**
     * The contract the CDN answers on to record a deploy.
     *
     * A string rather than an import: this module must not depend on the CDN package, or the two
     * could not be deployed separately, which is the whole of §3.
     */
    readonly siteTool?: string;
    readonly now?: () => number;
    readonly onError?: (error: unknown, context: { readonly action: string }) => void;
}

export interface BuilderModule extends IServiceModule {
    readonly store: ArtifactStore;
    /** Finished builds, newest first. Present so a test can look without going through the mesh. */
    readonly builds: readonly Build[];
}

export const DEFAULT_HISTORY = 100;

export function createBuilderModule(options: BuilderModuleOptions = {}): BuilderModule {
    const store = options.store ?? memoryArtifactStore();
    const now = options.now ?? Date.now;
    const historyLimit = options.history ?? DEFAULT_HISTORY;
    const siteTool = options.siteTool ?? 'cdn.site_put';
    const onError = options.onError ?? (() => {});

    const builder = createBuilder({
        store,
        ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
        ...(options.now === undefined ? {} : { now: options.now }),
    });

    /** Newest first, bounded. A builder that remembered every build would grow without limit. */
    const builds: Build[] = [];

    let broker: BuilderBroker | undefined;

    const contracts = builderContracts as unknown as ToolContract<z.ZodTypeAny, z.ZodTypeAny>[];

    /** Fire and forget. An emit that fails costs latency, never correctness — see contracts.ts. */
    const announce = (event: string, payload: unknown): void => {
        try {
            broker?.emit(event, payload);
        } catch (error) {
            onError(error, { action: event });
        }
    };

    const remember = (build: Build): void => {
        builds.unshift(build);
        if (builds.length > historyLimit) builds.length = historyLimit;
    };

    /**
     * Record the deploy.
     *
     * `tenantId` comes from the caller, never from the repository (see descriptor.ts): a repo that
     * could name its own owner could name someone else's, and the hostname is the isolation
     * boundary. The CDN then refuses to serve a site whose tenant is not its own (B6).
     */
    const publish = async (
        descriptor: EnvironmentDescriptor,
        result: BuildResult,
        environment: string,
        tenantId: string,
    ): Promise<string | undefined> => {
        if (broker === undefined || result.artifact === undefined) return undefined;

        await broker.call(siteTool, {
            hostname: descriptor.host,
            application: result.build.application,
            environment,
            tenantId,
            artifactDigest: result.artifact.digest,
        });

        return descriptor.host;
    };

    return {
        domain: 'builder',
        store,
        get builds(): readonly Build[] { return builds; },

        getContracts: () => contracts,
        isCrud: () => false,
        getEventHandlers: () => new Map(),
        async beforeCrud(_d, _a, input) { return input; },
        async afterCrud(_d, _a, output) { return output; },

        async onStart(started: IServiceBroker): Promise<void> {
            broker = started as unknown as BuilderBroker;
            started.logger.info('[builder] ready — binds nothing, woken by calls');
        },

        async execute(domain: string, action: string, input: unknown, ctx: IServiceContext): Promise<unknown> {
            switch (`${domain}.${action}`) {
                case 'builder.build_start': {
                    const request = input as {
                        source: SourceRef;
                        environment: string;
                        publish: boolean;
                        tenantId?: string;
                    };

                    // Settled before anything is fetched or built, because it can only fail, and a
                    // refusal that arrives after a five-minute build has already run a stranger's
                    // build command to tell them no. Nothing here depends on the build's outcome.
                    const tenantId = request.publish ? tenantFor(ctx, request.tenantId) : undefined;

                    // A branch is turned into the commit it points at *before* anything is hashed, or
                    // a build cached on `main` would answer the same forever while the code moved.
                    const source = await resolveSource(request.source);

                    announce(BUILD_STARTED_EVENT, {
                        environment: request.environment,
                        source,
                        at: now(),
                    });

                    const result = await builder.build({ environment: request.environment, source });
                    remember(result.build);

                    if (result.build.state === 'failed') {
                        announce(BUILD_FAILED_EVENT, {
                            buildId: result.build.id,
                            application: result.build.application,
                            environment: request.environment,
                            error: result.build.error,
                            at: now(),
                        });
                        // Returned rather than thrown: a build that did not compile is an answer, and
                        // an exception would lose the log, which is the only thing that says why.
                        return { build: result.build, cached: result.cached };
                    }

                    let hostname: string | undefined;
                    if (tenantId !== undefined && result.descriptor !== undefined) {
                        hostname = await publish(result.descriptor, result, request.environment, tenantId);
                    }

                    announce(BUILD_COMPLETED_EVENT, {
                        buildId: result.build.id,
                        application: result.build.application,
                        environment: request.environment,
                        artifactDigest: result.build.artifactDigest,
                        cached: result.cached,
                        ...(hostname === undefined ? {} : { hostname }),
                        at: now(),
                    });

                    return {
                        build: result.build,
                        ...(result.artifact === undefined ? {} : { artifact: result.artifact }),
                        cached: result.cached,
                        ...(hostname === undefined ? {} : { hostname }),
                    };
                }

                case 'builder.build_status': {
                    const { id, application, limit } = input as
                        { id?: string; application?: string; limit?: number };

                    const matching = builds.filter((build) =>
                        (id === undefined || build.id === id) &&
                        (application === undefined || build.application === application));

                    return { builds: matching.slice(0, limit ?? 20) };
                }

                case 'builder.artifact_get': {
                    const artifact = await store.getArtifact((input as { digest: string }).digest);
                    return { ...(artifact === undefined ? {} : { artifact }) };
                }

                case 'builder.artifact_blob': {
                    const blob = await store.getBlob((input as { digest: string }).digest);
                    if (blob === undefined) return { size: 0 };
                    return { content: blob.toString('base64'), size: blob.length };
                }

                default:
                    throw new Error(`builder has no action "${action}"`);
            }
        },
    };
}

/**
 * Whose deploy this is.
 *
 * **The resolved scope wins, and an input that disagrees is refused.** mesh-api puts
 * `ctx.meta.user.tenant_id` on the context from a validated ticket, and its gate is explicit that
 * *"a caller-supplied organization id cannot override it"*. An earlier version of this function read
 * `input.tenantId ?? scope`, which handed that override straight back: an authenticated caller could
 * publish a hostname under someone else's tenant by typing their id, and the CDN would then happily
 * serve it, because B6 checks that a site's tenant matches the *node's* — not that it matches the
 * person who deployed it.
 *
 * So the order is inverted, and a disagreement is an error rather than a silent preference. The
 * input field stays for a cluster-internal caller that has no ticket, which is a deployment's own
 * decision; it is not a way to answer a question the ticket already answered.
 */
function tenantFor(ctx: IServiceContext, requested: string | undefined): string {
    const resolved = (ctx.meta as { user?: { tenant_id?: string } } | undefined)?.user?.tenant_id;

    if (resolved !== undefined) {
        if (requested !== undefined && requested !== resolved) {
            throw new Error(
                `This deploy is scoped to ${resolved}, but the request asked to publish it as ` +
                `${requested}. The scope a ticket resolved to is not something a caller may restate.`,
            );
        }
        return resolved;
    }

    if (requested === undefined) {
        throw new Error(
            'Publishing needs a tenant. The repository cannot name its own owner, so the caller\'s ' +
            'scope must say who this deploy belongs to.',
        );
    }

    return requested;
}

/** Re-exported so a caller can spot a cache hit without importing the builder itself. */
export type { Artifact };
