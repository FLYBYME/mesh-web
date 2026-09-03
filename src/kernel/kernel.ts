/**
 * The kernel.
 *
 * spec/kernel.md. The part that is running before anything is loaded, and that everything else is
 * loaded *by*. It is not extensible — no plugins, no hooks into boot, no way to wrap the capability
 * broker — because it is deliberately the part that is not.
 *
 * What is here is boot steps 3-7 and 10 of spec/kernel.md section 3. Steps 1, 2, 8, 9 and 11 need
 * the deployment descriptor, the registry, auth, view state and the router, none of which exist.
 */

import type { ErasedApplication, ErasedContribution, ErasedExtension, ViewDecl } from '../contribution/contract.js';
import { isApplication, isExtension } from '../contribution/contract.js';
import type { ProviderToken } from '../contribution/provider.js';
import { createContext, createServices, type BrokerHandle, type KernelServices } from './broker.js';
import { resolveOrder } from './graph.js';
import { mergeManifests, type Manifest } from './manifest.js';

export interface Loaded {
    readonly id: string;
    readonly contribution: ErasedContribution;
}

// ---------------------------------------------------------------------------- process table

export type ProcessState = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

/**
 * `pid` is assigned by the kernel and not taken from the bundle, for the same reason a process id
 * is not chosen by the program: identity has to come from the thing that grants it. This is what
 * `defineApp({ id })` got wrong, and why two instances of one Application were impossible.
 */
export interface ProcessEntry {
    readonly pid: string;
    readonly applicationId: string;
    readonly instance: number;
    state: ProcessState;
    readonly startedAt: number;
    error?: Error;
    api?: unknown;
}

export interface ExtensionEntry {
    readonly id: string;
    state: 'activated' | 'failed';
    error?: Error;
    api?: unknown;
}

export interface KernelOptions {
    /** Injected so tests are not at the mercy of the clock. */
    readonly now?: () => number;
    /**
     * Supplied to give the kernel a real window manager. The default records instead of rendering,
     * so a kernel can be booted and exercised with no DOM at all.
     */
    readonly services?: KernelServices;
}

export class Kernel {
    readonly services: KernelServices;

    #manifest: Manifest | undefined;
    #extensions = new Map<string, ExtensionEntry>();
    #processes = new Map<string, ProcessEntry>();
    #providers = new Map<string, unknown>();
    #handles = new Map<string, BrokerHandle>();
    #applications = new Map<string, ErasedApplication>();
    #instanceCounts = new Map<string, number>();
    #pid = 0;
    #now: () => number;

    constructor(options: KernelOptions = {}) {
        this.#now = options.now ?? (() => Date.now());
        this.services = options.services ?? createServices();
    }

    /** A view declaration, by the pid that owns it. What the window sink needs to size a window. */
    viewOf(pid: string, viewId: string): ViewDecl<never, never> | undefined {
        const entry = this.#processes.get(pid);
        if (entry === undefined) return undefined;
        return this.#applications.get(entry.applicationId)?.views?.find((v) => v.id === viewId);
    }

