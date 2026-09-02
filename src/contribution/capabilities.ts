import type { ReadonlySignal, DisposeFn } from '../reactivity/types.js';
import type { AppStateContainer } from '../app/types.js';

/**
 * Capabilities: what a contributor is handed, and nothing else.
 *
 * This is the module the whole Application/Extension split turns on, so it is worth stating what it
 * is reacting against.
 *
 * In the previous generation, `Extension.activate(shell: Shell)` received one object holding
 * `layout, commands, extensions, views, activityBar, tabs, theme, shortcuts, dnd, app, transport,
 * nodeID`. Every extension could therefore reach the activity bar and the tab service, which meant
 * every extension was implicitly an extension *of an IDE*. A blog written against that interface
 * would still be handed a docking system. That single choice is why the framework could only ever
 * produce one kind of application.
 *
 * Here a contributor declares `needs`, and its context is derived from that declaration:
 *
 *     needs: ['net', 'commands'] as const
 *       → cx.net and cx.commands exist
 *       → cx.notifications is a compile error, not undefined at runtime
 *
 * Two consequences follow, and both are the point:
 *
 * - A contributor that never asked for `windows` cannot open one, so it runs unchanged whether the
 *   host arranges applications as tiles, as floating windows, or as a single maximised page.
 * - `needs` is a complete, machine-readable statement of what a bundle touches, so a host can
 *   refuse to load one whose requirements it cannot meet — before running any of its code, with a
 *   message naming both sides.
 *
 * Nothing is implicit except identity, state and cleanup. Even `log` must be declared. That is
 * mildly annoying to write and it is the price of `needs` being the whole truth rather than most of
 * it.
 *
 * **Status: these are declarations.** The capability interfaces below describe the surface each
 * subsystem must present. Only `state` is implemented today (`AppStateContainer`); the rest are
 * being built. They are written down first because the Application and Extension contracts are
 * meaningless without them, and because a capability whose shape is decided after its consumers
 * exist is a capability shaped by whoever called it first.
 */

// ─── Contract references ─────────────────────────────────────────────────────

/**
 * Structural reference to a mesh contract.
 *
 * Deliberately structural rather than an import of mesh's concrete contract type: this is the shape
 * `defineContract` already produces, and matching it structurally means the browser framework
 * infers real input and output types without taking a dependency on the server's declaration
 * machinery.
 */
export interface ContractRef<TInput, TOutput> {
    readonly domain: string;
    readonly action: string;
    readonly inputSchema: { parse(value: unknown): TInput };
    readonly outputSchema: { parse(value: unknown): TOutput };
}

/** Structural reference to a mesh event, as `defineEvent` produces it. */
export interface EventRef<TPayload> {
    readonly name: string;
    readonly schema: { parse(value: unknown): TPayload };
}

/** Structural reference to a CRUD contract, as `defineCrud` produces it. */
export interface CrudRef<TRecord> {
    readonly domain: string;
    readonly schema: { parse(value: unknown): TRecord };
}

// ─── net ─────────────────────────────────────────────────────────────────────

/** An open bidirectional channel. Only for things that genuinely are — terminals, editors. */
export interface Channel<TIn = unknown, TOut = unknown> {
    send(message: TIn): void;
    onMessage(handler: (message: TOut) => void): DisposeFn;
    readonly state: ReadonlySignal<'connecting' | 'open' | 'closed'>;
    close(): void;
}

/**
 * The network abstraction: contract-addressed, transport invisible.
 *
 * The caller names a contract and gets a typed answer. Whether that travelled as REST, as an SSE
 * stream, or over a socket is exposure policy declared on the server, not a choice made at the call
 * site — which is what lets a contract change transport without touching a screen.
 *
 * What this is *not* is a mesh transport. The browser does not join the mesh; it speaks HTTP to a
 * node's API. The previous generation ran a full `MeshApp` with a WebSocket transport in the tab,
 * making every browser a peer on the cluster network, and that is not coming back.
 */
export interface Net {
    /** The API origin this application talks to. May differ from where the page was served. */
    readonly baseUrl: string;
    call<TInput, TOutput>(contract: ContractRef<TInput, TOutput>, input: TInput): Promise<TOutput>;
    subscribe<TPayload>(event: EventRef<TPayload>, handler: (payload: TPayload) => void): DisposeFn;
    connect<TIn, TOut>(contract: ContractRef<TIn, TOut>): Promise<Channel<TIn, TOut>>;
}

// ─── events ──────────────────────────────────────────────────────────────────

