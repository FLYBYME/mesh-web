/**
 * @flybyme/mesh-web — the browser half of the mesh framework.
 *
 * Two rules hold everywhere in this package, and both are enforced rather than asked for:
 *
 * 1. Nothing here may import a node builtin. `tsconfig.json` sets `types: []` so it is a compile
 *    error, and CI checks it again.
 * 2. The browser never joins the mesh. It speaks HTTP to a node's API. Running a MeshApp over a
 *    WebSocket transport in a tab would make every browser a peer on the cluster network.
 *
 * See spec/status.md for what exists and spec/roadmap.md for what is next.
 */

export * from './reactivity/index.js';
export * from './description/index.js';
export * from './render/index.js';
export * from './contribution/index.js';
export * from './net/index.js';
export * from './kernel/index.js';
export * from './window/index.js';
export * from './input/index.js';
export * from './registry/index.js';
export * from './storage/index.js';
/**
 * **Auth is not here any more, and was never the kernel's to ship.**
 *
 * `src/auth/` held the one Extension in this package — 296 lines of implementation exported from
 * the root barrel, so `AUTH`, `AuthExtension` and `Session` sat beside `element`, `needs` and
 * `provider` in the framework's public API. Its own file said why that was wrong: *"a site decides
 * whether it has accounts at all, and a blog that never signs anyone in should not be carrying a
 * session."* A part a site decides about is a part, and parts live in mesh-core.
 *
 * The kernel keeps the **seam** — `needs('credentials')`, and `credentials.attach(headers, session)`
 * setting `services.session`. That is the framework's half: it defines the shape of the hole. What
 * fills it is somebody's choice, and there can be more than one filling.
 *
 * The last thing standing in the way was in `kernel.ts`, which matched `provides.id === AUTH.id` to
 * publish the session — a second, hard-coded path to a field the declared seam already sets. It is
 * gone, and 463 tests did not notice, which is what redundant means.
 */
export * from './models/index.js';
export * from './instance.js';
export * from './testing/index.js';

import './kernel.css';
