// `@flybyme/mesh-web` -- the browser half of the mesh framework.
//
// Reactivity, DOM, router, manifest, the app host and compositor, and the contribution layer
// (Applications and Extensions). This was `@flybyme/mesh-api/runtime` until the three core parts of
// the framework were separated: mesh is the framework, mesh-api turns mesh constructs into
// interfaces (REST, SSE, MCP), and this is everything that runs in a tab.
//
// Nothing here may import a node builtin, express, or anything else that cannot run in a browser --
// and `tsconfig.json` sets `types: []` so that is a compile error rather than a rule to remember.

/// <reference path="./dom/css.d.ts" />

// Reactivity Core
export type {
    Signal,
    ReadonlySignal,
    Resource,
    ReactiveScope,
    EffectFn,
    CleanupFn,
    DisposeFn,
    ResourceMutator,
} from './reactivity/index.js';
export {
    signal,
    computed,
    effect,
    batch,
    untrack,
    flushSync,
    resource,
    createScope,
} from './reactivity/index.js';

// DOM & Components Runtime
export type {
    Child,
    DOMChild,
    PrimitiveChild,
    DynamicChild,
    Props,
    Component,
    EventHandler,
    StackProps,
    RowProps,
    TextProps,
    HeadingProps,
    ButtonProps,
    InputProps,
    CardProps,
    BadgeProps,
    BadgeVariant,
    SpinnerProps,
    EmptyStateProps,
    ErrorStateProps,
    FormProps,
    StringInputType,
    FormContractLike,
    TableProps,
    TableColumn,
    TableColumnProp,
} from './dom/index.js';
export {
    h,
    When,
    For,
    bindClass,
    bindStyle,
    bindAttr,
    bindText,
    attachScope,
    getScope,
    disposeElement,
    registerCleanup,
    setAttributeOrProperty,
    Stack,
    Row,
    Text,
    Heading,
    Button,
    Input,
    Card,
    Badge,
    Spinner,
    EmptyState,
    ErrorState,
    Form,
    Table,
} from './dom/index.js';

// App Runtime & Compositor
export type {
    SurfaceRole,
    SurfaceRefusalReason,
    SurfaceResult,
    SurfaceRequest,
    SurfaceDefinition,
    AppLifecycleState,
    AppStateContainer,
    AppContext,
    AppDefinition,
    LayoutRegionPolicy,
    LayoutPolicy,
    AppHostOptions,
    AppHost,
    LeakableResource,
} from './app/index.js';
export {
    defineApp,
    getRegisteredApp,
    getAllRegisteredApps,
    clearAppRegistry,
    createAppHost,
    AppHostImpl,
    Compositor,
    AppInstance,
    AppContextImpl,
    AppStateContainerImpl,
    MemoryStorage,
    AppLeakError,
    assertNoAppLeaks,
} from './app/index.js';

// Manifest & Layout Policy
export type {
    LoadStrategy,
    ManifestAuthLevel,
    SiteConfig,
    RegionLayoutConfig,
    TaskSwitcherConfig,
    LayoutConfig,
    SurfaceConfig,
    LocalAppConfig,
    RemoteAppConfig,
    RemoteSiteConfig,
    Manifest,
    ManifestOverlay,
    ParseManifestOptions,
    ParsedManifestResult,
} from './manifest/index.js';
export {
    surfaceRoleSchema,
    surfaceConfigSchema,
    loadStrategySchema,
    manifestAuthLevelSchema,
    siteConfigSchema,
    regionLayoutConfigSchema,
    taskSwitcherConfigSchema,
    layoutConfigSchema,
    localAppConfigSchema,
    remoteAppConfigSchema,
    remoteSiteConfigSchema,
    manifestSchema,
    manifestOverlaySchema,
    validateManifest,
    validateManifestOverlay,
    mergeManifests,
    manifestToLayoutPolicy,
    parseManifest,
    isAppAuthAllowed,
    loadEagerApps,
} from './manifest/index.js';

// Router & History Navigation
export type {
    RouteParams,
    ScopedRouter,
    ViewComponent,
    ViewDefinition,
    AppRouteDefinition,
    RouteResolution,
    RouterOptions,
    ScrollPosition,
} from './router/index.js';
export {
    normalizePath,
    matchRoutePattern,
    matchViewPattern,
    resolveHierarchy,
    shouldInterceptLinkClick,
    attachLinkInterceptor,
    ScrollManager,
    ScopedRouterImpl,
    mountViews,
    Router,
    createRouter,
} from './router/index.js';

// Live Event Stream Bridge
export type {
    EventBridgeState,
    EventBridgeClientOptions,
    EventBridgeClient,
} from './events/index.js';
export { createEventBridgeClient } from './events/index.js';

// The session shape the browser sees, shared structurally with the server half.
export type { SessionUser } from './session.js';
export { ADMIN_ROLE } from './session.js';

// Zod introspection, shared with mesh-api's exposure layer. See the note in src/schema.ts.
export type { UnwrappedSchema, FormFieldClassification } from './schema.js';
export {
    unwrapSchema,
    isFieldOptional,
    isInputEmptyOrAllOptional,
    getObjectShape,
    getEnumOptions,
    getZodTypeName,
    classifyFormField,
} from './schema.js';

// Contribution layer: Applications, Extensions, and the capabilities they declare.
export * from './contribution/index.js';

