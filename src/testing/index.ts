/**
 * Testing surface for part repositories.
 *
 * `definePartBrowserConfig()` configures Vitest for a real browser. An App is mounted in a test with
 * `mountSite` (or `mountDesktop`) and a stand-in `granted` context — see the company site's
 * `test/site.browser.test.ts`. `mountPart`, which booted legacy parts through the kernel, went with
 * them (docs/app-model.md, phase 5c).
 */

export { getFrameworkInstances, assertSingleFramework } from '../instance.js';
export type { UserBrowserConfig } from './config.js';
export { definePartBrowserConfig } from './config.js';
