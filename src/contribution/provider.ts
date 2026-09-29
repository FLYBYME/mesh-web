/**
 * Tokens: a type carried by an id, so two sides can agree on what a slot holds without importing
 * each other. The kernel's drivers and the renderer are found by them (`kernel/io.ts`).
 *
 * The part model also used them for one part to find another (`consumes` / `use`). A service is
 * found by its class, so that half went with it (docs/app-model.md, phase 5c).
 */

declare const PROVIDED: unique symbol;

/**
 * The phantom `PROVIDED` is what carries `T`. It has no runtime existence — a token is `{ id }` and
 * nothing else, which is why a token can be compared, logged and stored.
 */
export interface ProviderToken<T> {
    readonly id: string;
    readonly [PROVIDED]?: T;
}

export function provider<T>(id: string): ProviderToken<T> {
    return { id };
}

export type ProviderTokens = readonly ProviderToken<unknown>[];
