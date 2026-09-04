/**
 * The local providers — roadmap A4.4.
 *
 * Two of them, and the difference between them is `durability` rather than API: `memory` for the
 * `session` hive, `localStorage` for `device`. Both implement the same interface as the remote one
 * (A4.5), which is what makes the binding of hive to provider a configuration line instead of a
 * rewrite.
 *
 * IndexedDB is not here yet. `localStorage` is synchronous under an async interface — which is
 * *correct* (§4: async throughout, or nothing is swappable) but caps a hive at a few megabytes and
 * blocks the main thread on a large write. Recorded rather than hidden; A4.4b.
 */

import type { DisposeFn } from '../reactivity/types.js';
import {
    keyOf, namespacePrefix, nextVersion, VersionConflict,
    type BatchWrite, type EntryStat, type ProviderCapabilities, type ProviderMetrics,
    type StorageProvider, type StoredValue, type Usage,
} from './provider.js';

interface Entry {
    readonly value: unknown;
    readonly version: string;
    readonly updatedAt: number;
}

const sizeOf = (value: unknown): number => {
    try {
        return JSON.stringify(value)?.length ?? 0;
    } catch {
        return 0;
    }
};

// ---------------------------------------------------------------------------- memory

/**
 * Everything in a Map. The `session` hive, and every test's default.
 *
 * Atomic batches come free here, which is worth noticing rather than assuming: it is true because
 * the whole store is one synchronous object, and it is *not* true of the others. A caller that
 * relied on it without checking `capabilities.atomicBatch` would work in tests and lose data in a
 * browser.
 */
export function memoryProvider(id = 'memory'): StorageProvider {
    const store = new Map<string, Entry>();
    const watchers = new Set<{ namespace: string; prefix: string; onChange: (path: string) => void }>();
    let reads = 0, writes = 0, failures = 0;

    const notify = (namespace: string, path: string): void => {
        for (const w of watchers) {
            if (w.namespace === namespace && path.startsWith(w.prefix)) w.onChange(path);
        }
    };

    const put = (namespace: string, path: string, value: unknown, expect?: string): StoredValue => {
        const key = keyOf(namespace, path);
        const existing = store.get(key);

        if (expect !== undefined && existing?.version !== expect) {
            failures += 1;
            throw new VersionConflict(path, expect, existing);
        }

        const entry: Entry = { value, version: nextVersion(), updatedAt: Date.now() };
        store.set(key, entry);
        writes += 1;
        return entry;
    };

    return {
        id,
        capabilities: {
            durability: 'session',
            atomicBatch: true,
            watch: false,      // only this page writes here, so there is nothing to hear about
            conditionalWrite: true,
        },

        async read(namespace, path) {
            reads += 1;
            return store.get(keyOf(namespace, path));
        },

        async write(namespace, path, value, expect) {
            const entry = put(namespace, path, value, expect);
            notify(namespace, path);
            return entry;
        },

        async delete(namespace, path) {
            store.delete(keyOf(namespace, path));
            notify(namespace, path);
        },

        async stat(namespace, path) {
            const entry = store.get(keyOf(namespace, path));
            return entry === undefined
                ? undefined
                : { path, version: entry.version, updatedAt: entry.updatedAt, size: sizeOf(entry.value) };
        },

        async list(namespace, prefix) {
            const out: EntryStat[] = [];
            const head = namespacePrefix(namespace);
            for (const [key, entry] of store) {
                if (!key.startsWith(head)) continue;
                const path = key.slice(head.length);
                if (!path.startsWith(prefix)) continue;
                out.push({ path, version: entry.version, updatedAt: entry.updatedAt, size: sizeOf(entry.value) });
            }
            return out;
        },

        async batch(namespace, writes_) {
            // Atomic: every write is checked before any is applied, so a conflict on the last one
            // leaves the first untouched.
            for (const w of writes_) {
                const existing = store.get(keyOf(namespace, w.path));
                if (w.expect !== undefined && existing?.version !== w.expect) {
                    failures += 1;
                    throw new VersionConflict(w.path, w.expect, existing);
                }
            }
            for (const w of writes_) put(namespace, w.path, w.value);
            for (const w of writes_) notify(namespace, w.path);
        },

        watch(namespace, prefix, onChange): DisposeFn {
            const watcher = { namespace, prefix, onChange };
            watchers.add(watcher);
            return () => void watchers.delete(watcher);
        },

        async usage(namespace) {
            let entries = 0, bytes = 0;
            const head = namespace === undefined ? undefined : namespacePrefix(namespace);
            for (const [key, entry] of store) {
                if (head !== undefined && !key.startsWith(head)) continue;
                entries += 1;
                bytes += sizeOf(entry.value);
            }
            return { entries, bytes };
        },

        metrics: () => ({ reads, writes, failures }),
    };
}

