export type {
    BrokerHandle, ContextIdentity, KernelServices, LogRecord, NotificationRecord, WindowSink,
} from './broker.js';
export { createContext, createServices, defaultHives, recordingWindows } from './broker.js';
export type { LogBuffer, LogViewer } from './logs.js';
export { DEFAULT_LOG_CAPACITY, KERNEL_SOURCE, createLogBuffer, mountLogViewer } from './logs.js';

// The part machinery — `Kernel`, the manifest, the dependency graph — went with the part model
// (docs/app-model.md, phase 5c). What boots now is an App, through `start`.
export type { Composition, PartRef, Started } from './start.js';
export { isAppClass, start } from './start.js';
