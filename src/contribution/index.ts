/**
 * The contribution layer: what a bundle declares, and what it is handed in return.
 *
 * Two contracts over one runtime — an Application is a destination, an Extension is a capability —
 * and one rule connecting them: a contributor receives exactly the capabilities it declared, and
 * nothing else.
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
    ApplicationEndpoints,
    WindowPreferences,
    ApplicationDefinition,
} from './application.js';
export {
    defineApplication,
    getRegisteredApplication,
    getAllRegisteredApplications,
    clearApplicationRegistry,
} from './application.js';

export type {
    CommandContribution,
    MenuContribution,
    ViewContribution,
    Contributions,
    ExtensionDefinition,
    ExtensionExports,
} from './extension.js';
export {
    defineExtension,
    getRegisteredExtension,
    getAllRegisteredExtensions,
    clearExtensionRegistry,
} from './extension.js';