// ---------------------------------------------------------------------------- localStorage

/** What this provider needs. Narrow, so a test can supply one without a DOM. */
export interface KeyValueStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
    key(index: number): string | null;
    readonly length: number;
}

export const LOCAL_PREFIX = 'mesh-web:';

/**
 * `localStorage`, for the `device` hive.
 *
 * Three things are deliberate and each was a bug somewhere before:
 *
 * - **Every access is wrapped.** `localStorage` throws on access in a private window with site data
 *   blocked, and throws `QuotaExceededError` on write when full. A registry that takes the page
 *   down because a preference could not be saved has the priority backwards.
 * - **The value and its version are stored together**, as one JSON envelope. Two keys would let a
 *   value and its version be written by different tabs and disagree.
 * - **`watch` is real here**, because `localStorage` fires `storage` events for *other* tabs. Two
 *   tabs of the same site share this hive, and a device setting changed in one should reach the
 *   other.
 */
export function localProvider(
    store: KeyValueStore | undefined = safeLocalStorage(),
    options: { readonly id?: string; readonly onError?: (error: unknown) => void } = {},
): StorageProvider {
    const id = options.id ?? 'local';
    const onError = options.onError ?? (() => {});
    let reads = 0, writes = 0, failures = 0;

    // Present when localStorage is unusable. Everything still works; nothing survives a reload,
    // which is a better failure than a page that will not start.
    const fallback = store === undefined ? new Map<string, string>() : undefined;

    const get = (key: string): string | null => {
        if (fallback !== undefined) return fallback.get(key) ?? null;
        try {
            return store!.getItem(key);
        } catch (error) {
            failures += 1;
            onError(error);
            return null;
        }
    };

    const set = (key: string, value: string): void => {
        if (fallback !== undefined) { fallback.set(key, value); return; }
        try {
            store!.setItem(key, value);
        } catch (error) {
            failures += 1;
            onError(error);   // full, or blocked. The caller's write is lost and it is told nothing.
        }
    };

    const remove = (key: string): void => {
        if (fallback !== undefined) { fallback.delete(key); return; }
        try {
            store!.removeItem(key);
        } catch (error) {
            failures += 1;
            onError(error);
        }
    };

    const keys = (): string[] => {
        if (fallback !== undefined) return [...fallback.keys()];
        const out: string[] = [];
        try {
            for (let i = 0; i < store!.length; i++) {
                const key = store!.key(i);
                if (key !== null) out.push(key);
            }
        } catch (error) {
            failures += 1;
            onError(error);
        }
        return out;
    };

    const storageKey = (namespace: string, path: string): string => `${LOCAL_PREFIX}${keyOf(namespace, path)}`;

    const readEntry = (namespace: string, path: string): Entry | undefined => {
        const raw = get(storageKey(namespace, path));
        if (raw === null) return undefined;
        try {
            const parsed = JSON.parse(raw) as Entry;
            // Written by an older version, or by something else entirely. Treated as absent rather
            // than trusted — the alternative is handing the layer above a shape it will not check.
            return typeof parsed === 'object' && parsed !== null && typeof parsed.version === 'string'
                ? parsed
                : undefined;
        } catch {
            return undefined;
        }
    };

    return {
        id,
        capabilities: {
            durability: 'device',
            atomicBatch: false,   // one key at a time; a caller that needs atomicity must ask
            watch: fallback === undefined,
            conditionalWrite: true,
            quotaBytes: 5 * 1024 * 1024,
        },

        async read(namespace, path) {
            reads += 1;
            return readEntry(namespace, path);
        },

        async write(namespace, path, value, expect) {
            const existing = readEntry(namespace, path);
            if (expect !== undefined && existing?.version !== expect) {
                failures += 1;
                throw new VersionConflict(path, expect, existing);
            }

            const entry: Entry = { value, version: nextVersion(), updatedAt: Date.now() };
            set(storageKey(namespace, path), JSON.stringify(entry));
            writes += 1;
            return entry;
        },

        async delete(namespace, path) {
            remove(storageKey(namespace, path));
        },

        async stat(namespace, path) {
            const entry = readEntry(namespace, path);
            return entry === undefined
                ? undefined
                : { path, version: entry.version, updatedAt: entry.updatedAt, size: sizeOf(entry.value) };
        },

        async list(namespace, prefix) {
            const head = `${LOCAL_PREFIX}${namespacePrefix(namespace)}`;
            const out: EntryStat[] = [];

            for (const key of keys()) {
                if (!key.startsWith(head)) continue;
                const path = key.slice(head.length);
                if (!path.startsWith(prefix)) continue;
                const entry = readEntry(namespace, path);
                if (entry !== undefined) {
                    out.push({ path, version: entry.version, updatedAt: entry.updatedAt, size: sizeOf(entry.value) });
                }
            }
            return out;
        },

        watch(namespace, prefix, onChange): DisposeFn {
            if (fallback !== undefined || typeof window === 'undefined') return () => {};

            const head = `${LOCAL_PREFIX}${namespacePrefix(namespace)}`;
            const listener = (event: StorageEvent): void => {
                if (event.key === null || !event.key.startsWith(head)) return;
                const path = event.key.slice(head.length);
                if (path.startsWith(prefix)) onChange(path);
            };

            // Fires for *other* tabs only, which is exactly the case worth hearing about.
            window.addEventListener('storage', listener);
            return () => void window.removeEventListener('storage', listener);
        },

        async usage(namespace) {
            const head = namespace === undefined ? LOCAL_PREFIX : `${LOCAL_PREFIX}${namespacePrefix(namespace)}`;
            let entries = 0, bytes = 0;
            for (const key of keys()) {
                if (!key.startsWith(head)) continue;
                entries += 1;
                bytes += (get(key) ?? '').length;
            }
            return { entries, bytes, quotaBytes: 5 * 1024 * 1024 };
        },

        metrics: () => ({ reads, writes, failures }),
    };
}

/**
 * `localStorage`, if this browser will give it to us.
 *
 * Reading the property throws in a private window with site data blocked — not on use, on *access*
 * — so this cannot be a plain reference.
 */
export function safeLocalStorage(): KeyValueStore | undefined {
    try {
        if (typeof localStorage === 'undefined') return undefined;
        const probe = `${LOCAL_PREFIX}probe`;
        localStorage.setItem(probe, '1');
        localStorage.removeItem(probe);
        return localStorage;
    } catch {
        return undefined;
    }
}

/**
 * A device provider in a browser that will not store anything.
 *
 * The private-window case, made reachable so it can be tested: reads return nothing, writes are
 * accepted and lost, and the page works. `localProvider(undefined)` is the same thing said less
 * clearly at a call site.
 */
export const unavailableProvider = (): StorageProvider =>
    localProvider(undefined, { id: 'unavailable' });
