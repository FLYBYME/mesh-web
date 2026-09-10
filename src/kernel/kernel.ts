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
import { isApplication, isApplicationInstance, isExtension } from '../contribution/contract.js';
import { checkBindings, type PartApi } from '../contribution/api.js';
import type { ProviderToken } from '../contribution/provider.js';
import { createContext, createServices, type BrokerHandle, type KernelServices } from './broker.js';
import { resolveOrder, type Ordered } from './graph.js';
import { kernelLog, reasonOf, type KernelLog } from './logs.js';
import { mergeManifests, type Manifest } from './manifest.js';
import { signal } from '../reactivity/signal.js';
import type { ReadonlySignal, Signal } from '../reactivity/types.js';
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
    internal?: unknown;
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
    #processesSignal: Signal<readonly ProcessEntry[]>;
    #pid = 0;
    #now: () => number;
    /** What the kernel promises to record — see `KERNEL_SOURCE` in logs.ts for the whole list. */
    #log: KernelLog;

    constructor(options: KernelOptions = {}) {
        this.#now = options.now ?? (() => Date.now());
        this.services = options.services ?? createServices();
        this.#processesSignal = signal<readonly ProcessEntry[]>([]);
        this.#log = kernelLog(this.services.logs);
    }

    #syncProcesses(): void {
        this.#processesSignal.set([...this.#processes.values()]);
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

    /**
     * Which contributions turned out to be Applications, in composition order.
     *
     * **Only meaningful after `boot`**, and that is the point: a part is usually exported as a class,
     * so nothing can tell what it is until it has been constructed. Anything asking the question
     * before construction has to guess from the export, and guessing wrong is silent — see
     * `defaultOpen` in `start.ts`, which used to and opened nothing at all.
     */
    get applications(): readonly string[] {
        return [...this.#applications.keys()];
    }

    /**
     * What an Extension provided, by token.
     *
     * The public half of the provider graph. `cx.use` resolves a token for a *contribution*, which is
     * checked against its declared `consumes`; this is for the code that boots the page and has no
     * manifest of its own — chiefly `mountPage`, which needs the page chrome if a site has one and
     * nothing if it does not.
     */
    provided<T>(token: ProviderToken<T>): T | undefined {
        return this.#providers.get(token.id) as T | undefined;
    }

    /** Register a core driver or provider that does not come from an Extension. */
    provide<T>(token: ProviderToken<T>, instance: T): void {
        this.#providers.set(token.id, instance);
    }

    get processes(): readonly ProcessEntry[] {
        return this.#processesSignal();
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

        /**
         * **"Conflicts surfaced here" was not true until this existed.**
         *
         * `mergeManifests` detects two contributions claiming one command id, one key binding, one
         * setting path, one view or one store; it records who claimed each and why the loser lost.
         * Six tests assert that detection works. **Nothing in a running page ever read
         * `manifest.conflicts`**, so the loser was dropped in silence and the author of the part
         * that lost had no way to find out — on a page they may not have composed.
         *
         * A green suite over an inert mechanism is worse than no mechanism, because it looks
         * covered. This is the reader that makes the comment above true, and the audit entry in
         * mesh-serve's `spec/unread.md` closeable.
         *
         * A warning rather than a throw: a collision is one part losing an id, not a broken page,
         * and refusing to boot a site because two of its eight parts both wanted `ctrl+k` would
         * take down a working desktop over a keyboard shortcut. The site owner needs to *know*,
         * which is different from being stopped.
         */
        for (const conflict of this.#manifest.conflicts) {
            // `part` is the claimant that lost — the first claim stands (manifest.ts), so the last
            // name is the part whose declaration was dropped.
            this.#log.warn(conflict.message, {
                part: conflict.claimants.at(-1),
                data: { kind: conflict.kind, key: conflict.key, claimants: conflict.claimants },
            });
        }

        for (const [id, entry] of this.#manifest.commands) {
            this.services.declaredCommands.set(id, entry.by);
        }

        for (const { id, contribution } of loaded) {
            if (isApplication(contribution)) {
                this.#applications.set(id, contribution);
            } else if (!isExtension(contribution)) {
                // Merged, and then run by nothing: a part exported wrongly looked exactly like a
                // part that had nothing to do.
                this.#log.warn(
                    `${id} is neither an Application (no start()) nor an Extension (no activate()), ` +
                    `so nothing will run it. Its declarations were still merged.`,
                    { part: id },
                );
            }
        }

        // Step 6: order Extensions by consumes against provides.
        const extensions = loaded.filter((l) => isExtension(l.contribution));
        let ordered: Ordered;
        try {
            ordered = resolveOrder(
                extensions.map(({ id, contribution }) => ({ id, declarations: contribution })),
            );
        } catch (cause) {
            // Two providers of one token, or a cycle: a boot failure by design (graph.ts). Still
            // thrown — and written down first, so the reason is in the buffer as well as the throw.
            this.#log.error(`boot refused: ${reasonOf(cause)}`);
            throw cause;
        }
        const { order, unresolvable } = ordered;

        // Step 7: activate in that order.
        const byId = new Map(extensions.map((l) => [l.id, l.contribution as ErasedExtension]));

        for (const id of order) {
            const contribution = byId.get(id);
            if (contribution === undefined) continue;

            const why = unresolvable.get(id);
            if (why !== undefined) {
                this.#extensions.set(id, { id, state: 'failed', error: new Error(why) });
                this.#log.error(`${id} was not activated: ${why}`, { part: id });
                continue;
            }

            this.#activate(id, contribution);
        }
    }

    #activate(id: string, contribution: ErasedExtension): void {
        let handle: BrokerHandle | undefined;

        try {
            /**
             * Inside the `try`, which it was not. `createContext` refuses a manifest mistake —
             * `needs('mesh')` with no `api` — by throwing, and outside the `try` that throw left
             * `boot` and took every other part down with it, contradicting the rule in the `catch`
             * below that an Extension failing does not stop the boot.
             */
            handle = createContext(
                // An Extension is a singleton, so the running identity and the declaring identity
                // are the same string. For an Application they are not — see start().
                { id, declaredBy: id },
                contribution.needs ?? [],
                contribution.consumes ?? [],
                (token) => this.#resolve(id, token),
                this.services,
                contribution.api,
            );
            this.#handles.set(id, handle);

            const api = contribution.activate(handle.context);

            if (contribution.provides !== undefined) {
                this.#providers.set(contribution.provides.id, api);
            }
            /**
             * **The kernel used to know one Extension by name here.**
             *
             * It read `contribution.provides.id === AUTH.id` and, on a match, published
             * `api.session` as `services.session` — which meant the kernel imported the auth
             * Extension, and therefore that the framework contained an implementation of one of its
             * own seams. That is the coupling that kept `src/auth/` inside a package whose job is to
             * be the kernel and nothing else.
             *
             * It was also **redundant**, which is the part worth writing down. `credentials.attach`
             * already takes a session signal and sets `services.session` (`broker.ts`), and the auth
             * Extension already calls it — declaring `needs('credentials')` so a site can see which
             * contribution holds the seam. So there were two paths to the same field: one declared,
             * visible in a manifest and refusable; one hard-coded, invisible, and matching on a
             * string id.
             *
             * Deleting the second changes no behaviour and removes the last thing the kernel knew
             * about auth. A part that wants to publish the session declares `needs('credentials')`
             * and attaches, like anything else.
             */

            this.#extensions.set(id, { id, state: 'activated', api });
            this.#log.info(
                contribution.provides === undefined
                    ? `${id} activated`
                    : `${id} activated, providing "${contribution.provides.id}"`,
                { part: id },
            );
        } catch (cause) {
            // Boot continues. A site that cannot function without an Extension says so by declaring
            // it required in the descriptor; the kernel does not guess which ones are essential.
            handle?.dispose();
            this.#handles.delete(id);
            this.#extensions.set(id, {
                id,
                state: 'failed',
                error: cause instanceof Error ? cause : new Error(String(cause)),
            });
            this.#log.error(`${id} failed to activate: ${reasonOf(cause)}`, { part: id });
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
            this.#log.warn(
                `refused to start "${applicationId}": no Application by that id is loaded.`,
                { part: applicationId },
            );
            throw new Error(`Unknown Application "${applicationId}".`);
        }

        const alreadyRunning = this.processes.find(
            (p) => p.applicationId === applicationId && (p.state === 'running' || p.state === 'starting'),
        );
        if (contribution.singleton === true && alreadyRunning !== undefined) {
            const message =
                `Application "${applicationId}" is singleton and is already running as ${alreadyRunning.pid}.`;
            this.#log.warn(`refused to start a second ${applicationId}: ${message}`, { part: applicationId });
            throw new Error(message);
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
        this.#syncProcesses();

        /** How every line about this instance names it: the manifest's id, and the pid. */
        const who = `${applicationId} (${pid})`;

        let handle: BrokerHandle;
        try {
            handle = createContext(
                // Scoped to the instance, so two windows do not share a log source or a namespace —
                // but declaring identity is the Application, because the manifest is the
                // Application's.
                { id: pid, declaredBy: applicationId },
                contribution.needs ?? [],
                contribution.consumes ?? [],
                (token) => this.#resolve(pid, token),
                this.services,
                contribution.api,
            );
        } catch (cause) {
            /**
             * Still thrown — a manifest mistake fails loudly at start, and two tests hold it to
             * that. But **failed first**: the entry used to stay in `starting` forever, so the
             * process table and the panel both described a part that was about to run.
             */
            entry.state = 'failed';
            entry.error = cause instanceof Error ? cause : new Error(String(cause));
            this.#syncProcesses();
            this.#log.error(`${who} was refused its context: ${reasonOf(cause)}`, { part: applicationId });
            throw cause;
        }
        this.#handles.set(pid, handle);

        // Which step failed decides what the line says: a part that threw, or a part the kernel
        // refused for binding something other than what it declared.
        let phase: 'start' | 'bindings' = 'start';

        try {
            const startResult = await contribution.start(handle.context);
            if (isApplicationInstance(startResult)) {
                entry.api = startResult.api;
                entry.internal = startResult.internal;
            } else {
                entry.api = startResult;
                entry.internal = undefined;
            }

            /**
             * **What was declared is what was bound, in both directions.**
             *
             * A manifest is read before anything runs — that is the whole reason `publishes` is
             * declared rather than only returned — so a site, a review, a generated client and a
             * tool caller all learn what a part offers from the declaration. A declaration nothing
             * implements is therefore not an omission, it is an advertisement for something that is
             * not there, and it fails at the first call rather than at load.
             *
             * The reverse is refused for the same reason from the other side: a surface bound but
             * never declared is one nobody can discover, review or grant against.
             *
             * Only when the part declared something. A part with no `publishes` is the ordinary
             * case and is not asked to prove a negative.
             */
            if (contribution.publishes !== undefined) {
                phase = 'bindings';
                checkBindings(
                    contribution.publishes,
                    entry.api as PartApi | undefined,
                    who,
                );
            }

            if (contribution.provides !== undefined && entry.api !== undefined) {
                this.#providers.set(contribution.provides.id, entry.api);
            }

            // A view mounts only after start() resolves, when the process reaches running (roadmap A5.7b).
            // Syncing processes here notifies any reactive shell waiting to mount views for this pid.
            entry.state = 'running';
            this.#syncProcesses();
            this.#log.info(`${applicationId} started as ${pid}`, { part: applicationId });
        } catch (cause) {
            // `failed` is a resting state, not a disappearance. An Application that vanishes on
            // error is one nobody can debug (spec/application.md section 4).
            handle.dispose();
            this.#handles.delete(pid);
            entry.state = 'failed';
            entry.error = cause instanceof Error ? cause : new Error(String(cause));
            this.#syncProcesses();

            const reason = reasonOf(cause);
            if (phase === 'bindings') {
                // `checkBindings` was given `who` as its source, so its message already opens with
                // it. Dropped here so the line does not name the part twice.
                const detail = reason.startsWith(`${who}: `) ? reason.slice(who.length + 2) : reason;
                this.#log.error(`${who} was refused at start: ${detail}`, { part: applicationId });
            } else {
                this.#log.error(`${who} failed to start: ${reason}`, { part: applicationId });
            }
        }

        return pid;
    }

    async stop(pid: string): Promise<void> {
        const entry = this.#processes.get(pid);
        if (entry === undefined) throw new Error(`Unknown process "${pid}".`);
        if (entry.state === 'stopped') return;

        const contribution = this.#applications.get(entry.applicationId);
        entry.state = 'stopping';
        this.#syncProcesses();

        const who = `${entry.applicationId} (${pid})`;

        try {
            await contribution?.stop?.();
        } catch (cause) {
            entry.error = cause instanceof Error ? cause : new Error(String(cause));
            this.#log.warn(
                `${who} threw from stop(): ${reasonOf(cause)}. Its windows and commands are released anyway.`,
                { part: entry.applicationId },
            );
        }

        // Disposed whether or not stop() succeeded. `stop` is for the Application's own concerns;
        // windows, commands and subscriptions are the kernel's.
        this.#handles.get(pid)?.dispose();
        this.#handles.delete(pid);

        if (contribution?.provides !== undefined) {
            this.#providers.delete(contribution.provides.id);
        }

        entry.state = 'stopped';
        this.#syncProcesses();
        this.#log.info(`${who} stopped`, { part: entry.applicationId });
    }

    /** Stop then start. A **new pid**: it is not a resumption and nothing is carried over. */
    async restart(pid: string): Promise<string> {
        const entry = this.#processes.get(pid);
        if (entry === undefined) throw new Error(`Unknown process "${pid}".`);
        await this.stop(pid);
        return this.start(entry.applicationId);
    }
}
