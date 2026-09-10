/**
 * The capability broker.
 *
 * spec/kernel.md section 4, and the reason a kernel exists at all: capability narrowing is worth
 * nothing unless something at run time builds a context with exactly the declared capabilities on
 * it — and only if that something cannot be replaced by the code it is narrowing.
 *
 * Two properties, and both are the point:
 *
 *   Narrowed — an undeclared capability is not on the object, matching the compile error rather
 *   than contradicting it.
 *
 *   Scoped — a capability is bound to the contributor asking for it, which is what makes `log`
 *   already tagged, `storage` already namespaced, and disposal the kernel's job rather than the
 *   contributor's. A contributor is not trusted to clean up after itself, because the case that
 *   matters is the one that crashed.
 */

import { computed, effect, signal } from '../reactivity/index.js';
import { createScope } from '../reactivity/scope.js';
import type { ReactiveScope, ReadonlySignal, Signal } from '../reactivity/types.js';
import type { Session } from '../contribution/session.js';
import type { Json, Node, Reactive } from '../description/types.js';
import type {
    CapabilityMap, CapabilityName, Chrome, ChromeWindow, CommandImpl, Commands, Confirmation,
    ConfirmOptions, Credentials, Dom, Http, HttpRequest, HttpResponse, Log, NotificationHandle,
    Notifications, State, Storage, SurfaceOptions, WindowHandle, Windows,
} from '../contribution/capabilities.js';
import type { ResizeEdge } from '../window/geometry.js';
import { windowHost } from '../window/page.js';
import type { WindowMode } from '../window/manager.js';
import type { ErasedContext } from '../contribution/contract.js';
import type { ProviderToken } from '../contribution/provider.js';
import type { AnyApiCall, Api } from '../net/api.js';
import { createClient, fetchTransport, withHeaders, type MeshClient } from '../net/client.js';
import type { HiveBindings } from '../registry/hives.js';
import { localProvider, memoryProvider } from '../registry/providers.js';
import { createStorage } from '../storage/index.js';
import { createModels, type EventSourceLike, type Models } from '../models/index.js';
import type { CallError, Result } from '../net/result.js';
import { createLogBuffer, createRepeatFilter, kernelLog, reasonOf, type LogBuffer } from './logs.js';

export interface LogRecord {
    readonly level: 'debug' | 'info' | 'warn' | 'error';
    readonly source: string;
    readonly message: string;
    /**
     * Which part a **kernel** line is about (roadmap A8.17). Set only by the kernel's own writer
     * (`kernelLog`); a contribution's `log` capability has no way to supply it.
     */
    readonly part?: string;
    readonly data?: unknown;
}

/**
 * One notification, currently on screen.
 *
 * Immutable, and the list is a signal, because a notification nobody can render is not a
 * notification. That was true here until 2026-09-04: the Application called
 * `cx.notifications.warn(...)` correctly, the kernel recorded it in a plain array, and **nothing
 * displayed it** — so a failed API call looked exactly like nothing happening, and was only found
 * because someone had devtools open.
 *
 * There is no `dismissed` flag. Dismissing removes it: a dismissed notification that stays in the
 * list is a state with no reader, and the history belongs in the log.
 */
export interface NotificationRecord {
    readonly id: string;
    readonly level: 'info' | 'warn' | 'error';
    readonly source: string;
    readonly message: string;
}

/**
 * What `windows.open` does, without the broker knowing what a window is.
 *
 * The kernel supplies this, backed by the real WindowManager. Keeping the broker ignorant of
 * geometry is what lets a headless test run an Application that opens windows.
 */
export interface WindowSink {
    open(owner: string, view: string, params: Readonly<Record<string, Json>>): string;
    close(id: string): void;
    focus(id: string): void;
    ownedBy(owner: string): readonly string[];
    closeOwnedBy(owner: string): void;

    /**
     * The chrome half — everything below is reachable only through `needs('chrome')`.
     *
     * On the sink rather than in a second interface because there is one window manager and this is
     * its whole surface; what narrows access is the *capability*, which is where narrowing belongs.
     * An Application declaring `windows` cannot reach any of these, and the switch in
     * `createContext` is the only place that decides so.
     */
    all(): readonly ChromeWindow[];
    focused(): string | undefined;
    mode(): WindowMode;
    setMode(mode: WindowMode): void;
    move(id: string, dx: number, dy: number): void;
    resize(id: string, edge: ResizeEdge, dx: number, dy: number): void;
}

