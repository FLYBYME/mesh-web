/**
 * The storage capability implementation — spec/storage-and-registry.md §6 and roadmap A3.9.
 *
 * Scoped to the contributor, bound to a hive, zero type parameters at the call site.
 * Reads return signals, writes are validated against schema, malformed data falls back loudly.
 */

import { signal } from '../reactivity/index.js';
import type { ReadonlySignal, Signal } from '../reactivity/types.js';
import type { HiveBinding, HiveBindings } from '../registry/hives.js';
import { KEY_SEPARATOR, type EntryStat, type StorageProvider } from '../registry/provider.js';
import { type Store, type StoreSchema } from './store.js';

export interface BoundStore<T> {
    /**
     * Read a stored value. Returns immediately with fallback/undefined; updates in place
     * when the provider answers. No type parameter — T comes from the store declaration.
     */
    get(key: string): ReadonlySignal<T | undefined>;

    /**
     * Write to the store's hive. Validated against the schema; throws if invalid.
     */
    set(key: string, value: T): Promise<void>;

    /**
     * Delete an entry from the store.
     */
    remove(key: string): Promise<void>;

    /**
     * List all entry stats in this store.
     * Returns a reactive signal of stats that updates when entries are added or removed.
     */
    list(): ReadonlySignal<readonly EntryStat[]>;

    /**
     * Resolves once the read for key (or all touched entries and list) has settled from the backing provider.
     */
    ready(key?: string): Promise<void>;

    /**
     * Read metadata for an entry without loading its full content.
     */
    stat(key: string): Promise<EntryStat | undefined>;
}

export interface Storage {
    open<T>(store: Store<T>): BoundStore<T>;
}

export interface StorageOptions {
    readonly namespace: string;
    readonly hives: HiveBindings;
    readonly onLogWarn?: (message: string, data?: unknown) => void;
    readonly onDispose?: (cleanup: () => void) => void;
}

export function validateValue<T>(schema: StoreSchema<T>, raw: unknown): T {
    if (typeof schema === 'function') {
        return schema(raw);
    }
    if (schema.safeParse !== undefined) {
        const result = schema.safeParse(raw);
        if (result.success) {
            return result.data;
        }
        throw result.error instanceof Error
            ? result.error
            : new Error(String(result.error ?? 'Validation failed'));
    }
    return schema.parse(raw);
}

function validateKey(key: string): void {
    if (typeof key !== 'string' || key.length === 0) {
        throw new Error('Key must be a non-empty string.');
    }
    if (key.includes(KEY_SEPARATOR)) {
        throw new Error('Key must not contain null characters.');
    }
}

interface Cell<T> {
    readonly value: Signal<T | undefined>;
    version: string | undefined;
    settling: Promise<void>;
}

