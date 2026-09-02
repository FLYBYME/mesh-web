import type { SurfaceDefinition } from '../app/types.js';
import type {
    CapabilityContext,
    CapabilityMap,
    CapabilityName,
    ContributionBase,
    MenuItem,
    MenuTarget,
} from './capabilities.js';

/**
 * What a bundle exports.
 *
 * An extension module default-exports an `Extension`. An application module default-exports an
 * `Application`. The host imports the module, constructs the class, and drives its lifecycle.
 *
 * There is deliberately no `defineExtension()` and no registry here, and the difference matters
 * more than it looks.
 *
 * A `define*` call that self-registers into a module-level map is how *mesh contracts* work, and it
 * is right there: a contract is a global declaration, there is exactly one of each, and importing
 * the file is the act of declaring it. None of that is true of a screen. Copying the pattern across
 * bought three problems and no benefit:
 *
 * - **Importing became a side effect.** A host could not look at a bundle without mutating global
 *   state, so it could not inspect one, reject one, or load the same one twice.
 * - **One definition meant one instance.** A window manager whose whole point is that you can open
 *   two chart windows cannot be built on a registry holding a single frozen definition per id.
 *   With a constructor the host calls `new` per window and each gets its own state.
 * - **Identity came from the code.** Two bundles claiming one id was an error thrown at import
 *   time, in the browser, from a module the host had not decided to trust yet. Identity belongs to
 *   the manifest — the host knows what it asked for and names the instance accordingly.
 *
 * The mesh is the network. It is not a model for how a page is put together, and the UI should not
 * be shaped like it.
 */

// ─── Declarative contributions ───────────────────────────────────────────────

/**
 * A command an Extension provides, declared as data in the manifest.
 *
 * No `run` here on purpose: declarative contributions are registered **without fetching the
 * bundle**, so commands appear in the palette, menu items in the menu bar and keybindings in the
 * keymap while none of the extension's code has been downloaded. Invoking one constructs the
 * Extension, activates it, and then dispatches.
 *
 * A host with forty extensions should cost forty manifest entries at boot, not forty bundles. The
 * implementations are registered against these ids during `activate`, through `cx.commands`.
 */
export interface CommandContribution {
    readonly id: string;
    readonly label: string;
    readonly category?: string;
    readonly description?: string;
    /** Default binding. A user keymap overrides it; a conflict is reported, never silently won. */
    readonly keybinding?: string;
}

export interface MenuContribution {
    readonly target: MenuTarget;
    readonly items: readonly MenuItem[];
}

/**
 * A view an Extension can place.
 *
 * `slot` names where it wants to go. Whether that slot exists is the host's business — a view
 * asking for `sidebar.primary` under a host with no sidebar is simply not placed, which is a normal
 * outcome and not an error. Same refusal rule surfaces already follow.
 */
export interface ViewContribution {
    readonly id: string;
    readonly title: string;
    readonly slot: string;
    readonly icon?: string;
    readonly order?: number;
}

export interface Contributions {
    readonly commands?: readonly CommandContribution[];
    readonly menus?: readonly MenuContribution[];
    readonly views?: readonly ViewContribution[];
}

// ─── Extension ───────────────────────────────────────────────────────────────

/**
 * An Extension: a capability contributed to whatever is running.
 *
 * Auth. Logging. Telemetry. Source control. A language service. The workbench itself.
 *
 * No route and no page surface — an Extension cannot be navigated to. It is constructed once, spans
 * every Application, and outlives all of them. What it adds is available to Applications written
 * later by people who have never heard of it.
 *
 * The workbench — activity bar, docked panels, editor groups, tabs — is an Extension like any
 * other: it declares `windows` and arranges them. That is the test of whether this split is real.
 * If the IDE shell needs privileges no other extension can have, the split is cosmetic.
 *
 * ```ts
 * export default class AuthExtension implements Extension<['net', 'commands'], AuthApi> {
 *     readonly needs = ['net', 'commands'] as const;
 *
 *     activate(cx: CapabilityContext<['net', 'commands']>): AuthApi {
 *         cx.commands.register({ id: 'auth.signOut', label: 'Sign out', run: () => ... });
 *         return { session: cx.state.signal<Session | null>(null) };
 *     }
 * }
 * ```
 */
export interface Extension<
    TNeeds extends readonly CapabilityName[] = readonly [],
    TExports = void,