/**
 * The host services the broker hands out slices of.
 *
 * Everything here is kernel-owned and shared; what a contributor receives is a view onto it that
 * knows who is asking.
 */
export interface KernelServices {
    readonly logs: LogBuffer;
    /** A signal, so a notification host can render them. See NotificationRecord. */
    readonly notifications: Signal<readonly NotificationRecord[]>;
    windows: WindowSink;

    /**
     * How much room there is to draw in, as a signal.
     *
     * A `Signal` rather than a `ReadonlySignal` because `start()` writes it — it owns the
     * measurement, the `resize` listener and the `ResizeObserver` — while every consumer receives
     * the read-only view through `cx.display`. The same split as `notifications` above.
     *
     * Defaulted rather than optional, so a kernel booted with no DOM (most of this repository's
     * tests) still answers a size instead of forcing every reader to handle `undefined`. Zero is
     * honest there: there genuinely is no room, and a chrome that renders nothing at 0×0 is
     * behaving correctly.
     */
    readonly displaySize: Signal<{ readonly width: number; readonly height: number }>;
    /** Command implementations, by id, with the contributor that supplied each. */
    readonly commands: Map<string, { readonly owner: string; readonly run: CommandImpl }>;
    /** Which command ids each contributor declared. Checked when it tries to implement one. */
    readonly declaredCommands: Map<string, string>;
    /**
     * How a declared API becomes a client.
     *
     * The kernel owns this rather than each Application constructing its own, which is what lets a
     * site attach a ticket once — the auth Extension wraps the transport, and no Application ever
     * handles a credential (spec/network.md section 4). A test replaces it with a fake and needs no
     * server.
     */
    meshClient: (api: Api<Record<string, AnyApiCall>>, owner: string) => MeshClient<unknown>;
    /**
     * The page's one credential seam, and where its API is.
     *
     * Held on the services rather than inside `meshClient` so that the auth Extension can write to it
     * *after* clients have already been built — an Application that started before sign-in keeps the
     * client it has, and its next call carries the ticket. A holder that could only be set at
     * construction would need every Application to be restarted by a sign-in.
     */
    readonly credentials: CredentialHolder;
    readonly hives: HiveBindings;
    session?: ReadonlySignal<Session | null>;
    eventSource?: (url: string) => EventSourceLike;
    /**
     * How the kernel prompts the user for a decision when `cx.confirmation.ask(...)` is called.
     *
     * In the browser this mounts a modal `<dialog>`; in tests it defaults to resolving false or
     * using the prompter supplied in options.
     */
    confirm: ConfirmPrompter;
}

export interface ConfirmRequest extends ConfirmOptions {
    readonly requester: string;
}

export type ConfirmPrompter = (request: ConfirmRequest) => Promise<boolean>;

/**
 * Who is attaching what, and where requests go.
 *
 * One per kernel. `owner` is kept so the refusal can name the contribution that got there first,
 * which is the difference between a boot failure someone can fix and one they can only bisect.
 */
export interface CredentialHolder {
    readonly origin: string;
    owner: string | undefined;
    headers: (() => Readonly<Record<string, string>>) | undefined;
    session?: ReadonlySignal<Session | null>;
}

/**
 * A sink that records instead of rendering.
 *
 * The default, so a kernel can be booted and exercised with no window manager and no DOM at all —
 * which most of the kernel's own tests want.
 */
export function recordingWindows(): WindowSink & { readonly opened: { id: string; owner: string; view: string; params: Readonly<Record<string, Json>>; closed: boolean }[] } {
    const opened: { id: string; owner: string; view: string; params: Readonly<Record<string, Json>>; closed: boolean }[] = [];
    let next = 0;
    let focused: string | undefined;
    let mode: WindowMode = 'windowed';

    return {
        opened,
        open(owner, view, params) {
            const id = `rec${++next}`;
            opened.push({ id, owner, view, params, closed: false });
            return id;
        },
        close(id) {
            const entry = opened.find((w) => w.id === id);
            if (entry !== undefined) entry.closed = true;
        },
        focus(id) { focused = id; },
        ownedBy: (owner) => opened.filter((w) => w.owner === owner && !w.closed).map((w) => w.id),
        closeOwnedBy(owner) {
            for (const w of opened) if (w.owner === owner) w.closed = true;
        },

        // Enough for chrome to be exercised with no DOM and no geometry: it can list, focus and
        // switch mode. Everything positional answers zero, because a sink that records has no
        // viewport to position anything in — a test that cares about geometry wants the real
        // manager, and one that cares about what chrome *asked for* does not.
        all: () => opened.filter((w) => !w.closed).map((w) => ({
            id: w.id,
            owner: w.owner,
            view: w.view,
            title: w.view,
            tile: undefined,
            x: 0, y: 0, width: 0, height: 0,
            closable: true,
        })),
        focused: () => focused,
        mode: () => mode,
        setMode(next) { mode = next; },
        move() {},
        resize() {},
    };
}

