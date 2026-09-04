/**
 * Hives: the same setting meaning different things at different scopes.
 *
 * spec/storage-and-registry.md §2. NT's real contribution was never the key/value store — it is
 * that **the scope is part of the address**, and that reading walks the scopes in an order somebody
 * decided rather than each caller inventing one.
 *
 * | hive | scope | follows | default provider |
 * | --- | --- | --- | --- |
 * | `system` | the deployment | everyone | remote, read-only to non-administrators |
 * | `user` | the person | across devices | remote |
 * | `device` | this browser | nothing | local |
 * | `session` | this tab | nothing | memory |
 *
 * `device` earns its place on one example: window geometry is per-*screen*, not per-person. A layout
 * that follows you from a 32-inch monitor to a laptop and puts a window off-screen is wrong, and
 * having the hive means that is a choice rather than an accident.
 */

import type { StorageProvider } from './provider.js';

export type HiveName = 'system' | 'user' | 'device' | 'session';

/**
 * The order a read walks. First hive with a value wins.
 *
 * `session` is not in it, and that is deliberate rather than an omission: a tab-scoped value is
 * asked for by name when something wants it, not silently preferred over a user's saved choice.
 * A draft in `session` must not shadow a setting in `user`.
 */
export const RESOLUTION_ORDER: readonly HiveName[] = ['system', 'user', 'device'];

export interface HiveBinding {
    readonly provider: StorageProvider;
    /**
     * Whether this page may write here.
     *
     * `system` is read-only in a browser and that is a fact about the medium, not a policy choice:
     * spec §2 — *"in a browser there is no machine administrator distinct from the person at the
     * keyboard"*, so a `system` hive administered from the page is incoherent. Policy arrives from
     * the build or from the server.
     */
    readonly writable: boolean;
}

export type HiveBindings = Readonly<Record<HiveName, HiveBinding>>;

/**
 * Where a resolved value came from, and whether it can be changed.
 *
 * The `locked` half is what makes a settings screen honest. A value written as `system` policy is
 * not a default a user can override — it wins, and the UI can say *why* it is greyed out, which is
 * the thing every settings screen gets wrong.
 */
export interface Resolution<T> {
    readonly value: T;
    /** The hive it came from, or `undefined` when nothing had it and the default was used. */
    readonly from: HiveName | undefined;
    readonly locked: boolean;
    readonly reason?: string;
}

/**
 * Policy frozen into the build.
 *
 * spec §2: *"a feature that is absent is a stronger guarantee than a feature that is disabled"*. A
 * build constant is not a setting — there is no provider, no write path and nothing to change at run
 * time — so it is resolved before any hive is consulted and it cannot be outvoted by one.
 *
 * **A locked blog is `system` policy on `window-manager/mode`.** No separate locking mechanism and no
 * special case in the window manager: the window manager reads a setting, and the setting happens to
 * be one nobody can change.
 */
export type BuildPolicy = Readonly<Record<string, unknown>>;
