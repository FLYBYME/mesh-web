// The capabilities an App's context carries, and the shape of a session. The part model's authoring
// surface — Application, Extension, ViewDecl/ViewContext, Declarations, composites, CommandDecl,
// publishes/checkBindings, consumes/use — went with it (docs/app-model.md, phase 5c). An App is
// written with `App`, `Service`, `View`, `Component` and `command` (src/app/).
export type {
    CapabilityContext, CapabilityMap, CapabilityName, Chrome, ChromeWindow, CommandImpl, Commands,
    Confirmation, ConfirmOptions, ContributionBase, Credentials, Dom, Log, NotificationHandle,
    Notifications, RouterCapability, RouterApplication, State, SurfaceOptions, WindowHandle, Windows,
} from './capabilities.js';
export { needs } from './capabilities.js';

export type { Session } from './session.js';

export type { ProviderToken, ProviderTokens } from './provider.js';
export { provider } from './provider.js';