export interface ServiceOptions {
    /**
     * Where `mesh` sends requests — roadmap A3.1, spec/hosting.md §5.
     *
     * **From the deployment descriptor**, by way of the build: the builder puts the environment's
     * `api` in `MESH_API`, the site's bundle bakes it in, and the site's entry code passes it here.
     * That is why it is a value the site supplies rather than something the framework discovers —
     * which API a site talks to is a deployment fact, and a page that guessed it would be guessing
     * about the only security boundary in the system.
     *
     * Empty is same-origin and is the common case: the page was served by the CDN and the API is
     * behind the same proxy (spec/hosting.md §1).
     */
    readonly apiOrigin?: string;
    readonly hives?: HiveBindings;
    readonly session?: ReadonlySignal<Session | null>;
    readonly logCapacity?: number;
    /**
     * How the page asks the person a yes-or-no question.
     *
     * Supplied by whoever builds the page, not by the contribution that asks — that separation is
     * the whole property `Confirmation` claims. A test can pass one that answers without a DOM.
     */
    readonly confirm?: ConfirmPrompter;
    readonly eventSource?: (url: string) => EventSourceLike;
}

export function defaultHives(): HiveBindings {
    return {
        system: { provider: memoryProvider('system'), writable: false },
        user: { provider: memoryProvider('user'), writable: true },
        device: { provider: localProvider(), writable: true },
        session: { provider: memoryProvider('session'), writable: true },
    };
}

export function createServices(
    windows: WindowSink = recordingWindows(),
    options: ServiceOptions = {},
): KernelServices {
    const sessionHolder = signal<ReadonlySignal<Session | null> | undefined>(options.session);
    const kernelSession = computed<Session | null>(() => {
        const s = sessionHolder();
        return s ? s() : null;
    });

    const credentials: CredentialHolder = {
        origin: options.apiOrigin ?? '',
        owner: undefined,
        headers: undefined,
        get session(): ReadonlySignal<Session | null> | undefined {
            return sessionHolder();
        },
        set session(next: ReadonlySignal<Session | null> | undefined) {
            sessionHolder.set(next);
        },
    };

    return {
        logs: createLogBuffer(options.logCapacity),
        notifications: signal<readonly NotificationRecord[]>([]),
        // 0×0 until something measures. See `KernelServices.displaySize`.
        displaySize: signal<{ readonly width: number; readonly height: number }>({ width: 0, height: 0 }),
        /**
         * **Refusing is the safe default, and it is deliberately not "yes".**
         *
         * A kernel booted with no DOM — which is most of this repository's own tests — cannot ask
         * anybody anything. Answering `true` there would make every unattended run behave as though
         * a person had agreed to whatever was asked, and the first time that mattered it would be a
         * destructive call in a test harness.
         *
         * `start()` replaces this with a real prompter when there is a page to draw on.
         */
        confirm: options.confirm ?? (async () => false),
        eventSource: options.eventSource,
        windows,
        commands: new Map(),
        declaredCommands: new Map(),
        credentials,
        // Every client is wrapped, always — including the ones built before anything signed in.
        // The lookup is per request, so a ticket that arrives later is on the next call rather than
        // on the next page load, and an Application that never declared `credentials` still sends
        // one without ever having seen it (spec/network.md §4).
        meshClient: (api) => createClient(api, {
            transport: withHeaders(
                fetchTransport(credentials.origin),
                () => credentials.headers?.() ?? {},
            ),
        }) as MeshClient<unknown>,
        hives: options.hives ?? defaultHives(),
        get session(): ReadonlySignal<Session | null> {
            return kernelSession;
        },
        set session(next: ReadonlySignal<Session | null> | undefined) {
            sessionHolder.set(next);
        },
    };
}

export interface BrokerHandle {
    readonly context: ErasedContext;
    /** Stops every effect, disposes every window and command this contributor took. */
    dispose(): void;
}

/**
 * Build one contributor's context.
 *
 * `resolve` is supplied by the provider graph — the broker does not know how a token becomes an
 * implementation, only that it must refuse one that was not declared.
 */
