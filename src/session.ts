/**
 * The session as the browser sees it.
 *
 * Two declarations, and both are deliberately duplicated rather than imported.
 *
 * `SessionUser` is the shape mesh already defines for `meta.user` (`IMeshMeta`), and mesh-api
 * declares it again in `src/auth/types.ts` for the same reason it is declared again here: the shape
 * is the contract between end-user identity and node identity, and a contract is only useful if
 * every side states it. Structural typing does the rest — a `SessionUser` from the server half is
 * assignable to this one and back, with no import crossing the browser/server line.
 *
 * `ADMIN_ROLE` exists because the manifest loader — browser code — has to decide whether an
 * `auth: 'admin'` app may load. In mesh-api it lives in a module that imports nothing at all, after
 * importing it from `auth/gate.ts` once pulled express and the entire server half into the browser
 * bundle:
 *
 *     ✘ Could not resolve "node:http"   node_modules/express/lib/application.js
 *     ✘ Could not resolve "crypto"      node_modules/cookie-signature/index.js
 *
 * Now that the browser framework is its own package that failure mode is structural rather than
 * something to remember: there is no server half here to import by accident.
 */

/** Exactly mesh's `meta.user` shape. */
export interface SessionUser {
    readonly id: string;
    readonly tenant_id: string;
    readonly roles?: readonly string[];
    readonly [key: string]: unknown;
}

/** Role that satisfies `auth: 'admin'`. One name, checked in one place. */
export const ADMIN_ROLE = 'admin';
