/**
 * @flybyme/mesh-builder — the `builder` ServiceModule.
 *
 * spec/service-modules.md §2: **binds nothing.** Triggered by mesh calls and events, large and few,
 * scaling with pushes rather than with traffic. Running one inside every CDN node would put a
 * build's memory and CPU next to page serving, which is exactly the coupling §3 split them to avoid.
 *
 * It owns `build` and `artifact`, and publishes `artifact_get` for the CDN and the API to read
 * through — decided 2026-09-03: **a module owns what it writes and publishes contracts for what
 * others need.** The CDN caches by content hash, so the hop is paid once per artifact per node
 * rather than once per request.
 */

export * from './content.js';
export * from './store.js';
export * from './builder.js';
export * from './descriptor.js';
export * from './contracts.js';
export * from './module.js';