export interface ContextIdentity {
    /**
     * Who is running. For an Extension its id; for an Application **its pid**, because capabilities
     * are scoped per instance — two blog windows must not share a storage namespace or a log source.
     */
    readonly id: string;
    /**
     * Who declared. For an Application this is the applicationId, not the pid, because the manifest
     * belongs to the Application and every instance shares it.
     *
     * These are the same string for an Extension and different for an Application, and conflating
     * them is a real bug: a command declared by `blog` is implemented by instance `p1`.
     */
    readonly declaredBy: string;
}

export function createContext(
    identity: ContextIdentity,
    declaredNeeds: readonly CapabilityName[],
    declaredConsumes: readonly ProviderToken<unknown>[],
    resolve: (token: ProviderToken<unknown>) => unknown,
    services: KernelServices,
    declaredApi?: Api<Record<string, AnyApiCall>>,
): BrokerHandle {
    const { id, declaredBy } = identity;
    const scope: ReactiveScope = createScope();
    const cleanups: (() => void)[] = [];
    let counter = 0;
    const next = (): string => `${id}:${counter++}`;

    const consumable = new Set(declaredConsumes.map((t) => t.id));

    /**
     * The kernel's own lines about this contribution (roadmap A8.17).
     *
     * `who` is what a person reading the panel needs: the manifest's name, and the pid beside it
     * when they differ — "p3 failed" names nothing anyone composed. `part` is always the declaring
     * name, so every line about one part can be found together.
     *
     * Refusals and failed calls go through one bounded repeat filter, because both can be reached
     * from a render or a refetch loop, and the promise is one line per refusal rather than one per
     * attempt.
     */
    const log = kernelLog(services.logs);
    const who = id === declaredBy ? id : `${declaredBy} (${id})`;
    const repeats = createRepeatFilter();
    const refused = (key: string, message: string): void => {
        if (repeats.changed(`refused:${key}`, message)) log.warn(message, { part: declaredBy });
    };

    const reportCall = (api: string, action: string, result: Result<unknown, CallError<string>>): void => {
        const key = `call:${action}`;
        if (result.ok) {
            repeats.forget(key);
            return;
        }

        const failure = describeCallFailure(result.error);
        if (!repeats.changed(key, failure.text)) return;

        const message = `${who}: ${action} failed — ${failure.text}`;
        const about = {
            part: declaredBy,
            data: {
                api,
                contract: action,
                kind: result.error.kind,
                ...(failure.status === undefined ? {} : { status: failure.status }),
            },
        };
        if (failure.severe) log.error(message, about); else log.warn(message, about);
    };

    const base = {
        id,
        onDispose(fn: () => void): void {
            cleanups.push(fn);
        },
        use(token: ProviderToken<unknown>): unknown {
            if (!consumable.has(token.id)) {
                refused(`use:${token.id}`, `${who} used provider "${token.id}" without declaring it in consumes, and was refused.`);
                throw new Error(
                    `${id} used provider "${token.id}" without declaring it in consumes. ` +
                    `The compile error is the first line of defence; this is the second, because a ` +
                    `bundle can be built elsewhere.`,
                );
            }
            try {
                return resolve(token);
            } catch (cause) {
                refused(`resolve:${token.id}`, `${who} was refused provider "${token.id}": ${reasonOf(cause)}`);
                throw cause;
            }
        },
    };

    // Exactly the declared names, and nothing else. This loop is the whole of "narrowed".
    //
    // A switch rather than `capabilities[name] = build(name)`: TypeScript cannot correlate a union
    // key with its value type through a dynamic index, so the short version needs a cast. This is
    // the ten extra lines that spec/type-safety.md section 1 says to write.
    const capabilities: { -readonly [K in keyof CapabilityMap]?: CapabilityMap[K] } = {};
    let mesh: MeshClient<unknown> | undefined;
    let models: Models<unknown> | undefined;

    for (const name of declaredNeeds) {
        switch (name) {
            // `mesh` and `models` are not in CapabilityMap: they are typed per contribution by the
            // API declared in the manifest, so they are built here and merged separately (see capabilities.ts).
            case 'mesh':
                if (declaredApi === undefined) {
                    throw new Error(
                        `${id} declared needs('mesh') without declaring an api. ` +
                        `A client with no API can call nothing, so this is a manifest mistake ` +
                        `rather than a run-time condition worth tolerating.`,
                    );
                }
                // Observed here rather than inside `services.meshClient`, which a site or a test
                // replaces: what the kernel records must not depend on who built the client.
                mesh = observeCalls(services.meshClient(declaredApi, id), reportCall);
                break;
            case 'models':
                if (declaredApi === undefined) {
                    throw new Error(
                        `${id} declared needs('models') without declaring an api. ` +
                        `Models without an API can query nothing, so this is a manifest mistake ` +
                        `rather than a run-time condition worth tolerating.`,
                    );
                }
                models = createModels(
                    // Every collection fetch and mutation is a `call` on this client, so a failed
                    // `models` fetch is recorded by the same observer as a failed `mesh` call.
                    observeCalls(services.meshClient(declaredApi, id), reportCall),
                    (fn) => cleanups.push(fn),
                    () => services.session,
                    declaredApi,
                    {
                        eventSource: services.eventSource,
                        origin: services.credentials.origin,
                    },
                );
                break;
            case 'state':
                capabilities.state = makeState(scope);
                break;
            case 'log':
                capabilities.log = makeLog(id, services);
                break;
            case 'commands':
                capabilities.commands = makeCommands(id, declaredBy, services, refused);
                break;
            case 'notifications':
                capabilities.notifications = makeNotifications(id, services, next);
                break;
            case 'windows':
                capabilities.windows = makeWindows(id, services, next);
                break;
            case 'display':
                /**
                 * Read-only, and shared rather than made per contribution.
                 *
                 * There is one display, everybody sees the same number, and there is nothing to
                 * narrow per caller — unlike `windows`, where `own()` has to mean *this
                 * contribution's* windows. Handing out the signal directly is the whole capability.
                 */
                capabilities.display = { size: services.displaySize };
                break;
            case 'credentials':
                capabilities.credentials = makeCredentials(id, services, refused);
                break;
            case 'chrome':
                capabilities.chrome = makeChrome(services);
                break;
            case 'confirmation':
                // `declaredBy`, not `id`. `id` is the running instance — a pid like `p1` — and
                // "asked by p1" tells the person nothing at the moment they most need to know what
                // is asking. `declaredBy` is the name in the manifest: `catalog`, `releases`.
                capabilities.confirmation = makeConfirmation(declaredBy, services);
                break;
            case 'http':
                capabilities.http = makeHttp(id, services);
                break;
            case 'storage':
                capabilities.storage = makeStorage(declaredBy, id, services, (fn) => cleanups.push(fn));
                break;
            case 'dom':
                capabilities.dom = makeDom(id, cleanups);
                break;
            default: {
                /**
                 * **Declared and not granted.** Unreachable through the types — `name` is `never`
                 * here — and reachable from a bundle built against a different kernel, which asks
                 * for a capability this one does not have. It used to get nothing, silently, and fail
                 * later at the first use of a property that was never on its context.
                 */
                const unknown: string = name;
                refused(`need:${unknown}`, `${who} declared needs('${unknown}'), which this kernel does not have, so it was not granted.`);
            }
        }
    }

    const context: ErasedContext = {
        ...base,
        ...capabilities,
        ...(mesh === undefined ? {} : { mesh }),
        ...(models === undefined ? {} : { models }),
    };

    return {
        context,
        dispose(): void {
            for (const fn of cleanups.splice(0)) {
                try {
                    fn();
                } catch {
                    // A contributor's own cleanup throwing must not stop the kernel's.
                }
            }

            scope.dispose();

            for (const [commandId, entry] of [...services.commands]) {
                if (entry.owner === id) services.commands.delete(commandId);
            }
            services.windows.closeOwnedBy(id);
        },
    };
}

