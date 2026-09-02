/**
 * The contribution layer: what a bundle exports, and what it is handed in return.
 *
 * An extension module default-exports an `Extension`; an application module default-exports an
 * `Application`. The host imports, constructs and drives them. No registry, no `define*`, no
 * side effect on import — see `contract.ts` for why copying the mesh contract pattern here was
 * wrong.
 */

export type {
    ContractRef,
    EventRef,
    CrudRef,
    Channel,
    Net,
    Events,
    CommandDefinition,
    Commands,
    Keys,
    MenuItem,
    MenuTarget,
    Menus,
    NotificationAction,
    NotificationOptions,
    NotificationHandle,
    Notifications,
    Collection,
    Models,
    WindowGeometry,
    WindowState,
    WindowMode,
    WindowHandle,
    WindowOpenOptions,
    Windows,
    ScopedStorage,
    Log,
    CapabilityMap,
    CapabilityName,
    ContributionBase,
    CapabilityContext,
} from './capabilities.js';

export type {
    CommandContribution,
    MenuContribution,
    ViewContribution,
    Contributions,
    Extension,
    Application,
    ApplicationEndpoints,
    WindowPreferences,
} from './contract.js';

export { constructExtension, constructApplication } from './contract.js';
