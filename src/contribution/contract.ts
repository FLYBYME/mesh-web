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
import type { Action, IntentValue, Json, Registrar } from '../description/types.js';
import type { Models } from '../models/types.js';
import type { ComponentDefinition } from '../render/component.js';
import type { ApiDecl } from './api.js';

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
/**
 * What a view is handed.
 *
 * Three slots, and they are **input, state and output** in that order — the same three every part
 * has. `params` is what it was addressed with, `internal` is what its own part knows, `app` is what
 * that part publishes to everyone else.
 *
 * **A view reads `internal`. It should almost never read `app`.** `app` is here because a view may
 * legitimately render something its own part publishes, and because a composite published by an
 * extension is rendered against that extension's published surface. But a view reaching for `app` to
 * find its own state is the mistake this ordering exists to make obvious: that state belongs in
 * `internal`, and putting it in `app` publishes it to every part on the page and to any tool caller.
 *
 * `TInternal` no longer defaults to `never`. Defaulting it is what made "publish everything" the
 * path of least resistance — see `ApplicationInstance`.
 */
export interface ViewContext<
    TParams = Record<string, never>,
    TInternal = unknown,
    TApi = unknown,
> {
    /** What this view was addressed with. Serialisable by construction, so every view is a URL. */
    readonly params: TParams;
    /** What this part knows and does not share. Where a view's state belongs. */
    readonly internal: TInternal;
    /** What this part publishes. Read it to render something published; never to find state. */
    readonly app: TApi;

    /**
     * **Register a closure and get back the action that refers to it.**
     *
     * The incidental half of input. A declared `command` is a verb the whole system knows — it is in
     * the palette, bindable to a key, callable by a tool — and most of what a screen does is not
     * that: *this row is now selected*, *this dialog is closed*, *this filter changed*. Minting a
     * palette command per row is how a command list becomes noise.
     *
     * ```ts
     * element('Button', { intents: { activate: { action: vx.on(() => selected.set(row.id)) } } })
     * ```
     *
     * The function stays here; only an id crosses into the description, which is what lets a
     * description be serialisable while an author writes an ordinary closure
     * (spec/view-layer.md §5).
     *
     * **This is roadmap A8.10, and its absence was not a gap but a silence.** `createHandlerTable`
     * existed, `mountView` created one per window, and the dispatcher resolved handler actions
     * against it — but nothing gave a view a way to *put* a function in it, so every
     * `{ kind: 'handler' }` intent resolved to nothing and the click did nothing. Silently: an
     * unresolved handler is *"a stale event, not a crash"*. `ui.ActionButton`, `ui.ActionCard` and
     * mesh-core's `EntityItem` selection were all inert, and their tests passed because each called
     * the composite's `run()` directly — a test that calls a piece never presses it.
     *
     * Scoped to this view instance and disposed with it, so a handler cannot outlive the screen
     * that owns it.
     *
     * **A `Registrar`, and therefore passable.** A composite is constructed by `create(props)` and
     * has no view to ask, so it receives this the way it receives everything else — as a prop:
     * `ui.ActionButton({ command, on: vx.on })`. That is the second half of A8.10 and the reason
     * three of mesh-core's fourteen were inert even after this landed.
     */
    readonly on: Registrar;

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
    TInternal = unknown,
    TApi = unknown,
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

    render(vx: ViewContext<TParams, TInternal, TApi>): DescriptionNode;
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

    /**
     * **What this part offers other parts, declared before it runs.**
     *
     * The static half of `PartApi`: names, descriptions and schemas, with no implementations. It is
     * here rather than only in `start()`'s return for the same reason `views` is — the kernel reads
     * a manifest before anything activates, so a site can be told what a page's parts will offer
     * without running them, and that list is exactly what a review, a generated client or a tool
     * caller wants.
     *
     * `checkBindings` verifies at start that what was declared is what was bound, in both
     * directions. See `./api.ts`.
     *
     * Named `publishes` and not `api`, because `api` above is already this part's **inward** surface
     * — the API it talks to. The two point in opposite directions and sharing a word would make
     * every reference ambiguous.
     */
    readonly publishes?: ApiDecl;
}

// ---------------------------------------------------------------------------- the contracts

/**
 * **What `start()` returns: what this part keeps, and what it offers.**
 *
 * `internal` is required. It was optional, defaulting to `never`, and the default is what produced
 * every over-published API in the codebase — opting out was free and opting in cost extra ceremony,
 * so nobody opted in, so `render` received the *public* API and everything a view touched had to
 * become public. `PeopleApi` ended with 33 members of which eight were genuinely public, including
 * `newAccountPassword: Signal<string>` — a password buffer, publicly readable and writable by any
 * part holding the token.
 *
 * A part that keeps nothing writes `internal: {}` and has said so deliberately. That is the whole
 * cost, and it buys the question being asked once per part instead of never.
 *
 * `api` stays optional because publishing nothing is ordinary. When present it is a `PartApi` —
 * commands, components and readable state — checked against the manifest by `checkBindings`.
 */
export interface ApplicationInstance<TPublic = unknown, TInternal = unknown> {
    readonly api?: TPublic;
    readonly internal: TInternal;
}

/**
 * **Was a three-branch conditional whose only job was backwards compatibility.**
 *
 * It read *"when TInternal is never — the default for parts that do not opt in — this collapses to
 * TPublic, preserving complete backwards compatibility"*, and it is why `ClockApp`'s signature took
 * five type parameters and could not be read. There is no v1 and nobody outside to stay compatible
 * with, so the compatibility was with a week of our own code, which has since been deleted.
 */
export type ApplicationStartResult<TPublic = unknown, TInternal = unknown> =
    ApplicationInstance<TPublic, TInternal>;

/** Helper to construct an ApplicationInstance with explicit typing. */
export function applicationInstance<TPublic, TInternal>(instance: {
    readonly api?: TPublic;
    readonly internal: TInternal;
}): ApplicationInstance<TPublic, TInternal> {
    return instance;
}

/**
 * **What a part that keeps nothing returns.**
 *
 * `internal` is required, and a great many parts genuinely hold no state — a part that renders from
 * what it consumes and publishes a couple of commands has nothing of its own. Writing
 * `{ internal: {} }` by hand at every one of those is noise that obscures the parts where the answer
 * is interesting.
 *
 * So: `KEEPS_NOTHING` says it once, and says it in a way that reads as a decision rather than a
 * shrug. `return { ...KEEPS_NOTHING, api }` for a part that publishes; `return KEEPS_NOTHING` for
 * one that does not.
 *
 * It is deliberately not a default. The whole reason `internal` became required is that defaulting
 * it made *publish everything* the path of least resistance.
 */
export const KEEPS_NOTHING: { readonly internal: Record<string, never> } = { internal: {} };

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
    TInternal = unknown,
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