/** Signals and effects created here belong to the contributor's scope, so disposal is structural. */
function makeState(scope: ReactiveScope): State {
    return {
        signal: (initial) => scope.run(() => signal(initial)),
        computed: (fn) => scope.run(() => computed(fn)),
        effect: (fn) => void scope.run(() => effect(fn)),
    };
}

/** Already tagged with who logged — the caller does not pass a source and cannot forge one. */
function makeLog(owner: string, services: KernelServices): Log {
    const write = (level: LogRecord['level']) => (message: string, data?: unknown): void => {
        services.logs.push(data === undefined
            ? { level, source: owner, message }
            : { level, source: owner, message, data });
    };

    return {
        debug: write('debug'),
        info: write('info'),
        warn: write('warn'),
        error: (message, error) => write('error')(message, error),
    };
}

/**
 * A client whose every call the kernel sees the outcome of — and only the outcome.
 *
 * Wraps `call` and nothing else. The input is passed straight through and never looked at; the
 * result is handed to `report`, which reads the failure's *kind* and never its `detail` — a
 * `detail` can be the response body verbatim (`client.ts` `interpret`), and a body is payload.
 */
function observeCalls(
    client: MeshClient<unknown>,
    report: (api: string, action: string, result: Result<unknown, CallError<string>>) => void,
): MeshClient<unknown> {
    return {
        api: client.api,
        ...(client.descriptor === undefined ? {} : { descriptor: client.descriptor }),
        call: async (action, ...input) => {
            const result = await client.call(action, ...input);
            report(client.api, action, result);
            return result;
        },
    };
}