function createBoundStore<T>(
    decl: Store<T>,
    namespace: string,
    binding: HiveBinding,
    onLogWarn: (message: string, data?: unknown) => void,
    cleanups: (() => void)[],
): BoundStore<T> {
    const provider: StorageProvider = binding.provider;
    const cells = new Map<string, Cell<T>>();
    const prefix = `${decl.name}/`;

    let listSignal: Signal<readonly EntryStat[]> | undefined;
    let listSettling: Promise<void> = Promise.resolve();

    const resolveCell = async (cell: Cell<T>, key: string): Promise<void> => {
        try {
            const stored = await provider.read(namespace, `${decl.name}/${key}`);
            if (stored === undefined) {
                cell.version = undefined;
                cell.value.set(decl.fallback);
                return;
            }

            let parsed: T | undefined;
            try {
                parsed = validateValue(decl.schema, stored.value);
            } catch (error) {
                // Version skew or malformed data: falls back loudly with a warning
                onLogWarn(
                    `Store "${decl.name}" entry "${key}" in hive "${decl.hive}" failed schema validation; using fallback.`,
                    error,
                );
                parsed = decl.fallback;
            }

            cell.version = stored.version;
            cell.value.set(parsed);
        } catch (error) {
            onLogWarn(`Failed to read "${key}" from store "${decl.name}" in hive "${decl.hive}".`, error);
            cell.version = undefined;
            cell.value.set(decl.fallback);
        }
    };

    const fetchList = async (): Promise<void> => {
        try {
            const stats = await provider.list(namespace, prefix);
            const entries: EntryStat[] = [];
            for (const stat of stats) {
                if (stat.path.startsWith(prefix)) {
                    entries.push({
                        path: stat.path.slice(prefix.length),
                        version: stat.version,
                        updatedAt: stat.updatedAt,
                        size: stat.size,
                    });
                }
            }
            if (listSignal !== undefined) {
                listSignal.set(entries);
            }
        } catch (error) {
            onLogWarn(`Failed to list store "${decl.name}" in hive "${decl.hive}".`, error);
        }
    };

    const refreshList = (): void => {
        if (listSignal !== undefined) {
            listSettling = fetchList();
        }
    };

    if (provider.watch !== undefined) {
        const unwatch = provider.watch(namespace, prefix, (changedPath) => {
            if (changedPath.startsWith(prefix)) {
                const key = changedPath.slice(prefix.length);
                const cell = cells.get(key);
                if (cell !== undefined) {
                    cell.settling = resolveCell(cell, key);
                }
                refreshList();
            }
        });
        cleanups.push(unwatch);
    }

    const boundStore: BoundStore<T> = {
        get(key: string): ReadonlySignal<T | undefined> {
            validateKey(key);
            let cell = cells.get(key);
            if (cell === undefined) {
                const value = signal<T | undefined>(decl.fallback);
                cell = {
                    value,
                    version: undefined,
                    settling: Promise.resolve(),
                };
                cells.set(key, cell);
                cell.settling = resolveCell(cell, key);
            }
            return cell.value;
        },

        async set(key: string, value: T): Promise<void> {
            validateKey(key);
            const valid = validateValue(decl.schema, value);

            if (!binding.writable) {
                throw new Error(`Hive "${decl.hive}" is read-only and cannot be written to.`);
            }

            let cell = cells.get(key);
            const path = `${decl.name}/${key}`;
            const stored = await provider.write(namespace, path, valid, cell?.version);

            if (cell === undefined) {
                const sig = signal<T | undefined>(valid);
                cell = {
                    value: sig,
                    version: stored.version,
                    settling: Promise.resolve(),
                };
                cells.set(key, cell);
            } else {
                cell.version = stored.version;
                cell.value.set(valid);
            }

            refreshList();
        },

        async remove(key: string): Promise<void> {
            validateKey(key);
            if (!binding.writable) {
                throw new Error(`Hive "${decl.hive}" is read-only and cannot be written to.`);
            }

            const path = `${decl.name}/${key}`;
            await provider.delete(namespace, path);

            const cell = cells.get(key);
            if (cell !== undefined) {
                cell.version = undefined;
                cell.value.set(decl.fallback);
            }

            refreshList();
        },

        list(): ReadonlySignal<readonly EntryStat[]> {
            if (listSignal === undefined) {
                const sig = signal<readonly EntryStat[]>([]);
                listSignal = sig;
                listSettling = fetchList();
            }
            return listSignal;
        },

        async ready(key?: string): Promise<void> {
            if (key !== undefined) {
                validateKey(key);
                let cell = cells.get(key);
                if (cell === undefined) {
                    boundStore.get(key);
                    cell = cells.get(key);
                }
                if (cell !== undefined) {
                    await cell.settling;
                }
                return;
            }

            const pending: Promise<void>[] = [];
            for (const cell of cells.values()) {
                pending.push(cell.settling);
            }
            if (listSignal !== undefined) {
                pending.push(listSettling);
            }
            await Promise.all(pending);
        },

        async stat(key: string): Promise<EntryStat | undefined> {
            validateKey(key);
            const s = await provider.stat(namespace, `${decl.name}/${key}`);
            if (s === undefined) return undefined;
            return {
                path: key,
                version: s.version,
                updatedAt: s.updatedAt,
                size: s.size,
            };
        },
    };

    return boundStore;
}

export function createStorage(options: StorageOptions): Storage {
    const { namespace, hives } = options;
    const onLogWarn = options.onLogWarn ?? (() => {});
    const cleanups: (() => void)[] = [];

    if (options.onDispose !== undefined) {
        options.onDispose(() => {
            for (const fn of cleanups.splice(0)) {
                try {
                    fn();
                } catch {
                    // Ignore error on teardown
                }
            }
        });
    }

    return {
        open<T>(store: Store<T>): BoundStore<T> {
            const binding = hives[store.hive];
            if (binding === undefined) {
                throw new Error(`Unknown hive "${store.hive}".`);
            }
            return createBoundStore(
                store,
                namespace,
                binding,
                onLogWarn,
                cleanups,
            );
        },
    };
}