> {
    /**
     * Capabilities this Extension uses.
     *
     * Read by the host **before** `activate`, so an Extension asking for something the host cannot
     * provide is refused by name rather than handed a context with holes in it. Written `as const`,
     * it also types the context: an undeclared capability is a compile error at the use site.
     */
    readonly needs?: Readonly<TNeeds>;

    /** Other extensions this one depends on, by manifest id. Activated first, or this is refused. */
    readonly uses?: readonly string[];

    /**
     * Called once, when the Extension is first needed.
     *
     * Whatever it returns becomes this Extension's exports, available to anything naming it in
     * `uses`. Returning nothing is normal — an Extension that only registers commands has no
     * providers to offer.
     */
    activate(cx: CapabilityContext<TNeeds>): TExports | Promise<TExports>;

    /**
     * Called on deactivation or host shutdown.
     *
     * Usually unnecessary: everything registered through a capability returns a disposer the host
     * tracks, and everything created through `cx.state` is bound to a reactive scope that is
     * disposed for you. This is for the residue neither covers.
     */
    deactivate?(): void | Promise<void>;
}

// ─── Application ─────────────────────────────────────────────────────────────

/**
 * Where an Application's backend and bundles live.
 *
 * Declared rather than assumed to be the page's own origin, because it is not: the web server and
 * the API are separate listeners on separate ports, so the browser talks to an origin it was told
 * about rather than the one it was served from.
 *
 * Two consequences, both load-bearing:
 *
 * - **Cross-origin is the normal case.** The session cannot ride on a same-origin cookie, so
 *   credentials are explicit. Code assuming same-origin is assuming a deployment that will not
 *   exist.
 * - **These are usually filled in, not written.** Under paas an Application is told its API and
 *   asset URLs at deploy time; a hand-written value is the development case and the override.
 *
 * The same declaration is what makes loading an Application served by another node work at all,
 * instead of federation being a special path bolted on later.
 */
export interface ApplicationEndpoints {
    /** Base URL of the API this Application calls. Becomes `cx.net.baseUrl`. */
    readonly api?: string;
    /** Base URL its bundles, styles and static assets are served from. */
    readonly assets?: string;
}

/**
 * How an Application wants to be presented — a preference the host may decline.
 *
 * The host decides whether it is arranging floating windows or tiles. An Application says what it
 * would prefer and works either way; one that functions in only one mode cannot appear in the other
 * host, which defeats the point of having two.
 */
export interface WindowPreferences {
    /** Preferred arrangement. `either` — the default — means it does not care. */
    readonly mode?: 'windowed' | 'tiled' | 'either';
    readonly initialSize?: { readonly width: number; readonly height: number };
    readonly minSize?: { readonly width: number; readonly height: number };
    readonly resizable?: boolean;
    /**
     * Whether a second window of this Application may be opened. Defaults to `true` — one instance.
     *
     * Set `false` for anything a person would reasonably want two of side by side: a chart, an
     * editor, a log viewer. This is a product decision rather than a technical one, which is why it
     * is declared and not inferred — and it is the reason an Application is a constructor rather
     * than a registered definition, since each window needs its own instance and its own state.
     */
    readonly singleton?: boolean;
}

/**
 * An Application: a destination. The thing a person is *in*.
 *
 * The console, a blog, a landing page, an IDE, a trading desk. It owns routes and screens. Several
 * are loaded at once, one window is focused, and a non-singleton Application may have several
 * windows — each its own instance of this class.
 *
 * ```ts
 * export default class ConsoleApplication implements Application<['net', 'notifications']> {
 *     readonly needs = ['net', 'notifications'] as const;
 *     readonly window = { mode: 'either', minSize: { width: 640, height: 480 } } as const;
 *     readonly surfaces = [{ role: 'page', route: '/organizations', mount }] as const;
 *
 *     async onLoad(cx: CapabilityContext<['net', 'notifications']>) { ... }
 * }
 * ```
 */
export interface Application<TNeeds extends readonly CapabilityName[] = readonly []> {
    /** Capabilities this Application uses. Read before construction of any window. */
    readonly needs?: Readonly<TNeeds>;

    /** Extensions this Application depends on, by manifest id. Refused at load if unavailable. */
    readonly uses?: readonly string[];

    readonly endpoints?: ApplicationEndpoints;
    readonly window?: WindowPreferences;

    /**
     * Screens. A surface says what kind of thing it is, never where it goes — placement is the
     * compositor's, and refusal is a normal outcome rather than an error.
     *
     * Required, unlike everything else here. An Application is a destination, and a destination
     * that declares nowhere to appear is not one — it would load, occupy an id, and render nothing,
     * which is a bug that looks like a configuration. An Extension is the thing with no surfaces of
     * its own; if that is what you are writing, write that instead.
     */
    readonly surfaces: readonly SurfaceDefinition<unknown>[];

    onLoad?(cx: CapabilityContext<TNeeds>): void | Promise<void>;
    onActivate?(cx: CapabilityContext<TNeeds>): void | Promise<void>;
    onDeactivate?(cx: CapabilityContext<TNeeds>): void | Promise<void>;
    onUnload?(cx: CapabilityContext<TNeeds>): void | Promise<void>;
}

// ─── Loading a bundle ────────────────────────────────────────────────────────

