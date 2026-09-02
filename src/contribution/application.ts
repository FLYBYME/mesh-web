import type { SurfaceDefinition } from '../app/types.js';
import type { CapabilityContext, CapabilityName } from './capabilities.js';

/**
 * An Application: a destination. The thing a person is *in*.
 *
 * The console, a blog, a landing page, the IDE, a trading desk. It owns routes and screens; several
 * are loaded at once and any number may have windows open.
 *
 * The distinction from an Extension is not a naming convention over one mechanism — the two declare
 * different things and have different lifetimes:
 *
 * | | Application | Extension |
 * |---|---|---|
 * | declares | routes, screens, windows | commands, menus, views, providers |
 * | owns | a destination | nothing on screen of its own |
 * | lifetime | loaded, switchable, closable | activated once, spans every Application |
 *
 * Applications still nest through the same compositor that hosts top-level ones — there is one
 * hosting mechanism, not a separate plugin concept underneath a separate app concept.
 */

/**
 * Where an Application's backend and bundles live.
 *
 * Declared per Application rather than assumed to be the page's own origin, because they are not:
 * the web server and the API are separate listeners on separate ports, so the browser talks to an
 * origin it was told about rather than the one it was served from.
 *
 * Two consequences worth stating, since both are load-bearing:
 *
 * - **Cross-origin is the normal case, not the exception.** The session cannot ride along on a
 *   same-origin cookie, so credentials are explicit. Anything assuming same-origin is assuming a
 *   deployment that will not exist.
 * - **These are usually filled in, not written.** Under paas an Application is told its API and
 *   asset URLs at deploy time; a hand-written value is the development case and the override.
 *
 * The same declaration is what makes loading an Application served by a different node work at all,
 * rather than being a special federation path bolted on later.
 */
export interface ApplicationEndpoints {
    /** Base URL of the API this Application calls. Becomes `cx.net.baseUrl`. */
    readonly api?: string;
    /** Base URL its bundles, styles and static assets are served from. */
    readonly assets?: string;
}

/**
 * How an Application wants to be presented, as a preference the host may decline.
 *
 * The host decides whether it is arranging floating windows or tiles; an Application says what it
 * would like and works either way. An Application that only functions in one mode is an Application
 * that cannot appear in the other host, which defeats the point of having two.
 */
export interface WindowPreferences {
    /** Preferred arrangement. `either` — the default — means it does not care. */
    readonly mode?: 'windowed' | 'tiled' | 'either';
    readonly initialSize?: { readonly width: number; readonly height: number };
    readonly minSize?: { readonly width: number; readonly height: number };
    readonly resizable?: boolean;
    /**
     * Whether a second window of this Application may be opened.
     *
     * Defaults to `true` — one instance. Set `false` for anything a person would reasonably want
     * two of side by side: a chart, an editor, a log viewer. This is a real product decision rather
     * than a technical one, which is why it is declared and not inferred.
     */
    readonly singleton?: boolean;
}

/**
 * Declaration of an Application.
 *
 * `TNeeds` is inferred from `needs` when it is written `as const`, which is what types the context
 * passed to every lifecycle hook.
 */
export interface ApplicationDefinition<
    TNeeds extends readonly CapabilityName[] = readonly [],
> {
    readonly id: string;
    readonly title: string;
    readonly version?: string;

    /**
     * Capabilities this Application uses. Write it `as const` so the context is narrowed to exactly
     * these — anything else is a compile error at the use site, and the host can refuse to load an
     * Application whose requirements it cannot meet before running any of its code.
     */
    readonly needs?: TNeeds;

    /** Extensions this Application depends on, by id. Refused at load if one is unavailable. */
    readonly uses?: readonly string[];

    readonly endpoints?: ApplicationEndpoints;
    readonly window?: WindowPreferences;

    /**
     * Screens. A surface says what kind of thing it is, never where it goes — placement is the
     * compositor's, and refusal is a normal outcome rather than an error.
     */
    readonly surfaces?: readonly SurfaceDefinition<unknown>[];

    onLoad?(cx: CapabilityContext<TNeeds>): void | Promise<void>;
    onActivate?(cx: CapabilityContext<TNeeds>): void | Promise<void>;
    onDeactivate?(cx: CapabilityContext<TNeeds>): void | Promise<void>;
    onUnload?(cx: CapabilityContext<TNeeds>): void | Promise<void>;
}

/**
 * Registry of declared Applications.
 *
 * Self-registration on import, mirroring how `defineContract` registers into mesh's contract
 * registry and `defineApp` into the app registry. Importing a bundle is what makes its Application
 * known; the host decides separately whether to load it.
 */
const applicationRegistry = new Map<string, ApplicationDefinition<readonly CapabilityName[]>>();

/**
 * Registers an Application.
 *
 * Ids are unique across the whole host, and a collision throws here — naming both sides — rather
 * than resolving silently by load order. Two bundles claiming one id is a packaging mistake, and
 * the only useful moment to report it is the moment it happens.
 */
export function defineApplication<const TNeeds extends readonly CapabilityName[] = readonly []>(
    definition: ApplicationDefinition<TNeeds>,
): ApplicationDefinition<TNeeds> {
    if (definition.id === '') {
        throw new Error('[mesh-web] an Application definition needs a non-empty "id"');
    }
    const existing = applicationRegistry.get(definition.id);
    if (existing !== undefined) {
        throw new Error(
            `[mesh-web] two Applications claim the id "${definition.id}" ` +
                `(registered: "${existing.title}", incoming: "${definition.title}")`,
        );
    }
    applicationRegistry.set(definition.id, definition);
    return definition;
}

export function getRegisteredApplication(
    id: string,
): ApplicationDefinition<readonly CapabilityName[]> | undefined {
    return applicationRegistry.get(id);
}

export function getAllRegisteredApplications(): readonly ApplicationDefinition<
    readonly CapabilityName[]
>[] {
    return Array.from(applicationRegistry.values());
}

/** Clears the registry. For test fixtures, so state does not bleed between suites. */
export function clearApplicationRegistry(): void {
    applicationRegistry.clear();
}
