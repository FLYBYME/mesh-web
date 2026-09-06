/**
 * The models capability types — spec/network.md §5 and roadmap A3.7.
 *
 * Typed reactive collections over a site's declared CRUD contracts.
 * Zero type parameters at the call site: cx.models('part') is typed from the site's API.
 */

import type { AnyApiCall, Api, InputOf, OutputOf, ErrorsOf } from '../net/api.js';
import type { Result, CallError } from '../net/result.js';
import type { ReadonlySignal } from '../reactivity/types.js';

export type CollectionStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

/**
 * A reactive query over a collection.
 *
 * Distinguishes loading, error, empty, and ready states as first-class signals.
 * Callable as a getter returning data() for ergonomic reads in computed/render contexts.
 */
export interface CollectionQuery<TItem, TQuery = unknown> {
    (): readonly TItem[] | undefined;
    readonly data: ReadonlySignal<readonly TItem[] | undefined>;
    readonly rows: ReadonlySignal<readonly TItem[]>;
    readonly loading: ReadonlySignal<boolean>;
    readonly error: ReadonlySignal<CallError<string> | null>;
    readonly empty: ReadonlySignal<boolean>;
    readonly status: ReadonlySignal<CollectionStatus>;
    refetch(): Promise<readonly TItem[] | undefined>;
    dispose(): void;
}

export type ExtractCollectionName<K> = K extends `${infer Name}.find` ? Name : never;

/** Every collection name declared by this API. */
export type CollectionNameOf<A> = A extends Api<infer TCalls>
    ? ExtractCollectionName<keyof TCalls & string>
    : never;

export type CallsOf<A> = A extends Api<infer TCalls> ? TCalls : Record<string, AnyApiCall>;

export type FindCallOf<TCalls, C extends string> = `${C}.find` extends keyof TCalls ? TCalls[`${C}.find`] : never;
export type FindOutput<TCalls, C extends string> = OutputOf<FindCallOf<TCalls, C>>;
export type ItemOf<TCalls, C extends string> = FindOutput<TCalls, C> extends readonly (infer Item)[] ? Item : never;
export type QueryOf<TCalls, C extends string> = InputOf<FindCallOf<TCalls, C>>;

export type CreateCallOf<TCalls, C extends string> = `${C}.create` extends keyof TCalls ? TCalls[`${C}.create`] : never;
export type CreateInputOf<TCalls, C extends string> = InputOf<CreateCallOf<TCalls, C>>;
export type CreateOutputOf<TCalls, C extends string> = OutputOf<CreateCallOf<TCalls, C>>;
export type CreateErrorsOf<TCalls, C extends string> = ErrorsOf<CreateCallOf<TCalls, C>>;

export type UpdateCallOf<TCalls, C extends string> = `${C}.update` extends keyof TCalls ? TCalls[`${C}.update`] : never;
export type UpdateInputOf<TCalls, C extends string> = InputOf<UpdateCallOf<TCalls, C>>;
export type UpdateOutputOf<TCalls, C extends string> = OutputOf<UpdateCallOf<TCalls, C>>;
export type UpdateErrorsOf<TCalls, C extends string> = ErrorsOf<UpdateCallOf<TCalls, C>>;

export type DeleteCallOf<TCalls, C extends string> = `${C}.delete` extends keyof TCalls ? TCalls[`${C}.delete`] : never;
export type DeleteInputOf<TCalls, C extends string> = InputOf<DeleteCallOf<TCalls, C>>;
export type DeleteOutputOf<TCalls, C extends string> = OutputOf<DeleteCallOf<TCalls, C>>;
export type DeleteErrorsOf<TCalls, C extends string> = ErrorsOf<DeleteCallOf<TCalls, C>>;

export type GetCallOf<TCalls, C extends string> = `${C}.get` extends keyof TCalls ? TCalls[`${C}.get`] : never;
export type GetInputOf<TCalls, C extends string> = InputOf<GetCallOf<TCalls, C>>;
export type GetOutputOf<TCalls, C extends string> = OutputOf<GetCallOf<TCalls, C>>;
export type GetErrorsOf<TCalls, C extends string> = ErrorsOf<GetCallOf<TCalls, C>>;

/**
 * A collection handle obtained from `cx.models(name)`.
 *
 * Implements `CollectionQuery` for the default find() query, and exposes CRUD mutations
 * typed directly from the declared API calls.
 */
export interface CollectionHandle<TCalls extends Record<string, AnyApiCall>, C extends string>
    extends CollectionQuery<ItemOf<TCalls, C>, QueryOf<TCalls, C>> {
    readonly name: C;
    find(
        query?: QueryOf<TCalls, C> | (() => QueryOf<TCalls, C>),
    ): CollectionQuery<ItemOf<TCalls, C>, QueryOf<TCalls, C>>;
    invalidate(): Promise<void>;
    create(
        ...input: CreateInputOf<TCalls, C> extends void ? [] : [input: CreateInputOf<TCalls, C>]
    ): Promise<Result<CreateOutputOf<TCalls, C>, CallError<CreateErrorsOf<TCalls, C>>>>;
    update(
        ...input: UpdateInputOf<TCalls, C> extends void ? [] : [input: UpdateInputOf<TCalls, C>]
    ): Promise<Result<UpdateOutputOf<TCalls, C>, CallError<UpdateErrorsOf<TCalls, C>>>>;
    delete(
        ...input: DeleteInputOf<TCalls, C> extends void ? [] : [input: DeleteInputOf<TCalls, C>]
    ): Promise<Result<DeleteOutputOf<TCalls, C>, CallError<DeleteErrorsOf<TCalls, C>>>>;
    get(
        ...input: GetInputOf<TCalls, C> extends void ? [] : [input: GetInputOf<TCalls, C>]
    ): Promise<Result<GetOutputOf<TCalls, C>, CallError<GetErrorsOf<TCalls, C>>>>;
}

/**
 * The `models` capability client, typed per contribution by the API declared in the manifest.
 */
export interface Models<A> {
    <K extends CollectionNameOf<A>>(name: K): CollectionHandle<CallsOf<A>, K>;
    <K extends CollectionNameOf<A>>(
        name: K,
        query: QueryOf<CallsOf<A>, K> | (() => QueryOf<CallsOf<A>, K>),
    ): CollectionQuery<ItemOf<CallsOf<A>, K>, QueryOf<CallsOf<A>, K>>;

    collection<K extends CollectionNameOf<A>>(name: K): CollectionHandle<CallsOf<A>, K>;
}
