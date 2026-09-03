/**
 * The two contracts: Extension and Application.
 *
 * A bundle `export default`s a class and the host constructs it. There is no `define*` and no
 * module-level registry — spec/extension.md section 2 has the argument, and the short form is that
 * importing a bundle must not be a side effect, one definition must not mean one instance, and
 * identity must come from the manifest rather than from the code.
 */

import type { CapabilityContext, CapabilityName } from './capabilities.js';
import type { Consumer, ProviderToken, ProviderTokens } from './provider.js';
import type { Json } from '../description/types.js';

/** Capabilities plus resolved providers. One type parameter per declaration, each written once. */
export type Context<
    TNeeds extends readonly CapabilityName[],
    TConsumes extends ProviderTokens = readonly [],
> = CapabilityContext<TNeeds> & Consumer<TConsumes>;

/** The API a contribution exposes, derived from its `provides` token. */
export type ApiOf<TProvides> = TProvides extends ProviderToken<infer TApi> ? TApi : void;

// ---------------------------------------------------------------------------- manifest pieces

export interface CommandDecl {
    readonly id: string;
    readonly title: string;
}

export interface KeyDecl {
    readonly command: string;
    readonly keys?: string;
    readonly gamepad?: string;
    readonly gesture?: string;
}

export interface MenuDecl {
    readonly target: 'menubar' | 'window' | 'status' | `context:${string}`;
    readonly title: string;
    readonly command: string;
    readonly group?: string;
}

export interface SettingDecl {
    readonly path: string;
    readonly hive: 'system' | 'user' | 'device' | 'session';
    readonly default: Json;
    readonly description?: string;
}

export interface ViewDecl {
    readonly id: string;
    readonly title: string;
    readonly tile?: string;
    readonly instances?: 'one' | 'many';
    readonly closable?: boolean;
}

/**
 * Everything the kernel reads off a constructed contribution before anything activates or starts.
 *
 * spec/application.md section 2: anything the kernel needs before the contribution runs must be
 * declared, not registered. Keys settle it on their own — a binding created by calling
 * `cx.keys.bind()` can never be rebound by the user.
 */
export interface Declarations {
    readonly needs?: readonly CapabilityName[];
    readonly consumes?: ProviderTokens;
    readonly provides?: ProviderToken<unknown>;
    readonly commands?: readonly CommandDecl[];
    readonly keys?: readonly KeyDecl[];
    readonly menus?: readonly MenuDecl[];
    readonly settings?: readonly SettingDecl[];
    readonly views?: readonly ViewDecl[];
}

// ---------------------------------------------------------------------------- the contracts

/**
 * An Extension: a capability contributed to whatever is running.
 *
 * Singleton, no route, activates once, and **never deactivated** (spec/extension.md section 6).
 * Something that wants a lifecycle should be an Application.
 */
export interface Extension<
    TNeeds extends readonly CapabilityName[],
    TConsumes extends ProviderTokens = readonly [],
    TProvides extends ProviderToken<unknown> | undefined = undefined,
> extends Declarations {
    readonly needs: TNeeds;
    readonly consumes?: TConsumes;
    readonly provides?: TProvides;
    activate(cx: Context<TNeeds, TConsumes>): ApiOf<TProvides>;
}

/**
 * An Application: a process.
 *
 * `views` is optional, because a headless Application is a background process and a daemon with no
 * window is an ordinary thing for an operating system to run (spec/application.md section 1).
 */
export interface Application<
    TNeeds extends readonly CapabilityName[],
    TConsumes extends ProviderTokens = readonly [],
    TProvides extends ProviderToken<unknown> | undefined = undefined,
> extends Declarations {
    readonly needs: TNeeds;
    readonly consumes?: TConsumes;
    readonly provides?: TProvides;
    readonly singleton?: boolean;
    start(cx: Context<TNeeds, TConsumes>): Promise<ApiOf<TProvides>>;
    stop?(): Promise<void>;
}

// ---------------------------------------------------------------------------- erased

/**
 * What the kernel holds: contributions whose type parameters it does not know.
 *
 * Concrete contributions stay assignable through **method bivariance** — `activate` and `start` are
 * methods, not properties. This was verified rather than assumed: an earlier draft reached for
 * `as unknown as` here and did not need it.
 */
export type ErasedContext = {
    readonly id: string;
    onDispose(fn: () => void): void;
    use(token: ProviderToken<unknown>): unknown;
} & Partial<import('./capabilities.js').CapabilityMap>;

export interface ErasedExtension extends Declarations {
    activate(cx: ErasedContext): unknown;
}

export interface ErasedApplication extends Declarations {
    readonly singleton?: boolean;
    start(cx: ErasedContext): Promise<unknown>;
    stop?(): Promise<void>;
}

export type ErasedContribution = ErasedExtension | ErasedApplication;

export function isExtension(c: ErasedContribution): c is ErasedExtension {
    return typeof (c as ErasedExtension).activate === 'function';
}

export function isApplication(c: ErasedContribution): c is ErasedApplication {
    return typeof (c as ErasedApplication).start === 'function';
}

// ---------------------------------------------------------------------------- construction

type Constructable<T> = new () => T;

/**
 * Construct a bundle's default export, and check it before trusting it.
 *
 * The check is possible *because* construction is side-effect free — the kernel can hold a
 * constructed contribution and inspect what it declares before activating anything
 * (spec/kernel.md section 3, step 3).
 */
export function construct(module: unknown, source: string): ErasedContribution {
    const exported = (module as { default?: unknown }).default;

    if (typeof exported !== 'function') {
        throw new Error(
            `${source}: a bundle must export default a class. ` +
            `Got ${exported === undefined ? 'no default export' : typeof exported}.`,
        );
    }

    let instance: unknown;
    try {
        instance = new (exported as Constructable<unknown>)();
    } catch (cause) {
        throw new Error(
            `${source}: constructing the default export threw. A constructor must be side-effect ` +
            `free — no DOM, no network, no registration. All of that belongs in activate() or ` +
            `start().`,
            { cause },
        );
    }

    const contribution = instance as ErasedContribution;
    const hasActivate = isExtension(contribution);
    const hasStart = isApplication(contribution);

    if (!hasActivate && !hasStart) {
        throw new Error(
            `${source}: the default export is neither an Extension nor an Application. ` +
            `An Extension has activate(); an Application has start().`,
        );
    }

    if (hasActivate && hasStart) {
        throw new Error(
            `${source}: the default export has both activate() and start(). ` +
            `An Extension is installed and never deactivated; an Application is run, stopped and ` +
            `restarted. A thing cannot be both.`,
        );
    }

    return contribution;
}
