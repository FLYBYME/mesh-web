/**
 * The provider: the backing store, and the swappable part.
 *
 * spec/storage-and-registry.md §4. Hives are **bound** to providers by configuration, so "local or
 * remote" is a deployment decision rather than a code change — a single-user install can bind
 * `user` to a local provider and never talk to a server, and a kiosk can bind `device` to a remote
 * one so a replaced machine keeps its layout.
 *
 * **Async throughout, including locally.** A synchronous local interface and an asynchronous remote
 * one are not swappable: every caller would have to know which it had, which defeats the whole
 * point of there being an interface.
 *
 * ## `unknown` stops here — decided
 *
 * `write(..., value: unknown)` and `StoredValue.value: unknown` are correct at this layer and wrong
 * one layer up. A provider stores opaque values; it does not know what a draft is, must not parse
 * one, and a provider that type-checked its contents could not be swapped for one that stores bytes
 * in IndexedDB. `unknown` here is honest — it says *this layer does not know*.
 *
 * > **This is the only place in the storage system where a value is `unknown`. Nothing above it
 * > accepts or returns one.**
 *
 * The typed layer sits directly on top and takes its types from declarations, so no caller ever
 * holds an `unknown` and no caller supplies a type parameter the framework cannot check
 * (spec/type-safety.md §2).
 */

import type { DisposeFn } from '../reactivity/types.js';

/**
 * What a provider promises.
 *
 * `durability` is the one a caller actually branches on: a setting worth a round trip belongs
 * somewhere `replicated`, and a draft that must not outlive the tab belongs somewhere `session`.
 */
export interface ProviderCapabilities {
    readonly durability: 'session' | 'device' | 'replicated';
    /** Whether `batch` is atomic. Absent means writes are applied one at a time, in order. */
    readonly atomicBatch: boolean;
    /** Whether `watch` reports changes made by anything other than this page. */
    readonly watch: boolean;
    /** Conditional writes via `expect`. Without it, last write wins and the caller must know. */
    readonly conditionalWrite: boolean;
    /** Bytes, where the provider can say. `undefined` means it has no idea, not that it is free. */
    readonly quotaBytes?: number;
}

export interface StoredValue {
    readonly value: unknown;
    /** Changes on every write. The token for a conditional write. */
    readonly version: string;
    readonly updatedAt: number;
}

export interface EntryStat {
    readonly path: string;
    readonly version: string;
    readonly updatedAt: number;
    readonly size: number;
}

export interface BatchWrite {
    readonly path: string;
    readonly value: unknown;
    readonly expect?: string;
}

export interface Usage {
    readonly entries: number;
    readonly bytes: number;
    readonly quotaBytes?: number;
}

export interface ProviderMetrics {
    readonly reads: number;
    readonly writes: number;
    readonly failures: number;
}

/**
 * A write that lost a race.
 *
 * Its own error rather than a boolean return, because a caller that ignores it has written nothing
 * and needs to find out — and because the current value comes with it, so a retry does not need a
 * second read.
 */
export class VersionConflict extends Error {
    constructor(readonly path: string, readonly expected: string, readonly current: StoredValue | undefined) {
        super(
            `${path} changed since it was read (expected version ${expected}, found ` +
            `${current?.version ?? 'nothing'}).`,
        );
        this.name = 'VersionConflict';
    }
}

export interface StorageProvider {
    readonly id: string;
    readonly capabilities: ProviderCapabilities;

    read(namespace: string, path: string): Promise<StoredValue | undefined>;
    /** `expect` makes it conditional: the write fails with VersionConflict if the version moved. */
    write(namespace: string, path: string, value: unknown, expect?: string): Promise<StoredValue>;
    delete(namespace: string, path: string): Promise<void>;

    stat(namespace: string, path: string): Promise<EntryStat | undefined>;
    list(namespace: string, prefix: string): Promise<readonly EntryStat[]>;

    /** Atomic multi-key write where the provider offers it — see `capabilities.atomicBatch`. */
    batch?(namespace: string, writes: readonly BatchWrite[]): Promise<void>;

    /** Change notification where the provider offers it. Remote does this over SSE. */
    watch?(namespace: string, prefix: string, onChange: (path: string) => void): DisposeFn;

    usage(namespace?: string): Promise<Usage>;
    metrics(): ProviderMetrics;
}

/** A version token. Opaque to everyone above; only compared, never parsed. */
export const nextVersion = (): string =>
    `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;

/**
 * The separator between a namespace and a path.
 *
 * NUL, because it cannot appear in a namespace or a path — so `("a", "b/c")` and `("a/b", "c")`
 * cannot produce one key. A space would have been ambiguous the first time a path contained one.
 *
 * Written as an escape rather than a raw byte: a control character in source is invisible, and this
 * one already caused the bug the comment below describes.
 */
export const KEY_SEPARATOR = '\u0000';

/**
 * Namespaced key, so one backing store can hold every namespace without them colliding.
 *
 * **Use this and `namespacePrefix` rather than building the key at a call site.** A provider that
 * writes with one and scans with another finds nothing, and finds it silently: this file said
 * `namespace\0path` while the local provider's `list` scanned for `namespace path`, so every write
 * worked, every read by key worked, and `list` and `usage` returned empty forever.
 */
export const keyOf = (namespace: string, path: string): string =>
    `${namespace}${KEY_SEPARATOR}${path}`;

/** Everything in this namespace starts with this. The counterpart to `keyOf`, from one source. */
export const namespacePrefix = (namespace: string): string => `${namespace}${KEY_SEPARATOR}`;