interface CallFailure {
    /** What the line says. Also the repeat key, so a changed failure is news and a repeat is not. */
    readonly text: string;
    /** Only where the kind pins exactly one status — `client.ts` `interpret` is the inverse. */
    readonly status?: number;
    /** An outage rather than an answer: the server broke, the API is unreachable, or the client is stale. */
    readonly severe: boolean;
}

/**
 * A failure, as a line — built from the kind and never from `detail`.
 *
 * `invalid` claims no status: it is a 400 over the wire *and* the client's own refusal of an action
 * its API does not expose, and a line that said "400" for the second would be inventing a response.
 * `offline` does carry its detail, because there it is the transport's exception message (`Failed
 * to fetch`) and never a body.
 *
 * `switch` with no default, so a new failure kind is a compile error here rather than a blank line.
 */
function describeCallFailure(error: CallError<string>): CallFailure {
    switch (error.kind) {
        case 'unauthorized': return { text: '401 unauthorized', status: 401, severe: false };
        case 'forbidden': return { text: '403 forbidden', status: 403, severe: false };
        case 'not_found': return { text: '404 not found', status: 404, severe: false };
        case 'conflict': return { text: '409 conflict', status: 409, severe: false };
        case 'rate_limited': return { text: '429 rate limited', status: 429, severe: false };
        case 'server': return { text: `${String(error.status)} server error`, status: error.status, severe: true };
        case 'invalid': return { text: 'invalid request', severe: false };
        case 'declared': return { text: `declared failure "${error.name.slice(0, 100)}"`, severe: false };
        case 'offline': return { text: `could not reach the API (${error.detail.slice(0, 200)})`, severe: true };
        case 'stale': {
            // Contract keys and what moved about each — the question a stale line has to answer.
            // Gate differences never fail a call (client.ts), so they are not the reason for this one.
            const moved = (error.differences ?? [])
                .filter((d) => d.kind !== 'gate')
                .slice(0, 5)
                .map((d) => `${d.contract} (${d.kind})`);
            return {
                text: moved.length === 0
                    ? 'stale: the API exposure moved'
                    : `stale: ${moved.join(', ')} changed`,
                severe: true,
            };
        }
    }
}

/**
 * `owner` is the running instance (a pid); `declaredBy` is who declared the command in the manifest
 * (an applicationId). They differ for every Application, and comparing the wrong pair means an
 * Application can never implement its own commands.
 *
 * **Open:** with two instances of one Application, the first to start owns the implementation and
 * the second is refused. That is defensible and probably not final — "which instance does the
 * palette's Blog: New Post run" is a real question and nothing has answered it.
 */
function makeCommands(
    owner: string,
    declaredBy: string,
    services: KernelServices,
    refused: (key: string, message: string) => void,
): Commands {
    /** Recorded before it is thrown: a part that catches its own refusal still leaves a line. */
    const refuse = (id: string, message: string): Error => {
        refused(`implement:${id}`, message);
        return new Error(message);
    };

    return {
        implement(id: string, run: CommandImpl): void {
            const declarer = services.declaredCommands.get(id);

            if (declarer === undefined) {
                throw refuse(id,
                    `${owner} implemented command "${id}", which nothing declared. ` +
                    `Commands are declared in the manifest so the palette and the keymap know ` +
                    `about them before the contribution starts.`,
                );
            }
            if (declarer !== declaredBy) {
                throw refuse(id,
                    `${owner} implemented command "${id}", which was declared by ${declarer}.`,
                );
            }
            if (services.commands.has(id)) {
                throw refuse(id, `Command "${id}" already has an implementation.`);
            }

            services.commands.set(id, { owner, run });
        },

        async run(id: string, ...args: readonly Json[]): Promise<void> {
            const entry = services.commands.get(id);
            if (entry === undefined) {
                const declared = services.declaredCommands.has(id);
                throw new Error(
                    declared
                        ? `Command "${id}" is declared but has no implementation. ` +
                          `Its contribution may not have started.`
                        : `Unknown command "${id}".`,
                );
            }
            await entry.run(...args);
        },
    };
}

