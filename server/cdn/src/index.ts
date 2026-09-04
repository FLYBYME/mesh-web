/**
 * @flybyme/mesh-cdn — the `cdn` ServiceModule.
 *
 * spec/service-modules.md §2: binds a port behind the proxy, **small, stateless, many, everywhere**,
 * scaling with traffic. It owns `site` — the hostname → application mapping — and reads artifacts
 * through the builder's published contract, because a module owns what it writes.
 *
 * The organising idea, from spec/hosting.md §2: ten CDN nodes and ten APIs, both interchangeable,
 * neither with a node that is the home of anything, and both made interchangeable by the same thing
 * — they are nodes on one mesh. A node asked for a hostname it has never seen resolves it, fetches
 * what it needs, and serves. **A cold cache is slower, not wrong.**
 */

export * from './sites.js';
export * from './serve.js';
