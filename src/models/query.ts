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
import { MeshCallError, type CallError } from '../net/result.js';
import type { Gate } from '../net/api.js';
import { requiresAuth } from '../net/api.js';
import type { CollectionQuery, CollectionStatus } from './types.js';
import type { Session } from '../contribution/session.js';

/** Throws MeshCallError on failure, matching MeshClient.call -- never resolves to a Result. */
export type QueryFetcher<TItem, TQuery> = (
    query?: TQuery,
) => Promise<readonly TItem[]>;

export type SessionSource =
    | ReadonlySignal<Session | null>
    | (() => ReadonlySignal<Session | null> | undefined);

/**
 * Does this item match the query filters?
 * Used to filter live event additions and updates so query views do not receive excluded rows.
 */
/** Find-input keys that shape the result (paging, ordering, projection) rather than filter it. */
const NOT_FILTERS = new Set(['limit', 'offset', 'skip', 'page', 'sort', 'order', 'fields', 'populate', 'searchFields']);

/**
 * The equality filter inside a find input. A CRUD `find` takes `{ query: { field: value }, sort,
 * limit, search }`: the filter is `query`, not the input itself. Comparing an item against the
 * whole input — which has no `query` field an item could match — rejected every event, so a
 * filtered list (a zone's records) never updated live. A flat input (`{ tag: 't1' }`) is still
 * read as its own filter.
 */
function filterOf(input: Record<string, unknown>): Record<string, unknown> {
    const nested = input.query;
    if (isRecord(nested) && !Array.isArray(nested)) {
        const search = input.search;
        return { ...nested, ...(typeof search === 'string' ? { search } : {}) };
    }
    return input;
}

/** Event payloads and rows arrive from the network as `unknown`; this is the one narrowing. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object';
}

/** A row's id: `id`, or Mongo's `_id` where a row still carries it. */
function idOf(value: unknown): unknown {
    return isRecord(value) ? (value.id ?? value._id) : undefined;
}

/** The row an event carries: `{ item }` (created, updated), or the payload itself. */
function itemOf(payload: unknown): unknown {
    return isRecord(payload) && payload.item !== undefined ? payload.item : payload;
}

/** A field of a row by its path, nested with dots as the database reads it: `target.id`. */
function valueAt(row: Record<string, unknown>, path: string): unknown {
    let at: unknown = row;
    for (const part of path.split('.')) {
        if (!isRecord(at)) return undefined;
        at = at[part];
    }

    return at;
}

