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
import type { Gate } from '../net/api.js';
import { requiresAuth } from '../net/api.js';
import type { CollectionQuery, CollectionStatus } from './types.js';
import type { Session } from '../auth/extension.js';

export type QueryFetcher<TItem, TQuery> = (
    query?: TQuery,
) => Promise<Result<readonly TItem[], CallError<string>>>;

export type SessionSource =
    | ReadonlySignal<Session | null>
    | (() => ReadonlySignal<Session | null> | undefined);

/**
 * Does this item match the query filters?
 * Used to filter live event additions and updates so query views do not receive excluded rows.
 */
export function matchesQuery(item: unknown, query: unknown): boolean {
    if (!query || typeof query !== 'object') return true;
    if (!item || typeof item !== 'object') return true;
    const itemRec = item as Record<string, unknown>;
    const queryRec = query as Record<string, unknown>;

    for (const [key, value] of Object.entries(queryRec)) {
        if (value === undefined || value === null) continue;
        if (key === 'limit' || key === 'offset' || key === 'skip' || key === 'page' || key === 'sort' || key === 'order') {
            continue;
        }
        if (key in itemRec) {
            const itemVal = itemRec[key];
            if (Array.isArray(value)) {
                if (!value.includes(itemVal)) return false;
            } else if (itemVal !== value) {
                return false;
            }
        } else if (key === 'search' && typeof value === 'string') {
            const term = value.toLowerCase();
            const matchesAny = Object.values(itemRec).some(
                (v) => typeof v === 'string' && v.toLowerCase().includes(term),
            );
            if (!matchesAny) return false;
        } else {
            return false;
        }
    }
    return true;
}

export class CollectionQueryImpl<TItem, TQuery> implements IDisposableContainer {
    private readonly fetcher: QueryFetcher<TItem, TQuery>;
    private readonly queryFn: (() => TQuery) | undefined;
    private readonly onDisposeCallbacks: Set<() => void> = new Set();
    private readonly sessionSource?: SessionSource;
    private readonly gate?: Gate;

    private readonly _data: Signal<readonly TItem[] | undefined>;
    private readonly _rows: Signal<readonly TItem[]>;
    private readonly _loading: Signal<boolean>;
    private readonly _error: Signal<CallError<string> | null>;
    private readonly _empty: Signal<boolean>;
    private readonly _status: Signal<CollectionStatus>;
    private readonly _live: Signal<boolean>;

    private currentRequestId = 0;
    private currentInFlightPromise: Promise<readonly TItem[] | undefined> | null = null;
    private isDisposed = false;
    private effectDispose: (() => void) | null = null;
    private sessionEffectDispose: (() => void) | null = null;
    private childDisposables: Set<() => void> = new Set();
    private parentScope: IDisposableContainer | null = null;

    private failedForAuth = false;
    private loadedWithSession = false;

