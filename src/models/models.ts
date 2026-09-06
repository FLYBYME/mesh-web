/**
 * Models capability implementation — spec/network.md §5 and roadmap A3.7.
 *
 * Exposes site CRUD contracts as typed reactive collections.
 * - Reactive query binding via `CollectionQuery`
 * - Automatic re-fetch on mutations within the collection
 * - Scoped disposal bound to reactive context
 * - Zero type parameters at the call site
 */

import type { AnyApiCall } from '../net/api.js';
import type { Result, CallError } from '../net/result.js';
import type { ReadonlySignal } from '../reactivity/types.js';
import { CollectionQueryImpl, type QueryFetcher } from './query.js';
import type {
    CallsOf,
    CollectionHandle,
    CollectionNameOf,
    CollectionQuery,
    CollectionStatus,
    CreateErrorsOf,
    CreateInputOf,
    CreateOutputOf,
    DeleteErrorsOf,
    DeleteInputOf,
    DeleteOutputOf,
    GetErrorsOf,
    GetInputOf,
    GetOutputOf,
    ItemOf,
    Models,
    QueryOf,
    UpdateErrorsOf,
    UpdateInputOf,
    UpdateOutputOf,
} from './types.js';

export interface MeshCaller {
    call(action: string, input?: unknown): Promise<Result<unknown, CallError<string>>>;
}

function isTypedResult<T, E extends string>(
    _res: Result<unknown, CallError<string>>,
): _res is Result<T, CallError<E>> {
    return true;
}

function coerceResult<T, E extends string>(
    res: Result<unknown, CallError<string>>,
): Result<T, CallError<E>> {
    if (isTypedResult<T, E>(res)) {
        return res;
    }
    throw new Error('Unreachable result coercion failure');
}

function isTypedArray<T>(_val: unknown): _val is readonly T[] {
    return Array.isArray(_val);
}

function defineName<F, N extends string>(fn: F, n: N): F & { readonly name: N } {
    Object.defineProperty(fn, 'name', { value: n, configurable: true, enumerable: true });
    if (hasName<F, N>(fn)) {
        return fn;
    }
    throw new Error('failed to define name');
}

function hasName<F, N extends string>(_fn: F): _fn is F & { readonly name: N } {
    return true;
}

function attachQueryAccessors<T, TItem, TQuery>(
    target: T,
    getQuery: () => CollectionQuery<TItem, TQuery>,
): T & {
    readonly data: ReadonlySignal<readonly TItem[] | undefined>;
    readonly rows: ReadonlySignal<readonly TItem[]>;
    readonly loading: ReadonlySignal<boolean>;
    readonly error: ReadonlySignal<CallError<string> | null>;
    readonly empty: ReadonlySignal<boolean>;
    readonly status: ReadonlySignal<CollectionStatus>;
} {
    Object.defineProperties(target, {
        data: { get: () => getQuery().data, enumerable: true, configurable: true },
        rows: { get: () => getQuery().rows, enumerable: true, configurable: true },
        loading: { get: () => getQuery().loading, enumerable: true, configurable: true },
        error: { get: () => getQuery().error, enumerable: true, configurable: true },
        empty: { get: () => getQuery().empty, enumerable: true, configurable: true },
        status: { get: () => getQuery().status, enumerable: true, configurable: true },
    });
    if (hasQueryAccessors<T, TItem, TQuery>(target)) {
        return target;
    }
    throw new Error('failed to attach accessors');
}

function hasQueryAccessors<T, TItem, TQuery>(
    _val: unknown,
): _val is T & {
    readonly data: ReadonlySignal<readonly TItem[] | undefined>;
    readonly rows: ReadonlySignal<readonly TItem[]>;
    readonly loading: ReadonlySignal<boolean>;
    readonly error: ReadonlySignal<CallError<string> | null>;
    readonly empty: ReadonlySignal<boolean>;
    readonly status: ReadonlySignal<CollectionStatus>;
} {
    return true;
}

