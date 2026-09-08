/**
 * The two contracts: Extension and Application.
 *
 * A bundle `export default`s a class and the host constructs it. There is no `define*` and no
 * module-level registry — spec/extension.md section 2 has the argument, and the short form is that
 * importing a bundle must not be a side effect, one definition must not mean one instance, and
 * identity must come from the manifest rather than from the code.
 */

import type { CapabilityContext, CapabilityName } from './capabilities.js';
import type { AnyApiCall, Api } from '../net/api.js';
import type { LayoutNode } from '../window/layout.js';
import type { MeshClient } from '../net/client.js';
import type { Consumer, ProviderToken, ProviderTokens } from './provider.js';
import type { Json } from '../description/types.js';
import type { Models } from '../models/types.js';
import type { ComponentDefinition } from '../render/component.js';

/**
 * Capabilities, resolved providers, and the declared API. One type parameter per declaration, each
 * written once.
 *
 * The third parameter is what makes `cx.mesh` worth having: it is the API this contribution declared
 * as `api` in its manifest, so `cx.mesh.call` accepts that API's action names and infers their input
 * and output (spec/network.md section 4). Declaring `mesh` in `needs` without an `api` gives a
 * client over an empty action set — every call is a compile error, which is the correct answer to
 * "I asked to reach the cluster and never said which API".
 */
export type Context<
    TNeeds extends readonly CapabilityName[],
    TConsumes extends ProviderTokens = readonly [],
    TApi = Api<Record<string, never>>,
> = CapabilityContext<TNeeds> & Consumer<TConsumes> & MeshContext<TNeeds, TApi> & ModelsContext<TNeeds, TApi>;

/** `mesh` appears on the context only if it was asked for. */
type MeshContext<TNeeds extends readonly CapabilityName[], TApi> =
    'mesh' extends TNeeds[number] ? { readonly mesh: MeshClient<TApi> } : unknown;

/** `models` appears on the context only if it was asked for. */
type ModelsContext<TNeeds extends readonly CapabilityName[], TApi> =
    'models' extends TNeeds[number] ? { readonly models: Models<TApi> } : unknown;

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

export interface StoreDecl {
    readonly name: string;
    readonly hive: 'system' | 'user' | 'device' | 'session';
    readonly description?: string;
}

/**
 * What a view receives.
 *
 * `internal` is this part's own state (the internal context), handed to this part's own views and
 * never published to the outside world (spec/components.md section 5).
 *
 * `app` is whatever the Application's published API is (or the return value of start()).
 * It is here because a view legitimately sometimes wants the part's own public surface, but stops
 * being the only route to state.
 *
 * Both are here, rather than on the Application as fields, because a view mounts only after
 * `start()` resolves (when the process reaches `running`) — so the guarantee is carried by the
 * types and enforced at runtime by holding view mounting until `start()` finishes, instead of by a
 * definite-assignment assertion papering over a gap (spec/application.md section 6, roadmap A5.7b).
 */
export interface ViewContext<
    TParams = Record<string, never>,
    TApi = unknown,
    TInternal = never,
> {
    readonly params: TParams;
    readonly app: TApi;
    readonly internal: TInternal;
    setTitle(title: string): void;
    close(): void;
    onDispose(fn: () => void): void;
}

/**
 * A view type. Declared statically, because the kernel restores geometry before an Application
 * starts and must already know what views exist (spec/application.md section 6).
 *
 * `render` returns a **description**, not DOM. `render` and not `mount`: a view is a pure function
 * from application state to a description, and a view handed a container could hold logic
 * (spec/view-layer.md section 1).
 */
export interface ViewDecl<
    TParams = Record<string, never>,
    TApi = unknown,
    TInternal = never,
