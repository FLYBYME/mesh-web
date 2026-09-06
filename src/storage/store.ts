/**
 * Store declarations — spec/storage-and-registry.md §6 and roadmap A3.9.
 *
 * A store is declared like a setting, and for the same reason: the declaration carries the type.
 *
 * Zero type parameters at the call site: cx.storage.open(Drafts) gets its type from Drafts.
 * The compiler cannot check a caller-supplied type parameter (spec/type-safety.md §2).
 */

import type { HiveName } from '../registry/hives.js';

export interface SafeParseSuccess<T> {
    readonly success: true;
    readonly data: T;
}

export interface SafeParseError {
    readonly success: false;
    readonly error?: unknown;
}

export type SafeParseResult<T> = SafeParseSuccess<T> | SafeParseError;

export interface SchemaObject<T> {
    parse(raw: unknown): T;
    safeParse?(raw: unknown): SafeParseResult<T>;
}

export type StoreSchema<T> = SchemaObject<T> | ((raw: unknown) => T);

export interface StoreDecl {
    readonly name: string;
    readonly hive: HiveName;
    readonly description?: string;
}

export interface StoreOptions<T> {
    readonly name: string;
    readonly hive?: HiveName;
    readonly schema: StoreSchema<T>;
    readonly fallback?: T;
    readonly description?: string;
}

export interface Store<T> extends StoreDecl {
    readonly name: string;
    readonly hive: HiveName;
    readonly schema: StoreSchema<T>;
    readonly fallback?: T;
    readonly description?: string;
}

const STORE_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Declare a store.
 *
 * `T` is inferred from `schema`; there is no type argument to supply.
 * Store names are validated to prevent namespace injection or path traversal attacks.
 */
export function store<T>(options: StoreOptions<T>): Store<T> {
    const name = options.name.trim();
    if (!name || !STORE_NAME_PATTERN.test(name)) {
        throw new Error(
            `Invalid store name "${options.name}". Store names must contain only alphanumeric characters, ` +
            `dashes, and underscores.`,
        );
    }

    return {
        name,
        hive: options.hive ?? 'device',
        schema: options.schema,
        ...(options.fallback !== undefined ? { fallback: options.fallback } : {}),
        ...(options.description !== undefined ? { description: options.description } : {}),
    };
}