/**
 * The confirmation capability, narrowed to the contribution asking.
 *
 * `requester` is stamped by the kernel from the contribution's own id and is **not** a field the
 * caller supplies. A prompter can therefore say *who* is asking, and a part cannot claim to be
 * another part — the same rule `notifications` and `commands` follow, and for the same reason.
 *
 * The answer comes back from `services.confirm`, which is installed by whoever built the page. The
 * asker never holds the resolver, so it cannot resolve its own question.
 */
function makeConfirmation(owner: string, services: KernelServices): Confirmation {
    return {
        ask: async (options) => {
            const request: ConfirmRequest = typeof options === 'string'
                ? { message: options, requester: owner }
                : { ...options, requester: owner };

            // A prompter that throws must not read as agreement. Anything other than an explicit
            // `true` is a refusal, including a page that has torn its dialog down mid-question.
            try {
                return await services.confirm(request) === true;
            } catch {
                return false;
            }
        },
    };
}

function makeNotifications(owner: string, services: KernelServices, next: () => string): Notifications {
    const raise = (level: NotificationRecord['level']) =>
        (message: string): NotificationHandle => {
            const id = next();
            const list = services.notifications;
            list.set([...list(), { id, level, source: owner, message }]);

            return {
                update: (text) => list.set(list().map((n) => (n.id === id ? { ...n, message: text } : n))),
                dismiss: () => list.set(list().filter((n) => n.id !== id)),
            };
        };

    return {
        info: raise('info'),
        warn: raise('warn'),
        error: (message, error) => {
            const handle = raise('error')(message);
            if (error !== undefined) {
                services.logs.push({ level: 'error', source: owner, message, data: error });
            }
            return handle;
        },
    };
}

/**
 * Knows who opened a window, so ownership and cleanup need no bookkeeping from the caller.
 *
 * Note what is absent: no `move`, no `resize`, no `raise`. An Application never moves or resizes its
 * own window (spec/input.md section 6) — those are kernel mechanics, and the reason is concrete
 * rather than tidy: resizing under a d-pad needs a window-management mode driven by the kernel's own
 * focus and input system.
 */
function makeWindows(owner: string, services: KernelServices, _next: () => string): Windows {
    const handle = (id: string): WindowHandle => ({
        id,
        focus: () => services.windows.focus(id),
        close: () => services.windows.close(id),
    });

    return {
        open: (options) => handle(services.windows.open(owner, options.view, options.params ?? {})),
        own: () => services.windows.ownedBy(owner).map(handle),
    };
}

/**
 * Chrome: the whole window list, and the mechanics the kernel owns.
 *
 * No `owner` parameter, and that is the difference from every other capability here. `windows`,
 * `commands` and `notifications` all narrow to the contribution asking; chrome's entire job is the
 * windows that are *not* its own, so narrowing by owner would leave it with nothing to draw. What
 * takes the place of that narrowing is `needs('chrome')` being written down.
 */
function makeChrome(services: KernelServices): Chrome {
    const sink = services.windows;

    return {
        windows: () => sink.all(),
        focused: () => sink.focused(),
        mode: () => sink.mode(),
        host: () => windowHost(),

        focus: (id) => { sink.focus(id); },
        close: (id) => { sink.close(id); },
        move: (id, dx, dy) => { sink.move(id, dx, dy); },
        resize: (id, edge, dx, dy) => { sink.resize(id, edge, dx, dy); },
        setMode: (mode) => { sink.setMode(mode); },
    };
}

/**
 * Requests to somewhere that is not the site's API.
 *
 * Three decisions are baked in here rather than left to each caller, because each of them is one a
 * part would get wrong in the same way:
 *
 * **The page's credentials are never attached.** `mesh` goes through the credential seam because it
 * goes to the site's own API; this goes wherever it is told, so attaching the ticket would let any
 * part holding `needs('http')` post the page's session to an origin of its choosing. The ticket is
 * the auth Extension's to send explicitly, per request.
 *
 * **`credentials: 'omit'`**, so no cookie rides along either. This page authenticates with a bearer
 * ticket, and an ambient cookie on an outbound request is a CSRF surface nobody asked for.
 *
 * **A status is not an exception.** `401` is an answer and `500` is a failure, and a caller that
 * cannot tell them apart reads an outage as a sign-out. Only a transport failure throws.
 */