    get manifest(): Manifest {
        if (this.#manifest === undefined) throw new Error('Kernel has not booted.');
        return this.#manifest;
    }

    get extensions(): readonly ExtensionEntry[] {
        return [...this.#extensions.values()];
    }

    get processes(): readonly ProcessEntry[] {
        return [...this.#processes.values()];
    }

    /**
     * Boot steps 3-7: read every manifest, merge it, resolve the provider graph, activate
     * Extensions in dependency order.
     *
     * Applications are constructed and registered but **not started** — starting is step 10 and is
     * `start()` below, because a route or the process manager decides which run.
     */
    boot(loaded: readonly Loaded[]): void {
        // Step 3-4: declarations off the constructed instances, merged, conflicts surfaced here.
        this.#manifest = mergeManifests(
            loaded.map(({ id, contribution }) => ({ id, declarations: contribution })),
        );

        for (const [id, entry] of this.#manifest.commands) {
            this.services.declaredCommands.set(id, entry.by);
        }

        for (const { id, contribution } of loaded) {
            if (isApplication(contribution)) this.#applications.set(id, contribution);
        }

        // Step 6: order Extensions by consumes against provides.
        const extensions = loaded.filter((l) => isExtension(l.contribution));
        const { order, unresolvable } = resolveOrder(
            extensions.map(({ id, contribution }) => ({ id, declarations: contribution })),
        );

        // Step 7: activate in that order.
        const byId = new Map(extensions.map((l) => [l.id, l.contribution as ErasedExtension]));

        for (const id of order) {
            const contribution = byId.get(id);
            if (contribution === undefined) continue;

            const why = unresolvable.get(id);
            if (why !== undefined) {
                this.#extensions.set(id, { id, state: 'failed', error: new Error(why) });
                continue;
            }

            this.#activate(id, contribution);
        }
    }

    #activate(id: string, contribution: ErasedExtension): void {
        const handle = createContext(
            // An Extension is a singleton, so the running identity and the declaring identity are
            // the same string. For an Application they are not — see start().
            { id, declaredBy: id },
            contribution.needs ?? [],
            contribution.consumes ?? [],
            (token) => this.#resolve(id, token),
            this.services,
        );
        this.#handles.set(id, handle);

        try {
            const api = contribution.activate(handle.context);

            if (contribution.provides !== undefined) {
                this.#providers.set(contribution.provides.id, api);
            }

            this.#extensions.set(id, { id, state: 'activated', api });
        } catch (cause) {
            // Boot continues. A site that cannot function without an Extension says so by declaring
            // it required in the descriptor; the kernel does not guess which ones are essential.
            handle.dispose();
            this.#handles.delete(id);
            this.#extensions.set(id, {
                id,
                state: 'failed',
                error: cause instanceof Error ? cause : new Error(String(cause)),
            });
        }
    }

    #resolve(consumerId: string, token: ProviderToken<unknown>): unknown {
        if (!this.#providers.has(token.id)) {
            throw new Error(
                `${consumerId} asked for provider "${token.id}", which is not available. ` +
                `Its Extension may have failed to activate.`,
            );
        }
        return this.#providers.get(token.id);
    }

    // ------------------------------------------------------------------ applications

    /**
     * Start an instance. Boot step 10.
     *
     * Returns the pid, not the API — the caller is the process manager or the router, and neither
     * wants the Application's own interface. Consumers get that through a provider token.
     */
    async start(applicationId: string): Promise<string> {
        const contribution = this.#applications.get(applicationId);
        if (contribution === undefined) {
            throw new Error(`Unknown Application "${applicationId}".`);
        }

        const running = this.processes.filter(
            (p) => p.applicationId === applicationId && (p.state === 'running' || p.state === 'starting'),
        );
        if (contribution.singleton === true && running.length > 0) {
            throw new Error(
                `Application "${applicationId}" is singleton and is already running as ${running[0]!.pid}.`,
            );
        }

        const instance = (this.#instanceCounts.get(applicationId) ?? 0) + 1;
        this.#instanceCounts.set(applicationId, instance);

        const pid = `p${++this.#pid}`;
        const entry: ProcessEntry = {
            pid,
            applicationId,
            instance,
            state: 'starting',
            startedAt: this.#now(),
        };
        this.#processes.set(pid, entry);

        const handle = createContext(
            // Scoped to the instance, so two windows do not share a log source or a namespace —
            // but declaring identity is the Application, because the manifest is the Application's.
            { id: pid, declaredBy: applicationId },
            contribution.needs ?? [],
            contribution.consumes ?? [],
            (token) => this.#resolve(pid, token),
            this.services,
        );
        this.#handles.set(pid, handle);

        try {
            entry.api = await contribution.start(handle.context);

            if (contribution.provides !== undefined) {
                this.#providers.set(contribution.provides.id, entry.api);
            }

            entry.state = 'running';
        } catch (cause) {
            // `failed` is a resting state, not a disappearance. An Application that vanishes on
            // error is one nobody can debug (spec/application.md section 4).
            handle.dispose();
            this.#handles.delete(pid);
            entry.state = 'failed';
            entry.error = cause instanceof Error ? cause : new Error(String(cause));
        }

        return pid;
    }

    async stop(pid: string): Promise<void> {
        const entry = this.#processes.get(pid);
        if (entry === undefined) throw new Error(`Unknown process "${pid}".`);
        if (entry.state === 'stopped') return;

        const contribution = this.#applications.get(entry.applicationId);
        entry.state = 'stopping';

        try {
            await contribution?.stop?.();
        } catch (cause) {
            entry.error = cause instanceof Error ? cause : new Error(String(cause));
        }

        // Disposed whether or not stop() succeeded. `stop` is for the Application's own concerns;
        // windows, commands and subscriptions are the kernel's.
        this.#handles.get(pid)?.dispose();
        this.#handles.delete(pid);

        if (contribution?.provides !== undefined) {
            this.#providers.delete(contribution.provides.id);
        }

        entry.state = 'stopped';
    }

    /** Stop then start. A **new pid**: it is not a resumption and nothing is carried over. */
    async restart(pid: string): Promise<string> {
        const entry = this.#processes.get(pid);
        if (entry === undefined) throw new Error(`Unknown process "${pid}".`);
        await this.stop(pid);
        return this.start(entry.applicationId);
    }
}
