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
import type { ReactiveScope, Signal } from '../reactivity/types.js';
import type { Json } from '../description/types.js';
import type {
    CapabilityMap, CapabilityName, Chrome, ChromeWindow, CommandImpl, Commands, Credentials, Log,
    NotificationHandle, Notifications, State, WindowHandle, Windows,
} from '../contribution/capabilities.js';
import type { ResizeEdge } from '../window/geometry.js';
import type { ErasedContext } from '../contribution/contract.js';
import type { ProviderToken } from '../contribution/provider.js';
import type { AnyApiCall, Api } from '../net/api.js';
import { createClient, fetchTransport, withHeaders, type NetClient } from '../net/client.js';

export interface LogRecord {
    readonly level: 'debug' | 'info' | 'warn' | 'error';
    readonly source: string;
    readonly message: string;
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
    mode(): 'windowed' | 'tiled';
    setMode(mode: 'windowed' | 'tiled'): void;
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
    readonly logs: LogRecord[];
    /** A signal, so a notification host can render them. See NotificationRecord. */
    readonly notifications: Signal<readonly NotificationRecord[]>;
    windows: WindowSink;
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
    netClient: (api: Api<Record<string, AnyApiCall>>, owner: string) => NetClient<unknown>;
    /**
     * The page's one credential seam, and where its API is.
     *
     * Held on the services rather than inside `netClient` so that the auth Extension can write to it
     * *after* clients have already been built — an Application that started before sign-in keeps the
     * client it has, and its next call carries the ticket. A holder that could only be set at
     * construction would need every Application to be restarted by a sign-in.
     */
    readonly credentials: CredentialHolder;
}

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
    let mode: 'windowed' | 'tiled' = 'windowed';

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
     * Where `net` sends requests — roadmap A3.1, spec/hosting.md §5.
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
}

export function createServices(
    windows: WindowSink = recordingWindows(),
    options: ServiceOptions = {},
): KernelServices {
    const credentials: CredentialHolder = {
        origin: options.apiOrigin ?? '',
        owner: undefined,
        headers: undefined,
    };

    return {
        logs: [],
        notifications: signal<readonly NotificationRecord[]>([]),
        windows,
        commands: new Map(),
        declaredCommands: new Map(),
        credentials,
        // Every client is wrapped, always — including the ones built before anything signed in.
        // The lookup is per request, so a ticket that arrives later is on the next call rather than
        // on the next page load, and an Application that never declared `credentials` still sends
        // one without ever having seen it (spec/network.md §4).
        netClient: (api) => createClient(api, {
            transport: withHeaders(
                fetchTransport(credentials.origin),
                () => credentials.headers?.() ?? {},
            ),
        }) as NetClient<unknown>,
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

    const base = {
        id,
        onDispose(fn: () => void): void {
            cleanups.push(fn);
        },
        use(token: ProviderToken<unknown>): unknown {
            if (!consumable.has(token.id)) {
                throw new Error(
                    `${id} used provider "${token.id}" without declaring it in consumes. ` +
                    `The compile error is the first line of defence; this is the second, because a ` +
                    `bundle can be built elsewhere.`,
                );
            }
            return resolve(token);
        },
    };

    // Exactly the declared names, and nothing else. This loop is the whole of "narrowed".
    //
    // A switch rather than `capabilities[name] = build(name)`: TypeScript cannot correlate a union
    // key with its value type through a dynamic index, so the short version needs a cast. This is
    // the ten extra lines that spec/type-safety.md section 1 says to write.
    const capabilities: { -readonly [K in keyof CapabilityMap]?: CapabilityMap[K] } = {};
    let net: NetClient<unknown> | undefined;

    for (const name of declaredNeeds) {
        switch (name) {
            // `net` is not in CapabilityMap: it is typed per contribution by the API declared in
            // the manifest, so it is built here and merged separately (see capabilities.ts).
            case 'net':
                if (declaredApi === undefined) {
                    throw new Error(
                        `${id} declared needs('net') without declaring an api. ` +
                        `A client with no API can call nothing, so this is a manifest mistake ` +
                        `rather than a run-time condition worth tolerating.`,
                    );
                }
                net = services.netClient(declaredApi, id);
                break;
            case 'state':
                capabilities.state = makeState(scope);
                break;
            case 'log':
                capabilities.log = makeLog(id, services);
                break;
            case 'commands':
                capabilities.commands = makeCommands(id, declaredBy, services);
                break;
            case 'notifications':
                capabilities.notifications = makeNotifications(id, services, next);
                break;
            case 'windows':
                capabilities.windows = makeWindows(id, services, next);
                break;
            case 'credentials':
                capabilities.credentials = makeCredentials(id, services);
                break;
            case 'chrome':
                capabilities.chrome = makeChrome(services);
                break;
        }
    }

    const context: ErasedContext = { ...base, ...capabilities, ...(net === undefined ? {} : { net }) };

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
 * `owner` is the running instance (a pid); `declaredBy` is who declared the command in the manifest
 * (an applicationId). They differ for every Application, and comparing the wrong pair means an
 * Application can never implement its own commands.
 *
 * **Open:** with two instances of one Application, the first to start owns the implementation and
 * the second is refused. That is defensible and probably not final — "which instance does the
 * palette's Blog: New Post run" is a real question and nothing has answered it.
 */
function makeCommands(owner: string, declaredBy: string, services: KernelServices): Commands {
    return {
        implement(id: string, run: CommandImpl): void {
            const declarer = services.declaredCommands.get(id);

            if (declarer === undefined) {
                throw new Error(
                    `${owner} implemented command "${id}", which nothing declared. ` +
                    `Commands are declared in the manifest so the palette and the keymap know ` +
                    `about them before the contribution starts.`,
                );
            }
            if (declarer !== declaredBy) {
                throw new Error(
                    `${owner} implemented command "${id}", which was declared by ${declarer}.`,
                );
            }
            if (services.commands.has(id)) {
                throw new Error(`Command "${id}" already has an implementation.`);
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

        focus: (id) => { sink.focus(id); },
        close: (id) => { sink.close(id); },
        move: (id, dx, dy) => { sink.move(id, dx, dy); },
        resize: (id, edge, dx, dy) => { sink.resize(id, edge, dx, dy); },
        setMode: (mode) => { sink.setMode(mode); },
    };
}

/**
 * The credential seam, held by whoever declared it first.
 *
 * `clear()` is scoped to the owner for the same reason `attach` is refused: signing out must not be
 * something another contribution can do to the page's session on the auth Extension's behalf.
 */
function makeCredentials(owner: string, services: KernelServices): Credentials {
    const held = services.credentials;

    return {
        get origin(): string { return held.origin; },

        attach(headers) {
            if (held.owner !== undefined && held.owner !== owner) {
                throw new Error(
                    `${owner} tried to attach credentials, but ${held.owner} already has them. ` +
                    `A page has one session for one API (spec/hosting.md §4), so two contributions ` +
                    `attaching is a site that will send the wrong ticket somewhere.`,
                );
            }
            held.owner = owner;
            held.headers = headers;
        },

        clear() {
            if (held.owner !== owner) return;
            held.headers = undefined;
        },
    };
}