function makeHttp(owner: string, services: KernelServices): Http {
    const send = async <T,>(url: string, init: HttpRequest = {}): Promise<HttpResponse<T>> => {
        const method = init.method ?? 'GET';
        const hasBody = init.body !== undefined;

        const response = await fetch(url, {
            method,
            headers: {
                ...(hasBody ? { 'content-type': 'application/json' } : {}),
                ...init.headers,
            },
            ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
            ...(init.signal === undefined ? {} : { signal: init.signal }),
            credentials: 'omit',
        });

        // A 204, an empty body, or a non-JSON error page. None of them is a reason to throw: the
        // status is the answer, and `body` being absent says the rest.
        let body: T | undefined;
        try {
            body = await response.json() as T;
        } catch {
            body = undefined;
        }

        // Logged against the contribution that made the call, so *which part is talking to what* is
        // answerable from the page rather than only from a network tab.
        //
        // **Without the query string or fragment** (A8.17). A URL is where a careless caller puts a
        // token — `?access_token=` is a real convention — and the buffer is readable by anyone who
        // presses ctrl+alt+q. Where the request went is the origin and path; the rest is payload.
        services.logs.push({
            level: 'debug',
            source: owner,
            message: `${method} ${url.split(/[?#]/, 1)[0] ?? ''} → ${String(response.status)}`,
        });

        return { ok: response.ok, status: response.status, body };
    };

    return {
        request: send,
        get: (url, init) => send(url, { ...init, method: 'GET' }),
        post: (url, body, init) => send(url, { ...init, method: 'POST', body }),
    };
}

/**
 * The credential seam, held by whoever declared it first.
 *
 * `clear()` is scoped to the owner for the same reason `attach` is refused: signing out must not be
 * something another contribution can do to the page's session on the auth Extension's behalf.
 */
function makeCredentials(
    owner: string,
    services: KernelServices,
    refused: (key: string, message: string) => void,
): Credentials {
    const held = services.credentials;

    return {
        get origin(): string { return held.origin; },

        attach(headers, sessionSignal) {
            if (held.owner !== undefined && held.owner !== owner) {
                // Names who holds the seam. Never what is in it: `headers` is not called here.
                const message =
                    `${owner} tried to attach credentials, but ${held.owner} already has them. ` +
                    `A page has one session for one API (spec/hosting.md §4), so two contributions ` +
                    `attaching is a site that will send the wrong ticket somewhere.`;
                refused('credentials', message);
                throw new Error(message);
            }
            held.owner = owner;
            held.headers = headers;
            if (sessionSignal !== undefined) {
                held.session = sessionSignal;
                services.session = sessionSignal;
            }
        },

        clear() {
            if (held.owner !== owner) return;
            held.headers = undefined;
            held.session = undefined;
            services.session = undefined;
        },
    };
}

/**
 * Scoped to the contributor (declaredBy) so data survives reloads, with logs attributed to the
 * running instance (id), and disposal managed by the kernel.
 */
function makeStorage(
    namespace: string,
    source: string,
    services: KernelServices,
    onDispose: (cleanup: () => void) => void,
): Storage {
    return createStorage({
        namespace,
        hives: services.hives,
        onLogWarn: (message, data) => {
            services.logs.push(data === undefined
                ? { level: 'warn', source, message }
                : { level: 'warn', source, message, data });
        },
        onDispose,
    });
}

/**
 * The escape hatch from isolation — roadmap A7.5, spec/view-layer.md §8.
 *
 * Available only when a contribution explicitly declared `needs('dom')`. The teardown
 * returned from `setup` is tracked by the kernel cleanups array and also by the renderer's
 * reactive scope, ensuring resources are torn down either when the surface unmounts or
 * when the contributor context itself is disposed.
 */
function makeDom(owner: string, cleanups: (() => void)[]): Dom {
    const make = (options: SurfaceOptions): Node => {
        const props: Record<string, Reactive<Json> | undefined> = {};
        if (options.props !== undefined) {
            Object.assign(props, options.props);
        }
        if (options.style !== undefined) {
            props.style = options.style;
        }
        if (options.class !== undefined) {
            props.class = options.class;
        }
        return {
            kind: 'surface',
            setup(host: unknown): (() => void) | void {
                const teardown = options.setup(host as HTMLElement);
                if (typeof teardown === 'function') {
                    let called = false;
                    const safeTeardown = () => {
                        if (!called) {
                            called = true;
                            teardown();
                        }
                    };
                    cleanups.push(safeTeardown);
                    return safeTeardown;
                }
            },
            ...(options.key !== undefined ? { key: options.key } : {}),
            props,
        };
    };

    return {
        Surface: make,
        surface: make,
    };
}