function createCollection<TCalls extends Record<string, AnyApiCall>, C extends string>(
    name: C,
    mesh: MeshCaller,
): CollectionHandle<TCalls, C> {
    type TItem = ItemOf<TCalls, C>;
    type TQuery = QueryOf<TCalls, C>;

    const activeQueries = new Set<CollectionQueryImpl<TItem, TQuery>>();

    const fetcher: QueryFetcher<TItem, TQuery> = async (queryInput) => {
        const action = `${name}.find`;
        const res = await mesh.call(action, queryInput);
        if (res.ok) {
            if (isTypedArray<TItem>(res.value)) {
                return { ok: true, value: res.value };
            }
            return { ok: true, value: [] };
        }
        return res;
    };

    function instantiateQuery(
        qInput?: TQuery | (() => TQuery),
        bindScope = true,
    ): CollectionQuery<TItem, TQuery> {
        const queryImpl = new CollectionQueryImpl<TItem, TQuery>(fetcher, qInput, bindScope);
        activeQueries.add(queryImpl);
        queryImpl.onDispose(() => {
            activeQueries.delete(queryImpl);
        });

        const getter = () => queryImpl.data();
        const q: CollectionQuery<TItem, TQuery> = Object.assign(getter, {
            data: queryImpl.data,
            rows: queryImpl.rows,
            loading: queryImpl.loading,
            error: queryImpl.error,
            empty: queryImpl.empty,
            status: queryImpl.status,
            refetch: () => queryImpl.refetch(),
            dispose: () => queryImpl.dispose(),
        });
        return q;
    }

    let defaultQueryInstance: CollectionQuery<TItem, TQuery> | null = null;
    function getDefaultQuery(): CollectionQuery<TItem, TQuery> {
        if (defaultQueryInstance === null) {
            defaultQueryInstance = instantiateQuery(undefined, false);
        }
        return defaultQueryInstance;
    }

    const getter = () => getDefaultQuery()();
    const namedGetter = defineName(getter, name);
    const accessorGetter = attachQueryAccessors(namedGetter, getDefaultQuery);

    const invalidate = async (): Promise<void> => {
        const queries = Array.from(activeQueries);
        await Promise.all(queries.map((q) => q.refetch()));
    };

    const handle: CollectionHandle<TCalls, C> = Object.assign(accessorGetter, {
        refetch: () => getDefaultQuery().refetch(),
        dispose: () => {
            if (defaultQueryInstance !== null) {
                defaultQueryInstance.dispose();
                defaultQueryInstance = null;
            }
            for (const q of Array.from(activeQueries)) {
                q.dispose();
            }
            activeQueries.clear();
        },
        find: (query?: TQuery | (() => TQuery)) => instantiateQuery(query),
        invalidate,

        async create(...input: CreateInputOf<TCalls, C> extends void ? [] : [input: CreateInputOf<TCalls, C>]) {
            const action = `${name}.create`;
            const res = await mesh.call(action, input[0]);
            if (res.ok) {
                await invalidate();
            }
            return coerceResult<CreateOutputOf<TCalls, C>, CreateErrorsOf<TCalls, C>>(res);
        },

        async update(...input: UpdateInputOf<TCalls, C> extends void ? [] : [input: UpdateInputOf<TCalls, C>]) {
            const action = `${name}.update`;
            const res = await mesh.call(action, input[0]);
            if (res.ok) {
                await invalidate();
            }
            return coerceResult<UpdateOutputOf<TCalls, C>, UpdateErrorsOf<TCalls, C>>(res);
        },

        async delete(...input: DeleteInputOf<TCalls, C> extends void ? [] : [input: DeleteInputOf<TCalls, C>]) {
            const action = `${name}.delete`;
            const res = await mesh.call(action, input[0]);
            if (res.ok) {
                await invalidate();
            }
            return coerceResult<DeleteOutputOf<TCalls, C>, DeleteErrorsOf<TCalls, C>>(res);
        },

        async get(...input: GetInputOf<TCalls, C> extends void ? [] : [input: GetInputOf<TCalls, C>]) {
            const action = `${name}.get`;
            const res = await mesh.call(action, input[0]);
            return coerceResult<GetOutputOf<TCalls, C>, GetErrorsOf<TCalls, C>>(res);
        },
    });

    return handle;
}

/**
 * Creates the `models` capability client backed by `mesh`.
 */
export function createModels<A>(
    mesh: MeshCaller,
    onDispose?: (cleanup: () => void) => void,
): Models<A> {
    type TCalls = CallsOf<A>;
    const collections = new Map<string, { dispose(): void }>();

    function isCollectionHandle<K extends CollectionNameOf<A>>(
        _val: unknown,
    ): _val is CollectionHandle<TCalls, K> {
        return true;
    }

    function getCollection<K extends CollectionNameOf<A>>(name: K): CollectionHandle<TCalls, K> {
        const existing = collections.get(name);
        if (existing !== undefined && isCollectionHandle<K>(existing)) {
            return existing;
        }

        const created = createCollection<TCalls, K>(name, mesh);
        collections.set(name, created);
        return created;
    }

    function modelsFn<K extends CollectionNameOf<A>>(name: K): CollectionHandle<TCalls, K>;
    function modelsFn<K extends CollectionNameOf<A>>(
        name: K,
        query: QueryOf<TCalls, K> | (() => QueryOf<TCalls, K>),
    ): CollectionQuery<ItemOf<TCalls, K>, QueryOf<TCalls, K>>;
    function modelsFn<K extends CollectionNameOf<A>>(
        name: K,
        query?: QueryOf<TCalls, K> | (() => QueryOf<TCalls, K>),
    ) {
        const col = getCollection(name);
        if (query !== undefined) {
            return col.find(query);
        }
        return col;
    }

    modelsFn.collection = function <K extends CollectionNameOf<A>>(name: K): CollectionHandle<TCalls, K> {
        return getCollection(name);
    };

    if (onDispose !== undefined) {
        onDispose(() => {
            for (const col of collections.values()) {
                col.dispose();
            }
            collections.clear();
        });
    }

    return modelsFn;
}