    constructor(
        fetcher: QueryFetcher<TItem, TQuery>,
        queryInput?: TQuery | (() => TQuery),
        bindScope = true,
        sessionSource?: SessionSource,
        gate?: Gate,
        live = false,
    ) {
        this.fetcher = fetcher;
        this.sessionSource = sessionSource;
        this.gate = gate;
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
        this._live = signal<boolean>(live);

        if (bindScope) {
            this.parentScope = getActiveScopeContext();
            if (this.parentScope !== null) {
                this.parentScope.addDisposable(() => this.dispose());
            }
        }

        let initialized = false;
        let prevSession: Session | null = null;

        this.sessionEffectDispose = effect(() => {
            const currentSignal = this.getSessionSignal();
            if (currentSignal === undefined) {
                return;
            }
            const currentSession = currentSignal();

            if (!initialized) {
                initialized = true;
                prevSession = currentSession;
                return;
            }

            const hadSession = prevSession !== null;
            const hasSession = currentSession !== null;
            const userChanged = prevSession !== null && currentSession !== null && prevSession.userId !== currentSession.userId;
            prevSession = currentSession;

            if (!hadSession && hasSession) {
                // Session arrived (absent -> present).
                // A session arriving must load every collection with no data, however it came to have none.
                if (this._data() === undefined || this.failedForAuth) {
                    void this.triggerFetch(true);
                }
            } else if (hadSession && !hasSession) {
                // Sign-out (present -> absent).
                // When it changes to absent, it must not keep showing another person's rows.
                // Signing out and signing back in as somebody else is the case that decides the
                // design: a collection holding rows from the previous session is a data leak.
                this.currentRequestId++;
                this.currentInFlightPromise = null;
                this._data.set(undefined);
                this._rows.set([]);
                this._empty.set(false);
                this._status.set('idle');
                this._loading.set(false);
                this.failedForAuth = true;
                this.loadedWithSession = false;
                // A collection must not fire a request that is certain to fail for want of a session.
            } else if (userChanged) {
                // Switched user (User A -> User B).
                // Clear old rows immediately to prevent cross-user leak, then refetch for the new user.
                this.currentRequestId++;
                this.currentInFlightPromise = null;
                this._data.set(undefined);
                this._rows.set([]);
                this._empty.set(false);
                this._loading.set(true);
                this.failedForAuth = false;
                this.loadedWithSession = false;
                void this.triggerFetch(true);
            }
        });

        this.effectDispose = effect(() => {
            void this.triggerFetch(false);
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

    get live(): ReadonlySignal<boolean> {
        return this._live;
    }

    setLive(live: boolean): void {
        this._live.set(live);
    }

    applyCreated(payload: unknown): void {
        const item = (payload && typeof payload === 'object' && 'item' in payload && (payload as Record<string, unknown>).item !== undefined)
            ? (payload as Record<string, unknown>).item
            : payload;
        const currentQuery = this.queryFn ? this.queryFn() : undefined;
        if (!matchesQuery(item, currentQuery)) {
            return;
        }

        const id = (item as Record<string, unknown>)?.id ?? (item as Record<string, unknown>)?._id ?? (payload as Record<string, unknown>)?.id;
        const currentRows = this._rows() ?? [];
        if (id !== undefined) {
            const existingIndex = currentRows.findIndex(
                (r: unknown) => (r as Record<string, unknown>)?.id === id || (r as Record<string, unknown>)?._id === id,
            );
            if (existingIndex >= 0) {
                // Deduplicate by ID to prevent double-applying local writes: replace in place
                const next = [...currentRows];
                next[existingIndex] = item as TItem;
                this._data.set(next);
                this._rows.set(next);
                this._loading.set(false);
                this._empty.set(next.length === 0);
                this._status.set(next.length === 0 ? 'empty' : 'ready');
                return;
            }
        }

        const next = [...currentRows, item as TItem];
        this._data.set(next);
        this._rows.set(next);
        this._loading.set(false);
        this._empty.set(false);
        this._status.set('ready');
    }

    applyUpdated(payload: unknown): void {
        const item = (payload && typeof payload === 'object' && 'item' in payload && (payload as Record<string, unknown>).item !== undefined)
            ? (payload as Record<string, unknown>).item
            : payload;
        const id = (payload as Record<string, unknown>)?.id ?? (item as Record<string, unknown>)?.id ?? (item as Record<string, unknown>)?._id;
        const currentQuery = this.queryFn ? this.queryFn() : undefined;
        const matches = matchesQuery(item, currentQuery);
        const currentRows = this._rows() ?? [];
        const existingIndex = id !== undefined
            ? currentRows.findIndex((r: unknown) => (r as Record<string, unknown>)?.id === id || (r as Record<string, unknown>)?._id === id)
            : -1;

        if (existingIndex >= 0) {
            if (matches) {
                const next = [...currentRows];
                next[existingIndex] = item as TItem;
                this._data.set(next);
                this._rows.set(next);
                this._loading.set(false);
                this._empty.set(next.length === 0);
                this._status.set(next.length === 0 ? 'empty' : 'ready');
            } else {
                // No longer matches query view: remove from view
                const next = currentRows.filter((_, idx) => idx !== existingIndex);
                this._data.set(next);
                this._rows.set(next);
                this._loading.set(false);
                this._empty.set(next.length === 0);
                this._status.set(next.length === 0 ? 'empty' : 'ready');
            }
        } else if (matches) {
            // New item now matches view
            const next = [...currentRows, item as TItem];
            this._data.set(next);
            this._rows.set(next);
            this._loading.set(false);
            this._empty.set(false);
            this._status.set('ready');
        }
    }

    applyDeleted(payload: unknown): void {
        const id = typeof payload === 'string'
            ? payload
            : ((payload && typeof payload === 'object') ? ((payload as Record<string, unknown>).id ?? (payload as Record<string, unknown>)._id) : undefined);
        if (id === undefined) return;

        const currentRows = this._rows() ?? [];
        const existingIndex = currentRows.findIndex(
            (r: unknown) => (r as Record<string, unknown>)?.id === id || (r as Record<string, unknown>)?._id === id,
        );
        if (existingIndex >= 0) {
            const next = currentRows.filter((_, idx) => idx !== existingIndex);
            this._data.set(next);
            this._rows.set(next);
            this._loading.set(false);
            this._empty.set(next.length === 0);
            this._status.set(next.length === 0 ? 'empty' : 'ready');
        }
    }

    onDispose(cleanup: () => void): void {
        if (this.isDisposed) {
            cleanup();
            return;
        }
        this.onDisposeCallbacks.add(cleanup);
    }

    private getSessionSignal(): ReadonlySignal<Session | null> | undefined {
        if (!this.sessionSource) {
            return undefined;
        }
        if ('peek' in this.sessionSource && typeof this.sessionSource.peek === 'function') {
            return this.sessionSource as ReadonlySignal<Session | null>;
        }
        if (typeof this.sessionSource === 'function') {
            return (this.sessionSource as () => ReadonlySignal<Session | null> | undefined)();
        }
        return undefined;
    }

    private shouldFetch(): boolean {
        const sessionSignal = this.getSessionSignal();
        const currentSession = sessionSignal ? sessionSignal.peek() : null;
        if (this.failedForAuth && currentSession === null) {
            return false;
        }
        if (this.gate !== undefined && requiresAuth(this.gate) && currentSession === null) {
            return false;
        }
        return true;
    }

    private triggerFetch(force = false): Promise<readonly TItem[] | undefined> {
        if (this.isDisposed) {
            return Promise.resolve(undefined);
        }

        const requestId = ++this.currentRequestId;
        const sessionSignal = this.getSessionSignal();
        const sessionAtStart = sessionSignal ? sessionSignal.peek() : null;

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

        if (!force && !this.shouldFetch()) {
            this._loading.set(false);
            this._status.set('idle');
            return Promise.resolve(undefined);
        }

        this._loading.set(true);

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
                    const sessionNow = sessionSignal ? sessionSignal.peek() : null;
                    this._data.set(result.value);
                    this._rows.set(result.value);
                    this._error.set(null);
                    this.failedForAuth = false;
                    this.loadedWithSession = sessionNow !== null;
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
                if (result.error.kind === 'unauthorized') {
                    this.failedForAuth = true;
                    this.loadedWithSession = false;
                    this._data.set(undefined);
                    this._rows.set([]);
                    this._empty.set(false);
                    const sessionNow = sessionSignal ? sessionSignal.peek() : null;
                    if (sessionAtStart === null && sessionNow !== null) {
                        // Session arrived while the unauthenticated request was in flight: reload immediately with the session
                        void this.triggerFetch(true);
                        return undefined;
                    }
                }
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
        return this.triggerFetch(true);
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

        if (this.sessionEffectDispose !== null) {
            this.sessionEffectDispose();
            this.sessionEffectDispose = null;
        }

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
    sessionSource?: SessionSource,
    gate?: Gate,
    live = false,
): CollectionQuery<TItem, TQuery> {
    const impl = new CollectionQueryImpl<TItem, TQuery>(fetcher, queryInput, true, sessionSource, gate, live);
    const getter = () => impl.data();
    const query: CollectionQuery<TItem, TQuery> = Object.assign(getter, {
        data: impl.data,
        rows: impl.rows,
        loading: impl.loading,
        error: impl.error,
        empty: impl.empty,
        status: impl.status,
        live: impl.live,
        refetch: () => impl.refetch(),
        dispose: () => impl.dispose(),
    });
    return query;
}
