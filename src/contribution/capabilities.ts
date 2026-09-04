/**
 * Capabilities: what a contribution may reach, and nothing else.
 *
 * spec/kernel.md section 4. Declaring `needs('net', 'commands')` produces a context with exactly
 * those two on it — a compile error for anything else, and `undefined` at run time, because the
 * kernel builds the object from the same list.
 *
 * The reaction this is against: the previous generation handed every extension a `Shell` carrying
 * `layout, activityBar, tabs, docking, transport`, so every extension was implicitly an extension
 * *of an IDE*. A blog written against it still received a docking system.
 */

import type { Signal } from '../reactivity/types.js';
import type { Json, Node } from '../description/types.js';

// ---------------------------------------------------------------------------- state

export interface State {
    signal<T>(initial: T): Signal<T>;
    computed<T>(fn: () => T): () => T;
    effect(fn: () => void): void;
}

// ---------------------------------------------------------------------------- log

export interface Log {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, error?: unknown): void;
}

// ---------------------------------------------------------------------------- commands

/**
 * A command's *implementation*. Its id and title are declared in the manifest and merged at boot,
 * so the palette and the keymap know about a command before its Application has started
 * (spec/application.md section 2).
 */
export type CommandImpl = (...args: readonly Json[]) => void | Promise<void>;

export interface Commands {
    /**
     * Supply the body of a declared command.
     *
     * Only an id from this contribution's own `commands` declaration is accepted — checked at
     * compile time by the literal union, and again here, because a bundle can be built elsewhere.
     */
    implement(id: string, run: CommandImpl): void;
    /** Invoke any command the kernel knows about, whoever declared it. */
    run(id: string, ...args: readonly Json[]): Promise<void>;
}

// ---------------------------------------------------------------------------- notifications

export interface NotificationHandle {
    update(message: string): void;
    dismiss(): void;
}

export interface Notifications {
    info(message: string): NotificationHandle;
    warn(message: string): NotificationHandle;
    error(message: string, error?: unknown): NotificationHandle;
}

// ---------------------------------------------------------------------------- windows

export interface WindowHandle {
    readonly id: string;
    focus(): void;
    close(): void;
}

export interface Windows {
    open(options: { readonly view: string; readonly params?: Readonly<Record<string, Json>> }): WindowHandle;
    readonly own: () => readonly WindowHandle[];
}

// ---------------------------------------------------------------------------- chrome

/**
 * One window, as chrome sees it.
 *
 * Deliberately **not** `WindowRecord`. Chrome needs to draw a tab and put a frame in a place; it does
 * not need the record the manager keeps, and handing it over would make every field of an internal
 * structure part of the contract an outside author writes against.
 */
export interface ChromeWindow {
    readonly id: string;
    /** Which contribution's window this is. A tab says who it belongs to. */
    readonly owner: string;
    readonly view: string;
    readonly title: string;
    /** Its slot in the split tree, in tiled mode. `undefined` for a window with no tile. */
    readonly tile: string | undefined;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly closable: boolean;
}

/**
 * Draw the shell: activity bar, tabs, panels, status bar.
 *
 * [extension §8](../../spec/extension.md) makes the workbench an Extension, and calls it the
 * load-bearing test of the whole design — *if the IDE shell cannot be written as an ordinary
 * Extension over the window manager, the capability split is wrong.* Writing it found that it could
 * not: `windows` gives a contribution `open()` and `own()`, so a workbench could see its own windows
 * and nobody else's, and tabs for every window is the entire job.
 *
 * The wrong repair would be to hand the workbench the `WindowManager`. That is the `Shell` god object
 * [kernel §2](../../spec/kernel.md) rejects, one layer down — the previous generation passed every
 * extension `layout, activityBar, tabs, docking, transport`, so a blog received a docking system.
 *
 * So it is a capability, and it obeys the same three rules `credentials` does:
 *
 * - **Declared, therefore visible.** `needs('chrome')` is in a manifest, and observing every window
 *   is observing every Application. [kernel §4](../../spec/kernel.md)'s question — *could it observe
 *   another Application's state?* — answers yes, which is exactly why it is written down.
 * - **Narrow.** `ChromeWindow` above, not the manager's own record.
 * - **Mechanics stay in the kernel.** [kernel §2](../../spec/kernel.md): moving, resizing and
 *   stacking are kernel, not a decoration Extension, because a broken chrome must not be able to
 *   make windows unresizable. What chrome does here is *ask* — it renders a resize edge and reports
 *   the drag; the kernel decides what that means, applies the minimum size, and clamps to the
 *   viewport.
 */