/**
 * One bus for local and remote events.
 *
 * A screen should not care whether a record changed because this tab saved it or because another
 * node did. Both arrive here. The distinction is available (`origin`) for the cases that genuinely
 * need it — optimistic-update reconciliation, mostly — and absent from the common path.
 */
export interface Events {
    emit<TPayload>(event: EventRef<TPayload>, payload: TPayload): void;
    on<TPayload>(
        event: EventRef<TPayload>,
        handler: (payload: TPayload, origin: 'local' | 'remote') => void,
    ): DisposeFn;
}

// ─── commands ────────────────────────────────────────────────────────────────

/**
 * A command: the single indirection between "a thing the product can do" and every way of invoking
 * it — a menu item, a keybinding, the palette, a button, another extension.
 *
 * Nothing binds a key directly to a function. That rule is what makes a command palette and a
 * user-remappable keymap fall out of the design instead of being retrofitted onto it.
 */
export interface CommandDefinition<TArgs extends readonly unknown[] = readonly []> {
    readonly id: string;
    readonly label: string;
    readonly category?: string;
    readonly description?: string;
    /** Availability predicate. A command whose `when` is false is not offered and cannot run. */
    when?(): boolean;
    run(...args: TArgs): void | Promise<void>;
}

export interface Commands {
    register<TArgs extends readonly unknown[]>(command: CommandDefinition<TArgs>): DisposeFn;
    execute<TArgs extends readonly unknown[]>(id: string, ...args: TArgs): Promise<void>;
    /** Every command currently available, `when` already applied. Drives the palette. */
    available(): readonly CommandDefinition[];
}

// ─── keys ────────────────────────────────────────────────────────────────────

/**
 * Keybindings, expressed as canonical strings: `Ctrl+Shift+P`, `Ctrl+\``, `Alt+Left`.
 *
 * Modifier order is normalised (Ctrl → Shift → Alt → Meta) and macOS Meta folds to Ctrl, so one
 * declaration works on every platform. A binding names a command; it never names a function.
 */
export interface Keys {
    bind(keybinding: string, commandId: string, options?: { when?(): boolean }): DisposeFn;
    /** What this binding resolves to right now, or undefined. For conflict reporting. */
    resolve(keybinding: string): string | undefined;
}

// ─── menus ───────────────────────────────────────────────────────────────────

export interface MenuItem {
    readonly id: string;
    readonly label: string;
    /** The command this item invokes. Items without one are separators or submenus. */
    readonly command?: string;
    readonly submenu?: readonly MenuItem[];
    readonly separatorBefore?: boolean;
    readonly order?: number;
}

/** Where a menu attaches. `context:<name>` targets a context menu raised by a contributor. */
export type MenuTarget = 'menubar' | 'window' | 'status' | `context:${string}`;

export interface Menus {
    contribute(target: MenuTarget, items: readonly MenuItem[]): DisposeFn;
    /** Raise a context menu at a point. Returns when it closes. */
    context(items: readonly MenuItem[], at: { x: number; y: number }): Promise<void>;
}

// ─── notifications ───────────────────────────────────────────────────────────

export interface NotificationAction {
    readonly label: string;
    run(): void | Promise<void>;
}

export interface NotificationOptions {
    readonly detail?: string;
    readonly actions?: readonly NotificationAction[];
    /** Auto-dismiss delay. Omit for sticky. Errors are sticky by default. */
    readonly timeoutMs?: number;
}

/**
 * A live handle on a posted notification.
 *
 * Fire-and-forget toasts cannot express a long operation, so posting returns something addressable.
 * The handle stays valid after its poster is backgrounded — a deploy started in one Application and
 * finished while another was showing still reports.
 */
export interface NotificationHandle {
    readonly id: string;
    update(patch: { message?: string; detail?: string; progress?: number }): void;
    done(message?: string): void;
    dismiss(): void;
}

/**
 * Notifications: one API, presentation owned by the host.
 *
 * A blog, a console and an IDE post identically. What differs is where it lands — an inline banner,
 * a footer line, a toast above the status bar — and that is the host's decision, never the
 * Application's. This is the whole reason notifications are a capability rather than a component
 * somebody imports.
 */
export interface Notifications {
    info(message: string, options?: NotificationOptions): NotificationHandle;
    warn(message: string, options?: NotificationOptions): NotificationHandle;
    error(message: string, options?: NotificationOptions): NotificationHandle;
    progress(message: string, options?: NotificationOptions): NotificationHandle;
    /** Ask for a decision. Resolves to the chosen action's label, or undefined if dismissed. */
    ask(message: string, actions: readonly NotificationAction[]): Promise<string | undefined>;
}

// ─── models ──────────────────────────────────────────────────────────────────

