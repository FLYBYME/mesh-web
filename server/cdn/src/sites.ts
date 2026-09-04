/**
 * Hostname → site → artifact — roadmap B5, B6, B7, spec/hosting.md §2.
 *
 * > A request arrives with a `Host` header. The node resolves, in order:
 * >   1. hostname → site
 * >   2. site → artifact
 * >   3. serve — from local cache, or fetch the artifact and then serve
 *
 * The first is a lookup against shared state, the second is content-addressed and therefore
 * cacheable forever, and the third is why **any node can answer**. A node with a cold cache is
 * slower and not wrong, which is the property that makes ten CDN nodes interchangeable.
 */

import type { Site } from '@flybyme/mesh-web-protocol';

/** Where the site records live. On the mesh in a real deployment; a Map in a test (B5). */
export interface SiteSource {
    resolve(hostname: string): Promise<Site | undefined>;
}

export interface SiteCacheOptions {
    readonly source: SiteSource;
    /**
     * The backstop, not the mechanism.
     *
     * `cdn.site_changed` invalidates an entry when a deploy happens, and this bounds how long a node
     * that missed that event serves the old artifact. **The mesh delivers events at-most-once**
     * (spec/auth.md §3.1), which was established for revocations and is just as true here — so this
     * number is doing real work rather than tidying up after the event.
     */
    readonly ttlMs?: number;
    readonly now?: () => number;
}

export interface SiteCache {
    resolve(hostname: string): Promise<Site | undefined>;
    /** A deploy happened. From the event, and from a poll where one exists. */
    invalidate(hostname: string): void;
    clear(): void;
    readonly size: number;
}

export const DEFAULT_SITE_TTL_MS = 30_000;

export function siteCache(options: SiteCacheOptions): SiteCache {
    const ttl = options.ttlMs ?? DEFAULT_SITE_TTL_MS;
    const now = options.now ?? Date.now;

    const entries = new Map<string, { site: Site | undefined; expiresAt: number }>();
    const inFlight = new Map<string, Promise<Site | undefined>>();

    return {
        async resolve(hostname) {
            const key = normalizeHostname(hostname);

            const hit = entries.get(key);
            if (hit !== undefined && hit.expiresAt > now()) return hit.site;

            const existing = inFlight.get(key);
            if (existing !== undefined) return existing;

            const pending = (async () => {
                try {
                    const site = await options.source.resolve(key);
                    // A miss is cached too. A node being asked repeatedly for a hostname nobody has
                    // configured is otherwise a lookup per request, which is a cheap way to make a
                    // CDN node do the mesh's work for an attacker.
                    entries.set(key, { site, expiresAt: now() + ttl });
                    return site;
                } finally {
                    inFlight.delete(key);
                }
            })();

            inFlight.set(key, pending);
            return pending;
        },

        invalidate(hostname) { entries.delete(normalizeHostname(hostname)); },
        clear() { entries.clear(); },
        get size() { return entries.size; },
    };
}

/**
 * The hostname a lookup is keyed by.
 *
 * Lowercased and stripped of its port, because `Example.com`, `example.com:443` and `example.com`
 * are one site — and because a cache keyed on the raw header would let the same site be looked up
 * three times, or worse, be *found* under one spelling and missed under another.
 */
export function normalizeHostname(host: string): string {
    const withoutPort = host.trim().toLowerCase().replace(/:\d+$/, '');
    // A trailing dot is a fully-qualified name and the same host.
    return withoutPort.endsWith('.') ? withoutPort.slice(0, -1) : withoutPort;
}

/**
 * Never serve two tenants from one hostname — roadmap B6, spec/hosting.md §3.
 *
 * **The origin is the isolation boundary.** Everything a browser isolates — storage, cookies,
 * `localStorage`, the whole same-origin policy — is scoped to the origin, so two tenants sharing a
 * hostname share all of it. That makes this a *serving-layer invariant* rather than a convention:
 * it is checked on the path that serves, not assumed by the path that configures.
 *
 * The check looks trivial, and that is the point. It exists so that a future change which makes
 * hostname resolution cleverer — a wildcard, a fallback, an alias table — cannot quietly produce a
 * site whose tenant is not the one that hostname belongs to without this failing.
 */
export class TenantMismatch extends Error {
    constructor(readonly hostname: string, readonly expected: string, readonly actual: string) {
        super(
            `${hostname} belongs to tenant ${expected} but resolved to a site owned by ${actual}. ` +
            `The origin is the isolation boundary, so this is refused rather than served.`,
        );
        this.name = 'TenantMismatch';
    }
}

export function assertTenant(hostname: string, site: Site, expectedTenant: string | undefined): void {
    if (expectedTenant === undefined) return;
    if (site.tenantId !== expectedTenant) {
        throw new TenantMismatch(normalizeHostname(hostname), expectedTenant, site.tenantId);
    }
}
