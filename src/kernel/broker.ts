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
import type { ReactiveScope } from '../reactivity/types.js';
import type { Json } from '../description/types.js';
import type {
    CapabilityMap, CapabilityName, CommandImpl, Commands, Log,
    NotificationHandle, Notifications, State, WindowHandle, Windows,
} from '../contribution/capabilities.js';
import type { ErasedContext } from '../contribution/contract.js';
import type { ProviderToken } from '../contribution/provider.js';

export interface LogRecord {
    readonly level: 'debug' | 'info' | 'warn' | 'error';
    readonly source: string;
    readonly message: string;
    readonly data?: unknown;
}

export interface NotificationRecord {
    readonly id: string;
    readonly level: 'info' | 'warn' | 'error';
    readonly source: string;
    message: string;
    dismissed: boolean;
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
}

/**
 * The host services the broker hands out slices of.
 *
 * Everything here is kernel-owned and shared; what a contributor receives is a view onto it that
 * knows who is asking.
 */
export interface KernelServices {
    readonly logs: LogRecord[];
    readonly notifications: NotificationRecord[];
    windows: WindowSink;
    /** Command implementations, by id, with the contributor that supplied each. */
    readonly commands: Map<string, { readonly owner: string; readonly run: CommandImpl }>;
    /** Which command ids each contributor declared. Checked when it tries to implement one. */
    readonly declaredCommands: Map<string, string>;
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
        focus() {},
        ownedBy: (owner) => opened.filter((w) => w.owner === owner && !w.closed).map((w) => w.id),
        closeOwnedBy(owner) {
            for (const w of opened) if (w.owner === owner) w.closed = true;
        },
    };
}

export function createServices(windows: WindowSink = recordingWindows()): KernelServices {
    return {
        logs: [],
        notifications: [],
        windows,
        commands: new Map(),
        declaredCommands: new Map(),
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
    const capabilities: { -readonly [K in CapabilityName]?: CapabilityMap[K] } = {};

    for (const name of declaredNeeds) {
        switch (name) {
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
        }
    }

    const context: ErasedContext = { ...base, ...capabilities };

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
            const record: NotificationRecord = { id: next(), level, source: owner, message, dismissed: false };
            services.notifications.push(record);
            return {
                update: (text) => void (record.message = text),
                dismiss: () => void (record.dismissed = true),
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