const compare = (a: unknown, b: unknown): number | undefined =>
    (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string')
        ? (a < b ? -1 : a > b ? 1 : 0)
        : undefined;

/**
 * One field's condition, judged on the row alone: a value, or `{ $in, $nin, $ne, $eq, $exists, $gt,
 * $gte, $lt, $lte }`. Undefined: an operator this can't judge here -- the caller asks the api again
 * rather than guess (10-17: `{ host: { $in } }` was read as a value, never equal, and every updated
 * row left the list).
 */
function judge(value: unknown, condition: unknown): boolean | undefined {
    if (!isRecord(condition) || Array.isArray(condition)) {
        return Array.isArray(condition) ? condition.includes(value) : value === condition;
    }

    for (const [op, arg] of Object.entries(condition)) {
        let ok: boolean | undefined;
        switch (op) {
            case '$eq': ok = value === arg; break;
            case '$ne': ok = value !== arg; break;
            case '$in': ok = Array.isArray(arg) ? arg.includes(value) : undefined; break;
            case '$nin': ok = Array.isArray(arg) ? !arg.includes(value) : undefined; break;
            case '$exists': ok = (value !== undefined) === Boolean(arg); break;
            case '$gt': { const c = compare(value, arg); ok = c === undefined ? undefined : c > 0; break; }
            case '$gte': { const c = compare(value, arg); ok = c === undefined ? undefined : c >= 0; break; }
            case '$lt': { const c = compare(value, arg); ok = c === undefined ? undefined : c < 0; break; }
            case '$lte': { const c = compare(value, arg); ok = c === undefined ? undefined : c <= 0; break; }
            default: ok = undefined;
        }
        if (ok !== true) return ok;
    }

    return true;
}

/** Whether a row belongs to a find: true, false, or undefined when only the api can say. */
export function judgeQuery(item: unknown, query: unknown): boolean | undefined {
    if (!isRecord(query)) return true;
    if (!isRecord(item)) return true;
    const itemRec = item;
    const queryRec = filterOf(query);

    let unsure = false;
    for (const [key, value] of Object.entries(queryRec)) {
        if (value === undefined || value === null) continue;
        if (NOT_FILTERS.has(key)) {
            continue;
        }
        if (key.startsWith('$')) {
            // $or, $and...: not judged here.
            unsure = true;
            continue;
        }
        if (key === 'search' && typeof value === 'string' && !(key in itemRec)) {
            const term = value.toLowerCase();
            const matchesAny = Object.values(itemRec).some(
                (v) => typeof v === 'string' && v.toLowerCase().includes(term),
            );
            if (!matchesAny) return false;
            continue;
        }

        const ok = judge(valueAt(itemRec, key), value);
        if (ok === false) return false;
        if (ok === undefined) unsure = true;
    }

    return unsure ? undefined : true;
}

export function matchesQuery(item: unknown, query: unknown): boolean {
    return judgeQuery(item, query) !== false;
}

/** The page a find asked for: `limit` rows, after skipping `offset` (CRUD) or `skip`. */
function windowOf(query: unknown): { limit: number | undefined; offset: number } {
    if (!isRecord(query)) return { limit: undefined, offset: 0 };
    const { limit, offset, skip } = query;
    const start = typeof offset === 'number' ? offset : typeof skip === 'number' ? skip : 0;
    return { limit: typeof limit === 'number' && limit >= 0 ? limit : undefined, offset: start };
}

/**
 * Rows in the order the query asked for. A live event adds or changes a row locally, and the list
 * must stay in the order the server would have returned it — a newest-first list shows a new row
 * first, not appended at the bottom. `sort` is the CRUD shape: `'name'`, `'-createdAt'`, or a list
 * of those; anything else leaves the order alone.
 */
export function sortedByQuery<T>(rows: readonly T[], query: unknown): readonly T[] {
    if (!isRecord(query)) return rows;
    const sort = query.sort;
    const keys = (typeof sort === 'string' ? sort.split(/[\s,]+/) : Array.isArray(sort) ? sort : [])
        .filter((k): k is string => typeof k === 'string' && k !== '')
        .map((k) => (k.startsWith('-') ? { field: k.slice(1), dir: -1 } : { field: k, dir: 1 }));
    if (keys.length === 0) return rows;
    const value = (row: T, field: string): unknown => (isRecord(row) ? row[field] : undefined);
    return [...rows].sort((a, b) => {
        for (const { field, dir } of keys) {
            const x = value(a, field);
            const y = value(b, field);
            if (x === y) continue;
            if (x === undefined || x === null) return 1;
            if (y === undefined || y === null) return -1;
            // Plain comparison, not localeCompare: the database orders by code point ("B" before
            // "a"), and a row placed by an event must sit where a fresh fetch would put it.
            const sx = typeof x === 'number' ? x : String(x);
            const sy = typeof y === 'number' ? y : String(y);
            const order = sx < sy ? -1 : sx > sy ? 1 : 0;
            if (order !== 0) return order * dir;
        }
        return 0;
    });
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
    /**
     * Events that arrived while a fetch was out, applied again once its answer lands: the answer
     * replaces every row, and the api may have read them before the event's change (10-25: an
     * alert created during a reconnect's re-read vanished when the re-read answered).
     */
    private eventsDuringFetch: Array<() => void> = [];
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
            // Another user, or the same one in another organization: the rows belong to the old scope.
            const userChanged = prevSession !== null && currentSession !== null
                && (prevSession.userId !== currentSession.userId || prevSession.organizationId !== currentSession.organizationId);
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

    private started = false;

    /** Whether this query has sent a fetch yet (a gated one waits for a session). */
    get hasFetched(): boolean {
        return this.started;
    }

    setLive(live: boolean): void {
        this._live.set(live);
    }

    /** Keeps an event for replay if a fetch is out (see {@link eventsDuringFetch}). */
    private heldForFetch(apply: () => void): void {
        if (this.currentInFlightPromise !== null) this.eventsDuringFetch.push(apply);
    }

    applyCreated(payload: unknown): void {
        this.heldForFetch(() => this.applyCreated(payload));
        const item = itemOf(payload);
        const currentQuery = this.queryFn ? this.queryFn() : undefined;
        const belongs = judgeQuery(item, currentQuery);
        if (belongs === undefined) {
            void this.refetch();
            return;
        }
        if (!belongs) {
            return;
        }

        const id = idOf(item) ?? idOf(payload);
        const currentRows = this._rows() ?? [];
        if (id !== undefined) {
            const existingIndex = currentRows.findIndex((r) => idOf(r) === id);
            if (existingIndex >= 0) {
                // Deduplicate by ID to prevent double-applying local writes: replace in place
                const next = [...currentRows];
                next[existingIndex] = item as TItem;
                this.commit(next, currentQuery);
                return;
            }
        }

        this.commit([...currentRows, item as TItem], currentQuery);
    }

    /**
     * Rows changed by an event or a local write: kept in the query's order and window, and the
     * status with them.
     *
     * A window (`limit`/`offset`) is only partly knowable here. Past the first page, where a row
     * lands depends on rows this query never fetched, so the page is refetched instead. On the
     * first page a new row can be placed and the one pushed past `limit` dropped — but a row that
     * leaves a full page makes room for one only the server knows, so that too refetches (after
     * showing the removal at once).
     */
    private commit(next: readonly TItem[], currentQuery: unknown, removedFrom?: number): void {
        const { limit, offset } = windowOf(currentQuery);
        if (offset > 0) {
            void this.refetch();
            return;
        }
        const sorted = sortedByQuery(next, currentQuery);
        const ordered = limit !== undefined && sorted.length > limit ? sorted.slice(0, limit) : sorted;
        // `removedFrom`: the row count before a row left (a delete, or an update out of the filter).
        const leftFullPage = limit !== undefined && removedFrom !== undefined && removedFrom >= limit;
        this._data.set(ordered);
        this._rows.set(ordered);
        this._loading.set(false);
        this._empty.set(ordered.length === 0);
        this._status.set(ordered.length === 0 ? 'empty' : 'ready');
        if (leftFullPage) void this.refetch();
    }

    applyUpdated(payload: unknown): void {
        this.heldForFetch(() => this.applyUpdated(payload));
        const item = itemOf(payload);
        const id = (isRecord(payload) ? payload.id : undefined) ?? idOf(item);
        const currentQuery = this.queryFn ? this.queryFn() : undefined;
        const belongs = judgeQuery(item, currentQuery);
        if (belongs === undefined) {
            void this.refetch();
            return;
        }
        const matches = belongs;
        const currentRows = this._rows() ?? [];
        const existingIndex = id !== undefined ? currentRows.findIndex((r) => idOf(r) === id) : -1;

        if (existingIndex >= 0) {
            if (matches) {
                const next = [...currentRows];
                next[existingIndex] = item as TItem;
                this.commit(next, currentQuery);
            } else {
                // No longer matches query view: remove from view
                this.commit(currentRows.filter((_, idx) => idx !== existingIndex), currentQuery, currentRows.length);
            }
        } else if (matches) {
            // New item now matches view
            this.commit([...currentRows, item as TItem], currentQuery);
        }
    }

    applyDeleted(payload: unknown): void {
        this.heldForFetch(() => this.applyDeleted(payload));
        const id = typeof payload === 'string' ? payload : idOf(payload);
        if (id === undefined) return;

        const currentRows = this._rows() ?? [];
        const existingIndex = currentRows.findIndex((r) => idOf(r) === id);
        if (existingIndex >= 0) {
            this.commit(currentRows.filter((_, idx) => idx !== existingIndex), this.queryFn ? this.queryFn() : undefined, currentRows.length);
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

        let fetchPromise: Promise<readonly TItem[]>;
        try {
            this.started = true;
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
            (rows) => {
                if (this.isDisposed || requestId !== this.currentRequestId) {
                    return undefined;
                }
                this.currentInFlightPromise = null;
                this._loading.set(false);

                const sessionNow = sessionSignal ? sessionSignal.peek() : null;
                this._data.set(rows);
                this._rows.set(rows);
                this._error.set(null);
                this.failedForAuth = false;
                this.loadedWithSession = sessionNow !== null;
                if (rows.length === 0) {
                    this._empty.set(true);
                    this._status.set('empty');
                } else {
                    this._empty.set(false);
                    this._status.set('ready');
                }

                // In arrival order; each is idempotent (a created row is matched by id).
                for (const apply of this.eventsDuringFetch.splice(0)) apply();

                return this._rows() ?? rows;
            },
            (rejection: unknown) => {
                if (this.isDisposed || requestId !== this.currentRequestId) {
                    return undefined;
                }
                this.currentInFlightPromise = null;
                this._loading.set(false);
                // The rows already standing have those events; there is no answer to replay them on.
                this.eventsDuringFetch = [];

                // A thrown MeshCallError carries the same named failure a Result's .error used to --
                // everything below matches what the old onFulfilled(!result.ok) branch did, just
                // reached from here now that the fetcher throws instead of returning a Result.
                if (rejection instanceof MeshCallError) {
                    if (rejection.error.kind === 'unauthorized') {
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
                    this._error.set(rejection.error);
                    this._status.set('error');
                    return undefined;
                }

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
        this.eventsDuringFetch = [];

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
