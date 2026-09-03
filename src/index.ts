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
