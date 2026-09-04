/**
 * The registry: the typed layer, where `unknown` stops.
 *
 * spec/storage-and-registry.md §4 and §5, and roadmap A4.2, A4.3, A4.6.
 *
 * Two properties do most of the work here, and both are about what a caller is *not* asked to do:
 *
 * **Nothing above this holds an `unknown`, and nothing supplies a type parameter.** A setting
 * declares its own `parse`, so the framework can actually check what comes back rather than casting
 * a stored value into the caller's hopes (spec/type-safety.md §2). `setting<T>()` infers `T` from
 * the parse function — there is no `get<Draft>('drafts/x')` to get wrong.
 *
 * **A read returns a signal, not a promise** (A4.3). A remote hive is a network round trip, and a
 * page that awaited one before first paint would blank on every reload. So `read()` answers
 * immediately with the best value it has — build policy, or the declared default — and updates in
 * place when the hives come back. Nothing waits, and nothing renders a spinner over a preference.
 */

import { signal } from '../reactivity/index.js';
import type { ReadonlySignal, Signal } from '../reactivity/types.js';
import { RESOLUTION_ORDER, type BuildPolicy, type HiveBindings, type HiveName, type Resolution } from './hives.js';
import { VersionConflict, type StorageProvider } from './provider.js';

/**
 * A setting: a path, a default, and the one function that turns a stored value into a `T`.
 *
 * `parse` returns `undefined` for anything it does not recognise, and the registry then falls back
 * to the default **loudly** rather than casting. That is the only defence against a value written by
 * an older version of the same Application, which is a case that will happen and cannot be
 * prevented.
 */
export interface Setting<T> {
    readonly path: string;
    /** Where `write` goes by default. Reads still walk the whole order. */
    readonly hive: HiveName;
    readonly fallback: T;
    readonly parse: (raw: unknown) => T | undefined;
    readonly description?: string;
}

export interface SettingOptions<T> {
    readonly path: string;
    readonly hive?: HiveName;
    readonly fallback: T;
    readonly parse: (raw: unknown) => T | undefined;
    readonly description?: string;
}

/** Declare a setting. `T` is inferred from `parse`; there is no type argument to supply. */
export const setting = <T>(options: SettingOptions<T>): Setting<T> => ({
    hive: 'user',
    ...options,
});

// ---------------------------------------------------------------------------- parsers

/**
 * The parsers a declaration will actually reach for.
 *
 * Here rather than left to each Application because "is this a string" written forty times is forty
 * chances to write it slightly differently, and because a wrong one fails by silently falling back
 * to the default — the quietest possible bug.
 */
export const asString = (raw: unknown): string | undefined =>
    typeof raw === 'string' ? raw : undefined;

export const asNumber = (raw: unknown): number | undefined =>
    typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;

export const asBoolean = (raw: unknown): boolean | undefined =>
    typeof raw === 'boolean' ? raw : undefined;

export const asOneOf = <const T extends readonly string[]>(values: T) =>
    (raw: unknown): T[number] | undefined =>
        (typeof raw === 'string' && (values as readonly string[]).includes(raw)) ? raw as T[number] : undefined;

/** An object, checked field by field. Returns `undefined` if any field is missing or wrong. */
export const asShape = <T>(
    fields: { readonly [K in keyof T]-?: (raw: unknown) => T[K] | undefined },
) => (raw: unknown): T | undefined => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;

    const record = raw as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const key of Object.keys(fields) as (keyof T & string)[]) {
        const value = fields[key](record[key]);
        if (value === undefined) return undefined;
        out[key] = value;
    }

    return out as T;
};

// ---------------------------------------------------------------------------- the registry

export interface RegistryOptions {
    readonly hives: HiveBindings;
    /** Values frozen into the build. Resolved first and unwritable — see hives.ts. */
    readonly policy?: BuildPolicy;
    /**
     * Namespace, so two Applications' settings cannot collide in one backing store.
     *
     * Supplied by the kernel per contributor, which is what makes `storage` *already namespaced*
     * rather than something an Application is trusted to prefix (spec/kernel.md §4).
     */
    readonly namespace: string;
    readonly onError?: (error: unknown, context: { readonly path: string; readonly hive: HiveName }) => void;
}

export interface Registry {
    /**
     * A live value. Answers immediately, updates when the hives resolve.
     *
     * The same signal for the same path: two views reading one setting share one subscription and
     * one read, and both see a write at the same time.
     */
    read<T>(decl: Setting<T>): ReadonlySignal<T>;

    /** Where the current value came from, and whether anything may change it. */
    resolution<T>(decl: Setting<T>): ReadonlySignal<Resolution<T>>;

    /**
     * Resolves once this setting has been read from the hives.
     *
     * `read` deliberately does not wait — a page must not blank on a network round trip (A4.3). But
     * some things genuinely must: the kernel restores window geometry at boot step 9, *before*
     * Applications start, precisely so a window comes back where it was rather than appearing at a
     * default position and jumping once the hive answers. That is the case this exists for.
     *
     * Also the honest way to wait in a test. Cells are created on first touch, so awaiting a timer
     * before ever calling `read` waits for something that has not started.
     */
    ready<T>(decl: Setting<T>): Promise<void>;

    /**
     * Write to the setting's own hive.
     *
     * Refuses when a higher-priority hive holds the value — writing under a policy that overrides
     * you is a write nobody will ever see, and silently accepting it is how a settings screen comes
     * to lie.
     */
    write<T>(decl: Setting<T>, value: T): Promise<void>;

    /** Remove this page's value, so the setting falls back to whatever is underneath. */
    clear<T>(decl: Setting<T>): Promise<void>;