> {
    readonly id: string;
    readonly title: string;

    /**
     * How many of this view may exist at once. **Not a window question** — it is a fact about the
     * view, and a router honours it by replacing rather than stacking.
     */
    readonly instances?: 'one' | 'many';

    /**
     * **Hints for a chrome that draws windows. Every field is a suggestion and none is a promise.**
     *
     * These were `tile`, `defaultSize`, `minSize` and `closable` at the top level, and having them
     * there was the mistake: it made a *view* — a pure function from state to a description —
     * declare pixels and split-tree nodes, so an author writing one was invited to think about
     * window furniture. Four of the six fields on this interface were about a presentation choice
     * the view does not make.
     *
     * That is not a tidiness complaint. It is why every console here became a window: the type
     * said windows, so authors wrote windows, and a phone got a desktop it cannot drag. A chrome
     * that renders one view at a time and navigates between them — which is what a narrow screen
     * needs — ignores this object entirely and loses nothing.
     *
     * Grouped rather than deleted because a windowed chrome genuinely wants them, and a view
     * *may* know it is unreadable below some width. Optional, so the ordinary view says nothing.
     */
    readonly window?: {
        /** Which named node of the layout's split tree, in tiled mode. Ignored when windowed. */
        readonly tile?: string;
        readonly closable?: boolean;
        readonly defaultSize?: { readonly width?: number; readonly height?: number };
        readonly minSize?: { readonly width?: number; readonly height?: number };
    };

    /**
     * **Moved into `window`, and typed `never` so the move is loud.**
     *
     * Grouping them was not enough on its own: a view declared as a class property is inferred and
     * then checked structurally, and an extra property is *allowed* in that direction — so every
     * old declaration went on compiling and was silently ignored. Two tests in this repository did
     * exactly that, and the only symptom was a window 240px wide arriving at 480 and a tiled layout
     * with nothing in it. Nothing failed; the fields simply stopped being read.
     *
     * `?: never` makes the same declaration a type error that names the field. It costs four dead
     * lines and it is the difference between a migration somebody performs and one they discover
     * months later from a layout that is subtly wrong.
     */
    /** @deprecated Use `window.tile`. */
    readonly tile?: never;
    /** @deprecated Use `window.closable`. */
    readonly closable?: never;
    /** @deprecated Use `window.defaultSize`. */
    readonly defaultSize?: never;
    /** @deprecated Use `window.minSize`. */
    readonly minSize?: never;

    render(vx: ViewContext<TParams, TApi, TInternal>): DescriptionNode;
}

/** Imported as a type alias so this file does not depend on the description layer's runtime. */
type DescriptionNode = import('../description/types.js').Node;

/**
 * Everything the kernel reads off a constructed contribution before anything activates or starts.
 *
 * spec/application.md section 2: anything the kernel needs before the contribution runs must be
 * declared, not registered. Keys settle it on their own — a binding created by calling
 * `cx.keys.bind()` can never be rebound by the user.
 */
export type SessionRequirement = 'required' | 'optional';

