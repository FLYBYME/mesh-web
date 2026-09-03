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
}

export type CapabilityName = keyof CapabilityMap;

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
    readonly [K in TNeeds[number]]: CapabilityMap[K];
};
