export type { Rect, ResizeEdge, Size, WindowState } from './geometry.js';
export {
    cascade, clampSize, constrainToViewport, DEFAULT_MIN, maximize, move, raise, resize,
} from './geometry.js';

export type { OpenOptions, WindowRecord } from './manager.js';
export { WindowManager } from './manager.js';

export type { ViewHostOptions, ViewInstance } from './host.js';
export { mountView } from './host.js';

export { windowSink } from './sink.js';
