import type { CapabilityContext, CapabilityName, MenuItem, MenuTarget } from './capabilities.js';

/**
 * An Extension: a capability contributed to whatever is running.
 *
 * Auth. Logging. Telemetry. Source control. A language service. The workbench itself.
 *
 * An Extension has no route and no page surface — it cannot be navigated to. It activates once and
 * spans every Application, so a screen written in one Application and a screen written in another
 * consume the same session, the same command set, the same key bindings.
 *
 * The word matters here. "Extension" is right precisely because it extends the *framework*: what it
 * adds is available to every Application, including ones written later by someone else. An
 * Application is not an extension of anything — it is built on top. Calling both the same thing is
 * what made the previous generation's auth screens a peer of its console.
 *
 * The workbench — activity bar, docked panels, editor groups, tabs — is an Extension like any
 * other. It declares `windows` and arranges them. That is the test of whether this split is real:
 * if the IDE shell needs framework privileges the split is cosmetic, and if it does not, a
 * different arrangement is just a different Extension.
 */

// ─── Declarative contributions ───────────────────────────────────────────────

/**
 * A command an Extension provides, declared as data.
 *
 * No `run` here, deliberately. Declarative contributions are registered **without loading the
 * Extension's bundle**, so its commands appear in the palette, its menu items in the menu bar and
 * its keybindings in the keymap while none of its code has been fetched. Invoking one activates the
 * Extension and then dispatches.
 *
 * That is the one pattern from the previous generation worth carrying over intact: a console with
 * forty extensions should cost forty manifest entries at boot, not forty bundles. The
 * implementation is registered against these ids during `activate` via `cx.commands`.
 */
export interface CommandContribution {
    readonly id: string;
    readonly label: string;
    readonly category?: string;
    readonly description?: string;
    /** Default binding. A user keymap overrides it; a conflict is reported, not silently resolved. */
    readonly keybinding?: string;
}

export interface MenuContribution {
    readonly target: MenuTarget;
    readonly items: readonly MenuItem[];
}

/**
 * A view an Extension can place, declared as data.
 *
 * `slot` names where it wants to go. Whether that slot exists is the host's business: a view asking
 * for `sidebar.primary` under a host with no sidebar is simply not placed, and that is a normal
 * outcome rather than an error — the same refusal rule surfaces already follow.
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

// ─── The definition ──────────────────────────────────────────────────────────

/**
 * Declaration of an Extension.
 *
 * `TNeeds` is inferred from `needs` written `as const`, and types the activation context.
 * `TExports` is whatever `activate` returns — the providers other contributors consume.
 */
export interface ExtensionDefinition<
    TNeeds extends readonly CapabilityName[] = readonly [],
    TExports = void,
> {
    readonly id: string;
    readonly title: string;
    readonly version?: string;

    /**
     * Capabilities this Extension uses. `as const` narrows the activation context to exactly these;
     * anything else is a compile error, and a host that cannot supply one refuses to activate the
     * Extension by name rather than handing it a context with holes in it.
     */
    readonly needs?: TNeeds;

    /** Other Extensions this one depends on, by id. Activated first, or this one is refused. */
    readonly uses?: readonly string[];

    /**
     * What this Extension offers before it is loaded. Registered from the manifest; the bundle is
     * fetched when one of these is first invoked.
     */
    readonly contributes?: Contributions;

    /**
     * Called once, when the Extension is first needed.
     *
     * Whatever it returns becomes this Extension's exports, available to contributors that name it
     * in `uses`. Returning nothing is normal — an Extension that only registers commands has no
     * providers to offer.
     */
    activate(cx: CapabilityContext<TNeeds>): TExports | Promise<TExports>;

    /**
     * Called when the Extension is deactivated or the host shuts down.
     *
     * Optional, and usually unnecessary: anything registered through a capability returns a
     * disposer that the host tracks, and anything created through `cx.state` is bound to the
     * Extension's reactive scope. This is for the residue neither of those covers.
     */
    deactivate?(): void | Promise<void>;
}

/**
 * Map of extension id to the type it exports.
 *
 * Augment it from an Extension's own package so consumers get typed providers:
 *
 * ```ts
 * declare module '@flybyme/mesh-web' {
 *     interface ExtensionExports {
 *         'identity.auth': { session: ReadonlySignal<Session | null> };
 *     }
 * }
 * ```
 *
 * This is the same technique mesh already uses to type `ctx.call` from generated contracts, for the
 * same reason: the set of extensions is open, so the type has to be assembled by the packages that
 * define them rather than enumerated here.
 *
 * Until an Extension augments this, `uses` is checked as plain strings — an unaugmented id is not
 * an error, it is simply untyped. Saying so is better than pretending the ids are closed.
 */
/* Empty by design: every member arrives by declaration merging from an extension's own package. */
export interface ExtensionExports {}

// ─── Registry ────────────────────────────────────────────────────────────────

const extensionRegistry = new Map<string, ExtensionDefinition<readonly CapabilityName[], unknown>>();

/**
 * Registers an Extension.
 *
 * Self-registering on import, like `defineApplication` and `defineContract`. A duplicate id throws
 * here, naming both sides, rather than being resolved by load order — two bundles claiming one id
 * is a packaging mistake, and the moment it happens is the only useful moment to say so.
 */
export function defineExtension<
    const TNeeds extends readonly CapabilityName[] = readonly [],
    TExports = void,
>(definition: ExtensionDefinition<TNeeds, TExports>): ExtensionDefinition<TNeeds, TExports> {
    if (definition.id === '') {
        throw new Error('[mesh-web] an Extension definition needs a non-empty "id"');
    }
    const existing = extensionRegistry.get(definition.id);
    if (existing !== undefined) {
        throw new Error(
            `[mesh-web] two Extensions claim the id "${definition.id}" ` +
                `(registered: "${existing.title}", incoming: "${definition.title}")`,
        );
    }
    extensionRegistry.set(definition.id, definition);
    return definition;
}

export function getRegisteredExtension(
    id: string,
): ExtensionDefinition<readonly CapabilityName[], unknown> | undefined {
    return extensionRegistry.get(id);
}

export function getAllRegisteredExtensions(): readonly ExtensionDefinition<
    readonly CapabilityName[],
    unknown
>[] {
    return Array.from(extensionRegistry.values());
}

/** Clears the registry. For test fixtures, so state does not bleed between suites. */
export function clearExtensionRegistry(): void {
    extensionRegistry.clear();
}
