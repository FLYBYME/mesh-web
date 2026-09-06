/**
 * Reactive collection query implementation — roadmap A3.7.
 *
 * Manages async data fetching bound to the reactive graph.
 * Features:
 * - Automatically refetches when signals read inside the query change.
 * - Out-of-order response rejection: older requests never overwrite newer responses.
 * - In-flight deduplication for concurrent identical requests.
 * - Error preservation: failed refetches populate error() without zeroing data.
 * - First-class status tracking: idle, loading, ready, empty, and error.
 * - Bound to the active reactive scope for automatic disposal without leaks.
 */

import { signal, effect } from '../reactivity/index.js';
import { getActiveScopeContext } from '../reactivity/context.js';
import type { ReadonlySignal, Signal, IDisposableContainer } from '../reactivity/types.js';
import type { Result, CallError } from '../net/result.js';
import type { CollectionQuery, CollectionStatus } from './types.js';

export type QueryFetcher<TItem, TQuery> = (
    query?: TQuery,
) => Promise<Result<readonly TItem[], CallError<string>>>;

function isFunction<T>(val: unknown): val is () => T {
    return typeof val === 'function';
}

export class CollectionQueryImpl<TItem, TQuery> implements IDisposableContainer {
    private readonly fetcher: QueryFetcher<TItem, TQuery>;
    private readonly queryFn: (() => TQuery) | undefined;
    private readonly onDisposeCallbacks: Set<() => void> = new Set();

    private readonly _data: Signal<readonly TItem[] | undefined>;
    private readonly _rows: Signal<readonly TItem[]>;
    private readonly _loading: Signal<boolean>;
    private readonly _error: Signal<CallError<string> | null>;
    private readonly _empty: Signal<boolean>;
    private readonly _status: Signal<CollectionStatus>;

    private currentRequestId = 0;
    private currentInFlightPromise: Promise<readonly TItem[] | undefined> | null = null;
    private isDisposed = false;
    private effectDispose: (() => void) | null = null;
    private childDisposables: Set<() => void> = new Set();
    private parentScope: IDisposableContainer | null = null;

    constructor(
        fetcher: QueryFetcher<TItem, TQuery>,
        queryInput?: TQuery | (() => TQuery),
        bindScope = true,
    ) {
        this.fetcher = fetcher;
        if (typeof queryInput === 'function') {
            this.queryFn = queryInput as () => TQuery;
        } else if (queryInput !== undefined) {
            this.queryFn = () => queryInput;
        }

        this._data = signal<readonly TItem[] | undefined>(undefined);
        this._rows = signal<readonly TItem[]>([]);
        this._loading = signal<boolean>(true);
        this._error = signal<CallError<string> | null>(null);
        this._empty = signal<boolean>(false);
        this._status = signal<CollectionStatus>('loading');

        if (bindScope) {
            this.parentScope = getActiveScopeContext();
            if (this.parentScope !== null) {
                this.parentScope.addDisposable(() => this.dispose());
            }
        }

        this.effectDispose = effect(() => {
            void this.triggerFetch();
        });
    }

    get data(): ReadonlySignal<readonly TItem[] | undefined> {
        return this._data;
    }

    get rows(): ReadonlySignal<readonly TItem[]> {
        return this._rows;
    }

    get loading(): ReadonlySignal<boolean> {
        return this._loading;
    }

    get error(): ReadonlySignal<CallError<string> | null> {
        return this._error;
    }

    get empty(): ReadonlySignal<boolean> {
        return this._empty;
    }

    get status(): ReadonlySignal<CollectionStatus> {
        return this._status;
    }

    onDispose(cleanup: () => void): void {
        if (this.isDisposed) {
            cleanup();
            return;
        }
        this.onDisposeCallbacks.add(cleanup);
    }