/**
 * A live collection over a CRUD contract.
 *
 * This is what stops every screen writing its own fetch-into-a-signal. Records are identity-mapped,
 * so two screens showing the same row show the same object; remote changes arrive through the event
 * bus and update it in place; writes are optimistic and roll back on failure.
 */
export interface Collection<TRecord extends { readonly id: string }> {
    readonly items: ReadonlySignal<readonly TRecord[]>;
    readonly loading: ReadonlySignal<boolean>;
    readonly error: ReadonlySignal<Error | null>;
    get(id: string): ReadonlySignal<TRecord | undefined>;
    create(input: Omit<TRecord, 'id'>): Promise<TRecord>;
    update(id: string, patch: Partial<Omit<TRecord, 'id'>>): Promise<TRecord>;
    remove(id: string): Promise<void>;
    refresh(): Promise<void>;
}

export interface Models {
    collection<TRecord extends { readonly id: string }>(crud: CrudRef<TRecord>): Collection<TRecord>;
}

// ─── windows ─────────────────────────────────────────────────────────────────

export interface WindowGeometry {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

export type WindowState = 'normal' | 'minimized' | 'maximized' | 'fullscreen';

/** How the host is currently arranging windows. A contributor may read it; the user sets it. */
export type WindowMode = 'windowed' | 'tiled';

export interface WindowHandle {
    readonly id: string;
    readonly applicationId: string;
    readonly geometry: ReadonlySignal<WindowGeometry>;
    readonly state: ReadonlySignal<WindowState>;
    readonly focused: ReadonlySignal<boolean>;
    move(to: { x: number; y: number }): void;
    resize(to: { width: number; height: number }): void;
    setState(state: WindowState): void;
    focus(): void;
    close(): void;
}

export interface WindowOpenOptions {
    readonly applicationId: string;
    readonly title?: string;
    readonly geometry?: Partial<WindowGeometry>;
}

/**
 * Window management.
 *
 * Held by the host and handed only to contributors that declare it — which is what allows the
 * workbench (activity bar, docked panels, editor groups) to be an ordinary Extension rather than a
 * privileged layout baked into the framework. A different arrangement is a different Extension, and
 * a blog is a single maximised window that never asks for this capability at all.
 */
export interface Windows {
    readonly mode: ReadonlySignal<WindowMode>;
    setMode(mode: WindowMode): void;
    open(options: WindowOpenOptions): WindowHandle;
    list(): readonly WindowHandle[];
    readonly focused: ReadonlySignal<WindowHandle | undefined>;
}

// ─── storage and log ─────────────────────────────────────────────────────────

/** Key/value storage namespaced to the contributor. Keys cannot collide across contributors. */
export interface ScopedStorage {
    get<T>(key: string, fallback: T): T;
    set<T>(key: string, value: T): void;
    remove(key: string): void;
}

export interface Log {
    debug(message: string, detail?: unknown): void;
    info(message: string, detail?: unknown): void;
    warn(message: string, detail?: unknown): void;
    error(message: string, detail?: unknown): void;
}

// ─── the map ─────────────────────────────────────────────────────────────────

/**
 * Every capability the host can provide, by name.
 *
 * Adding one is a framework decision, exactly as adding a `SurfaceRole` is. An open vocabulary here
 * would put us back where `Shell` was: contributors reaching for whatever happens to be hanging off
 * the host.
 */
export interface CapabilityMap {
    readonly net: Net;
    readonly events: Events;
    readonly commands: Commands;
    readonly keys: Keys;
    readonly menus: Menus;
    readonly notifications: Notifications;
    readonly models: Models;
    readonly windows: Windows;
    readonly storage: ScopedStorage;
    readonly log: Log;
}

export type CapabilityName = keyof CapabilityMap;

/**
 * What every contributor gets whether it asks or not: who it is, its own reactive state, and a way
 * to clean up. Nothing here can affect anything outside the contributor itself.
 */
export interface ContributionBase {
    readonly id: string;
    readonly state: AppStateContainer;
    registerCleanup(cleanup: () => void): void;
}

/**
 * The context handed to `activate`, derived from the `needs` declaration.
 *
 * With `needs: ['net', 'commands'] as const`, this resolves to
 * `ContributionBase & { net: Net; commands: Commands }` — so an undeclared capability is a
 * compile-time error at the use site rather than an `undefined` discovered at runtime by a user.
 *
 * Declaring nothing resolves to `ContributionBase` alone, which is the correct default: a
 * contributor that has not said what it touches may touch nothing.
 */
export type CapabilityContext<TNeeds extends readonly CapabilityName[]> = ContributionBase & {
    readonly [K in TNeeds[number]]: CapabilityMap[K];
};
