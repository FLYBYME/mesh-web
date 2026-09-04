export type {
    BatchWrite, EntryStat, ProviderCapabilities, ProviderMetrics, StorageProvider, StoredValue, Usage,
} from './provider.js';
export { KEY_SEPARATOR, VersionConflict, keyOf, namespacePrefix, nextVersion } from './provider.js';

export type { BuildPolicy, HiveBinding, HiveBindings, HiveName, Resolution } from './hives.js';
export { RESOLUTION_ORDER } from './hives.js';

export type { KeyValueStore } from './providers.js';
export { LOCAL_PREFIX, localProvider, memoryProvider, safeLocalStorage, unavailableProvider } from './providers.js';

export type { Registry, RegistryOptions, Setting, SettingOptions } from './registry.js';
export {
    SettingLocked, asBoolean, asNumber, asOneOf, asShape, asString, setting,
    createRegistry as createSettingsRegistry,
} from './registry.js';