export interface Chrome {
    /**
     * Every window, bottom to top.
     *
     * A function rather than a signal so it can be read inside an effect and re-run when the manager
     * changes — chrome is a view of the window list like any other view of any other state.
     */
    windows(): readonly ChromeWindow[];
    focused(): string | undefined;
    mode(): 'windowed' | 'tiled';

    /**
     * The node that says *the windows go here* — roadmap A6.3d.
     *
     * Chrome describes the whole page and puts this wherever it wants the window area. It is an
     * ordinary description node, so it composes like anything else, and the kernel finds it after
     * rendering and mounts the window layer inside. Chrome never receives an element.
     *
     * It must be **unconditional**: inside a `when` or an `each` it is destroyed and rebuilt on
     * every change, which re-parents every window and resets their scroll.
     */
    host(): Node;

    focus(id: string): void;
    /** Refused for a window whose view declared itself unclosable — chrome does not overrule that. */
    close(id: string): void;
    /** A drag reported, not a position assigned. The kernel clamps. */
    move(id: string, dx: number, dy: number): void;
    resize(id: string, edge: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw', dx: number, dy: number): void;
    setMode(mode: 'windowed' | 'tiled'): void;
}

// ---------------------------------------------------------------------------- credentials

/**
 * The seam the auth Extension owns: what goes on the wire for **every** call the page makes.
 *
 * spec/network.md §4 says the auth Extension attaches the ticket "so an Application never handles a
 * credential", and until this existed there was no mechanism by which it could. Wrapping its *own*
 * `net` would attach a ticket to its own calls and nobody else's; the thing that needs wrapping is
 * how the kernel builds a client, which is not an Application's to reach.
 *
 * So it is a capability, and it is deliberately shaped so that declaring it is *visible*:
 * `needs('credentials')` appears in a manifest, and a site can see exactly which contribution has
 * the page's credential seam. [kernel §4](../../spec/kernel.md)'s test — *could it observe another
 * Application's traffic?* — answers yes, which is why this is narrow, singular and declared rather
 * than ambient.
 */
export interface Credentials {
    /**
     * Attach these headers to every request every client makes, from now on.
     *
     * A function rather than a value because a ticket is refreshed, and one captured at activation
     * would be stale in exactly the case that matters. Called per request.
     *
     * **One contribution at a time.** A second `attach` from a different owner throws, naming both:
     * two things claiming the page's credential seam is a site that will send the wrong ticket
     * somewhere, and a boot failure is a much better way to find that out.
     */
    attach(headers: () => Readonly<Record<string, string>>): void;
    /** Stop attaching. Signing out, not tearing down — an Extension is never deactivated. */
    clear(): void;
    /** Where `net` sends requests. From the deployment descriptor's `api`; `''` means same origin. */
    readonly origin: string;
}

// ---------------------------------------------------------------------------- the map

/**
 * Every capability, by name.
 *
 * `net`, `events`, `keys`, `menus`, `models` and `storage` are specified and not yet built
 * (spec/roadmap.md A3). They are absent here rather than present-and-throwing: a name that resolves
 * to a broken object is worse than one that does not resolve, because the compile error is the
 * point.
 */
export interface CapabilityMap {
    readonly state: State;
    readonly log: Log;
    readonly commands: Commands;
    readonly notifications: Notifications;
    readonly windows: Windows;
    readonly credentials: Credentials;
    readonly chrome: Chrome;
}

/**
 * `net` is a capability name, and deliberately not a member of the map above.
 *
 * Every other capability has one type for everybody. `net` does not: it is typed by the API the
 * contribution declared in its manifest, so `cx.net.call` accepts that API's actions and no others
 * (spec/network.md section 4). A single entry here would have to be `NetClient<unknown>`, which is
 * the untyped version of exactly the thing being built.
 *
 * The cost is this comment and one `Exclude` in `CapabilityContext`. The alternative costs the
 * type parameter that makes `cx.net.call('resolver.query', { name })` check at all.
 */
export type CapabilityName = keyof CapabilityMap | 'net';

/** Declares what a contribution needs. See spec/extension.md section 2 for why not `as const`. */
export function needs<const T extends readonly CapabilityName[]>(...names: T): T {
    return names;
}

// ---------------------------------------------------------------------------- context

export interface ContributionBase {
    /** Kernel-assigned. Not the id in the bundle — identity comes from the thing that grants it. */
    readonly id: string;
    onDispose(fn: () => void): void;
}

export type CapabilityContext<TNeeds extends readonly CapabilityName[]> = ContributionBase & {
    readonly [K in Exclude<TNeeds[number], 'net'>]: CapabilityMap[K];
};