/**
 * A bundle arrives as `unknown`, and that is not pedantry — it was fetched over the network from a
 * URL a manifest named, so everything it claims about itself has to be checked rather than
 * asserted. The two functions below check what is genuinely checkable, at the moment it becomes
 * checkable, and nothing more.
 *
 * The failure they exist to name: a bundle whose entry point forgot `export default` used to fail
 * later and elsewhere as `undefined is not a constructor`, with a stack pointing into framework
 * code rather than at the bundle that was actually wrong.
 */

/**
 * The context a host can actually promise at the point it calls `activate`.
 *
 * A host reads `needs` at runtime and builds a context holding exactly those capabilities, so from
 * the erased side — where the concrete `TNeeds` has been forgotten — every capability is *possibly*
 * present and none is guaranteed. `Partial<CapabilityMap>` is the honest name for that.
 *
 * A concrete `Extension<['net']>` remains assignable to the erased form: TypeScript checks method
 * parameters bivariantly, and the runtime object really does carry `net` because the host built it
 * from that same declaration. The narrow type is the one contributors write against and the one
 * that catches mistakes; this one exists so the host can hold a heterogeneous collection of them.
 */
export type ErasedContext = ContributionBase & Partial<CapabilityMap>;

/** An Extension whose capability declaration is only known at runtime. What a host holds. */
export interface ErasedExtension {
    readonly needs?: readonly CapabilityName[];
    readonly uses?: readonly string[];
    activate(cx: ErasedContext): unknown;
    deactivate?(): void | Promise<void>;
}

/** An Application whose capability declaration is only known at runtime. What a host holds. */
export interface ErasedApplication {
    readonly needs?: readonly CapabilityName[];
    readonly uses?: readonly string[];
    readonly endpoints?: ApplicationEndpoints;
    readonly window?: WindowPreferences;
    readonly surfaces: readonly SurfaceDefinition<unknown>[];
    onLoad?(cx: ErasedContext): void | Promise<void>;
    onActivate?(cx: ErasedContext): void | Promise<void>;
    onDeactivate?(cx: ErasedContext): void | Promise<void>;
    onUnload?(cx: ErasedContext): void | Promise<void>;
}

/** Narrowed as far as a module object can be before anything is constructed. */
function defaultConstructorOf(module: unknown): (new () => unknown) | undefined {
    if (typeof module !== 'object' || module === null) return undefined;
    const candidate: { default?: unknown } = module;
    if (typeof candidate.default !== 'function') return undefined;
    // A class is a function; so is a plain function. `new` on the latter still produces an object,
    // and whether the result is usable is settled by the instance checks below rather than here.
    return candidate.default as new () => unknown;
}

function isApplication(value: unknown): value is ErasedApplication {
    if (typeof value !== 'object' || value === null) return false;
    const candidate: { surfaces?: unknown } = value;
    return Array.isArray(candidate.surfaces);
}

function isExtension(value: unknown): value is ErasedExtension {
    if (typeof value !== 'object' || value === null) return false;
    const candidate: { activate?: unknown } = value;
    return typeof candidate.activate === 'function';
}

/**
 * Constructs the Extension a bundle default-exports.
 *
 * `activate` is genuinely verified: it is the one member an Extension must have, so a bundle that
 * exports the wrong class is caught here rather than at first invocation.
 */
export function constructExtension(module: unknown, source: string): ErasedExtension {
    const ctor = defaultConstructorOf(module);
    if (ctor === undefined) {
        throw new Error(
            `[mesh-web] the extension bundle at ${source} has no default export, or its default ` +
                `export is not constructable. An extension module must \`export default\` a class ` +
                `implementing Extension.`,
        );
    }
    const instance: unknown = new ctor();
    if (!isExtension(instance)) {
        throw new Error(
            `[mesh-web] the default export of the extension bundle at ${source} has no ` +
                `\`activate\` method, so it does not implement Extension.`,
        );
    }
    return instance;
}

/**
 * Constructs an Application from the class a bundle default-exports. Called once per window.
 *
 * Unlike an Extension there is no required member to check for — every field of `Application` is
 * optional, because an Application that declares only `surfaces` is a legitimate one. So this
 * verifies the export is constructable and produces an object, and stops there rather than
 * inventing a check it cannot actually make. An Application that does nothing renders nothing,
 * which is visible immediately and is not the kind of failure a guard needs to catch.
 */
export function constructApplication(module: unknown, source: string): ErasedApplication {
    const ctor = defaultConstructorOf(module);
    if (ctor === undefined) {
        throw new Error(
            `[mesh-web] the application bundle at ${source} has no default export, or its default ` +
                `export is not constructable. An application module must \`export default\` a ` +
                `class implementing Application.`,
        );
    }
    const instance: unknown = new ctor();
    if (!isApplication(instance)) {
        throw new Error(
            `[mesh-web] the default export of the application bundle at ${source} declares no ` +
                `\`surfaces\`, so it does not implement Application. An Application must say where ` +
                `it appears; something that contributes to other applications is an Extension.`,
        );
    }
    return instance;
}