export interface Declarations {
    readonly needs?: readonly CapabilityName[];
    readonly consumes?: ProviderTokens;
    readonly provides?: ProviderToken<unknown> | undefined;
    /**
     * Whether this contribution requires an authenticated session.
     *
     * 'required' means the contribution is unusable without a session (e.g. catalog).
     * 'optional' means the contribution can run signed out and uses a session if available.
     */
    readonly session?: SessionRequirement;
    /**
     * The API this contribution talks to, declared like everything else the kernel needs before the
     * contribution runs (spec/network.md section 4).
     *
     * Declaring it in the manifest earns the usual benefit: the kernel knows every API a site's
     * Applications will contact before any of them has started, which is exactly the list a review,
     * a CSP or an audit wants — and it is available without running anything.
     */
    readonly api?: Api<Record<string, AnyApiCall>>;
    /**
     * The split tree this Application's views are arranged into, in tiled mode.
     *
     * In the manifest and not built in `start()`, for the same reason views are: the kernel restores
     * geometry at boot step 9 and starts Applications at step 10, so it must already know the tile
     * names. A layout assembled during `start()` is too late by construction — the window would
     * appear at a default position and jump once the Application finished starting.
     *
     * Absent means the Application has no tiled arrangement, which is a perfectly ordinary thing for
     * a single-window tool to be.
     */
    readonly layout?: LayoutNode;
    readonly commands?: readonly CommandDecl[];
    readonly keys?: readonly KeyDecl[];
    readonly menus?: readonly MenuDecl[];
    readonly settings?: readonly SettingDecl[];
    readonly stores?: readonly StoreDecl[];
    /**
     * Components contributed by this part (spec/components.md §2).
     *
     * Contributed components extend the vocabulary beyond the 19 primitives (e.g. `ui.Card`,
     * `ui.Nav`). Declared in the manifest so the kernel resolves name collisions at load time
     * before anything renders.
     */
    readonly components?: readonly ComponentDefinition[];
    /**
     * `never` for params: a view with concrete params stays assignable here through method
     * bivariance, which is the same reason `EachNode`'s callbacks are methods rather than
     * properties. As `unknown` it would reject every real view.
     */
    readonly views?: readonly ViewDecl<never, never, never>[];
}

// ---------------------------------------------------------------------------- the contracts

/**
 * An Application's runtime instance, returning both a public API for use(TOKEN) and an internal
 * context for this part's own views (spec/components.md section 5).
 */
export interface ApplicationInstance<TPublic = unknown, TInternal = unknown> {
    readonly api?: TPublic;
    readonly internal: TInternal;
}

/**
 * What start() may return. When TInternal is never (the default for parts that do not opt in),
 * this collapses to TPublic (ApiOf<TProvides>), preserving complete backwards compatibility.
 */
export type ApplicationStartResult<TPublic = unknown, TInternal = never> = [TInternal] extends [never]
    ? TPublic
    : [TPublic] extends [void]
      ? { readonly internal: TInternal; readonly api?: void }
      : unknown extends TPublic
        ? { readonly internal: TInternal; readonly api?: unknown }
        : { readonly api: TPublic; readonly internal: TInternal };

/** Helper to construct an ApplicationInstance with explicit typing. */
export function applicationInstance<TPublic, TInternal>(instance: {
    readonly api?: TPublic;
    readonly internal: TInternal;
}): ApplicationInstance<TPublic, TInternal> {
    return instance;
}

/** Check whether a value returned by start() is an ApplicationInstance. */
export function isApplicationInstance(
    value: unknown,
): value is ApplicationInstance<unknown, unknown> {
    return (
        typeof value === 'object' &&
        value !== null &&
        'internal' in value &&
        value.internal !== undefined
    );
}

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
    TApi = Api<Record<string, never>>,
> extends Declarations {
    readonly needs: TNeeds;
    readonly consumes?: TConsumes;
    readonly provides?: TProvides;
    activate(cx: Context<TNeeds, TConsumes, TApi>): ApiOf<TProvides>;
}

/**
 * An Application: a process.
 *
 * `views` is optional, because a headless Application is a background process and a daemon with no
 * window is an ordinary thing for an operating system to run (spec/application.md section 1).
 *
 * An Application may return just its public API from `start()`, or an object holding both its public
 * API (`api`) and its internal context (`internal`) handed to its views (spec/components.md section 5).
 */
export interface Application<
    TNeeds extends readonly CapabilityName[],
    TConsumes extends ProviderTokens = readonly [],
    TProvides extends ProviderToken<unknown> | undefined = undefined,
    TApi = Api<Record<string, never>>,
    TInternal = never,
> extends Declarations {
    readonly needs: TNeeds;
    readonly consumes?: TConsumes;
    readonly provides?: TProvides;
    readonly singleton?: boolean;
    start(cx: Context<TNeeds, TConsumes, TApi>): Promise<ApplicationStartResult<ApiOf<TProvides>, TInternal>>;
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
