/**
 * Testing surface for part repositories.
 *
 * Provides `mountPart()` to boot a part in a real browser page,
 * and `definePartBrowserConfig()` to configure Vitest.
 */

export type { MountOptions, MountedSite } from './mount.js';
export { mountPart, cleanup } from './mount.js';
export { getFrameworkInstances, assertSingleFramework } from '../instance.js';
export type { UserBrowserConfig } from './config.js';
export { definePartBrowserConfig } from './config.js';
