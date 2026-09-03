/**
 * Provider tokens: a type carried across a boundary neither side imports over.
 *
 * spec/extension.md section 4. A consumer must get `AuthApi`'s type without importing
 * `AuthExtension` — otherwise it has pulled in the whole Extension and the token bought nothing.
 * The interface and the token live in a third place both sides import.
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

export type Provided<TToken> = TToken extends ProviderToken<infer T> ? T : never;

export type ProviderTokens = readonly ProviderToken<unknown>[];

/** Declares the tokens a contribution may `use`. Same shape as `needs`, same reason. */
export function consumes<const T extends ProviderTokens>(...tokens: T): T {
    return tokens;
}

export interface Consumer<TConsumes extends ProviderTokens> {
    /** Only a token in `TConsumes` compiles, and only a resolved one is returned. */
    use<TToken extends TConsumes[number]>(token: TToken): Provided<TToken>;
}