    private triggerFetch(): Promise<readonly TItem[] | undefined> {
        if (this.isDisposed) {
            return Promise.resolve(undefined);
        }

        const requestId = ++this.currentRequestId;
        this._loading.set(true);

        let queryParam: TQuery | undefined;
        try {
            if (this.queryFn !== undefined) {
                queryParam = this.queryFn();
            }
        } catch (queryErr) {
            if (requestId === this.currentRequestId && !this.isDisposed) {
                const message = queryErr instanceof Error ? queryErr.message : String(queryErr);
                this._error.set({ kind: 'invalid', detail: message });
                this._status.set('error');
                this._loading.set(false);
                this.currentInFlightPromise = null;
            }
            return Promise.resolve(undefined);
        }

        let fetchPromise: Promise<Result<readonly TItem[], CallError<string>>>;
        try {
            fetchPromise = this.fetcher(queryParam);
        } catch (syncErr) {
            if (requestId === this.currentRequestId && !this.isDisposed) {
                const message = syncErr instanceof Error ? syncErr.message : String(syncErr);
                this._error.set({ kind: 'offline', detail: message });
                this._status.set('error');
                this._loading.set(false);
                this.currentInFlightPromise = null;
            }
            return Promise.resolve(undefined);
        }

        const resultPromise = fetchPromise.then(
            (result) => {
                if (this.isDisposed || requestId !== this.currentRequestId) {
                    return undefined;
                }
                this.currentInFlightPromise = null;
                this._loading.set(false);

                if (result.ok) {
                    this._data.set(result.value);
                    this._rows.set(result.value);
                    this._error.set(null);
                    if (result.value.length === 0) {
                        this._empty.set(true);
                        this._status.set('empty');
                    } else {
                        this._empty.set(false);
                        this._status.set('ready');
                    }
                    return result.value;
                }

                // Refusal or transport failure: preserve existing data, populate error state
                this._error.set(result.error);
                this._status.set('error');
                return undefined;
            },
            (rejection: unknown) => {
                if (this.isDisposed || requestId !== this.currentRequestId) {
                    return undefined;
                }
                this.currentInFlightPromise = null;
                this._loading.set(false);
                const message = rejection instanceof Error ? rejection.message : String(rejection);
                this._error.set({ kind: 'offline', detail: message });
                this._status.set('error');
                return undefined;
            },
        );

        this.currentInFlightPromise = resultPromise;
        return resultPromise;
    }

    refetch(): Promise<readonly TItem[] | undefined> {
        if (this.isDisposed) {
            return Promise.resolve(undefined);
        }
        if (this.currentInFlightPromise !== null) {
            return this.currentInFlightPromise;
        }
        return this.triggerFetch();
    }

    addDisposable(dispose: () => void): void {
        this.childDisposables.add(dispose);
    }

    removeDisposable(dispose: () => void): void {
        this.childDisposables.delete(dispose);
    }

    dispose(): void {
        if (this.isDisposed) return;
        this.isDisposed = true;
        this.currentRequestId++;
        this.currentInFlightPromise = null;

        if (this.effectDispose !== null) {
            this.effectDispose();
            this.effectDispose = null;
        }

        if (this.parentScope !== null) {
            this.parentScope.removeDisposable(() => this.dispose());
            this.parentScope = null;
        }

        for (const cleanup of this.onDisposeCallbacks) {
            try {
                cleanup();
            } catch {
                // proceed
            }
        }
        this.onDisposeCallbacks.clear();

        for (const d of this.childDisposables) {
            try {
                d();
            } catch {
                // proceed
            }
        }
        this.childDisposables.clear();
    }
}

/**
 * Creates a reactive CollectionQuery handle.
 */
export function createCollectionQuery<TItem, TQuery>(
    fetcher: QueryFetcher<TItem, TQuery>,
    queryInput?: TQuery | (() => TQuery),
): CollectionQuery<TItem, TQuery> {
    const impl = new CollectionQueryImpl<TItem, TQuery>(fetcher, queryInput);
    const getter = () => impl.data();
    const query: CollectionQuery<TItem, TQuery> = Object.assign(getter, {
        data: impl.data,
        rows: impl.rows,
        loading: impl.loading,
        error: impl.error,
        empty: impl.empty,
        status: impl.status,
        refetch: () => impl.refetch(),
        dispose: () => impl.dispose(),
    });
    return query;
}