    /** Re-read everything. For a hive that changed underneath — another tab, or a sync. */
    refresh(): Promise<void>;
}

export class SettingLocked extends Error {
    constructor(readonly path: string, readonly by: HiveName, reason?: string) {
        super(reason ?? `${path} is set by ${by} policy and cannot be changed here.`);
        this.name = 'SettingLocked';
    }
}

export function createRegistry(options: RegistryOptions): Registry {
    const { hives, namespace, policy } = options;
    const onError = options.onError ?? (() => {});

    interface Cell<T> {
        readonly decl: Setting<T>;
        readonly value: Signal<T>;
        readonly resolution: Signal<Resolution<T>>;
        /** The version this page last saw in the setting's own hive, for a conditional write. */
        version: string | undefined;
        /** The in-flight read, so `ready()` can await the one already running. */
        settling: Promise<void>;
    }

    const cells = new Map<string, Cell<unknown>>();

    /** Build policy first: a constant cannot be outvoted by a hive. */
    const fromPolicy = <T>(decl: Setting<T>): Resolution<T> | undefined => {
        if (policy === undefined || !(decl.path in policy)) return undefined;

        const parsed = decl.parse(policy[decl.path]);
        if (parsed === undefined) {
            onError(
                new Error(`Build policy for ${decl.path} does not match its declaration; ignoring it.`),
                { path: decl.path, hive: 'system' },
            );
            return undefined;
        }

        return {
            value: parsed,
            from: 'system',
            locked: true,
            reason: 'Frozen into this build.',
        };
    };

    const readHive = async <T>(decl: Setting<T>, hive: HiveName): Promise<{ value: T; version: string } | undefined> => {
        const provider: StorageProvider = hives[hive].provider;
        try {
            const stored = await provider.read(namespace, decl.path);
            if (stored === undefined) return undefined;

            const parsed = decl.parse(stored.value);
            if (parsed === undefined) {
                // Loudly, per §4: a value that fails its declaration falls back rather than being
                // cast into the caller's hopes. Written by an older version, most likely.
                onError(
                    new Error(`${decl.path} in ${hive} does not match its declaration; using the default.`),
                    { path: decl.path, hive },
                );
                return undefined;
            }

            return { value: parsed, version: stored.version };
        } catch (error) {
            onError(error, { path: decl.path, hive });
            return undefined;
        }
    };

    const resolve = async <T>(cell: Cell<T>): Promise<void> => {
        const locked = fromPolicy(cell.decl);
        if (locked !== undefined) {
            cell.resolution.set(locked);
            cell.value.set(locked.value);
            return;
        }

        for (const hive of RESOLUTION_ORDER) {
            const found = await readHive(cell.decl, hive);
            if (found === undefined) continue;

            if (hive === cell.decl.hive) cell.version = found.version;

            cell.resolution.set({
                value: found.value,
                from: hive,
                // A value from a hive earlier in the order than the one this setting writes to is
                // not editable from here — and the UI can say which hive is holding it.
                locked: RESOLUTION_ORDER.indexOf(hive) < RESOLUTION_ORDER.indexOf(cell.decl.hive)
                    || !hives[hive].writable,
                ...(hives[hive].writable ? {} : { reason: `Set by ${hive}, which this page may not write.` }),
            });
            cell.value.set(found.value);
            return;
        }

        cell.version = undefined;
        cell.resolution.set({ value: cell.decl.fallback, from: undefined, locked: false });
        cell.value.set(cell.decl.fallback);
    };

    const cellFor = <T>(decl: Setting<T>): Cell<T> => {
        const existing = cells.get(decl.path);
        if (existing !== undefined) return existing as unknown as Cell<T>;

        // Starts at build policy or the declared default, so the first read is synchronous and the
        // page paints. The hives land underneath it.
        const initial = fromPolicy(decl) ?? { value: decl.fallback, from: undefined, locked: false };

        const cell: Cell<T> = {
            decl,
            value: signal<T>(initial.value),
            resolution: signal<Resolution<T>>(initial),
            version: undefined,
            settling: Promise.resolve(),
        };

        cells.set(decl.path, cell as unknown as Cell<unknown>);
        cell.settling = resolve(cell);
        return cell;
    };

    return {
        read: (decl) => cellFor(decl).value,
        resolution: (decl) => cellFor(decl).resolution,
        ready: async (decl) => cellFor(decl).settling,

        async write(decl, value) {
            const cell = cellFor(decl);
            const current = cell.resolution();

            if (current.locked) {
                throw new SettingLocked(decl.path, current.from ?? 'system', current.reason);
            }

            const binding = hives[decl.hive];
            if (!binding.writable) {
                throw new SettingLocked(decl.path, decl.hive, `This page may not write to ${decl.hive}.`);
            }

            try {
                const stored = await binding.provider.write(namespace, decl.path, value, cell.version);
                cell.version = stored.version;
                cell.value.set(value);
                cell.resolution.set({ value, from: decl.hive, locked: false });
            } catch (error) {
                if (error instanceof VersionConflict) {
                    // Somebody else wrote first. Re-resolve rather than clobber, and let the caller
                    // see the conflict — a silent last-write-wins here is how a setting changed in
                    // another tab comes back from the dead.
                    await resolve(cell);
                }
                throw error;
            }
        },

        async clear(decl) {
            const cell = cellFor(decl);
            try {
                await hives[decl.hive].provider.delete(namespace, decl.path);
            } catch (error) {
                onError(error, { path: decl.path, hive: decl.hive });
            }
            cell.version = undefined;
            cell.settling = resolve(cell);
            await cell.settling;
        },

        async refresh() {
            await Promise.all([...cells.values()].map((cell) => {
                cell.settling = resolve(cell);
                return cell.settling;
            }));
        },
    };
}
