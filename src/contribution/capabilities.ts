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
import type { Json } from '../description/types.js';

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
