/**
 * Models capability implementation — spec/network.md §5 and roadmap A3.7.
 *
 * Exposes site CRUD contracts as typed reactive collections.
 * - Reactive query binding via `CollectionQuery`
 * - Automatic re-fetch on mutations within the collection
 * - Scoped disposal bound to reactive context
 * - Zero type parameters at the call site
 */

import { z } from 'zod';
import { isCollectionStreamed, type AnyApiCall, type Api, type Gate } from '../net/api.js';
import type { CallError } from '../net/result.js';
import { effect } from '../reactivity/index.js';
import { runDetached } from '../reactivity/scope.js';
import type { ReadonlySignal } from '../reactivity/types.js';
import type { Session } from '../contribution/session.js';
import { CollectionQueryImpl, type QueryFetcher, type SessionSource } from './query.js';
import type {
    CallsOf,
    CollectionHandle,
    CollectionNameOf,
    CollectionQuery,
    CollectionStatus,
    CreateInputOf,
    CreateOutputOf,
    DeleteInputOf,
    DeleteOutputOf,
    GetInputOf,
    GetOutputOf,
    ItemOf,
    Models,
    QueryOf,
    UpdateInputOf,
    UpdateOutputOf,
} from './types.js';

/** What the stream hands a listener: a named event, and its data (a JSON string on the wire). */
export interface StreamMessage {
    readonly type?: string;
    readonly data?: unknown;
}

/**
 * A handler property checked like a method (bivariantly), so the DOM's own `EventSource` — whose
 * handlers take an `Event` / `MessageEvent` — fits `EventSourceLike` without a cast.
 */
type Handler<E> = { bivarianceHack(event: E): void }['bivarianceHack'];

/** The part of `EventSource` this client uses. */
export interface EventSourceLike {
    addEventListener?(event: string, listener: (event: StreamMessage) => void): void;
    removeEventListener?(event: string, listener: (event: StreamMessage) => void): void;
    onopen?: Handler<unknown> | null;
    onmessage?: Handler<StreamMessage> | null;
    onerror?: Handler<unknown> | null;
    close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface ModelsOptions {
    readonly eventSource?: EventSourceFactory;
    readonly origin?: string;
    /** Where a dropped stream frame (bad JSON, unknown shape) is reported. Silent without it. */
    readonly log?: (message: string) => void;
}

/** An unnamed stream message carries its event name inside: `{ event, data }`. */
const StreamFrame = z.object({ event: z.string(), data: z.unknown().optional() }).passthrough();

export interface EventStreamClient {
    subscribe(event: string, handler: (payload: unknown) => void): () => void;
    onReconnect(handler: () => void): () => void;
    /**
     * The stream's first open on this connection. A list fetched before it may have missed what
     * was written between its fetch and this moment — no event for it was being received.
     */
    onFirstOpen(handler: () => void): () => void;
    close(): void;
    readonly isAvailable: boolean;
}

export function createEventStreamClient(
    url: string,
    factory?: EventSourceFactory,
    sessionSource?: SessionSource,
    log?: (message: string) => void,
): EventStreamClient {
    if (!factory) {
        return {
            subscribe: () => () => {},
            onReconnect: () => () => {},
            onFirstOpen: () => () => {},
            close: () => {},
            isAvailable: false,
        };
    }

    let es: EventSourceLike | null = null;
    let openedOnce = false;
    let isDisposed = false;
    const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
    const reconnectListeners = new Set<() => void>();
    const firstOpenListeners = new Set<() => void>();

    function getSessionSignal(): ReadonlySignal<Session | null> | undefined {
        if (!sessionSource) return undefined;
        if ('peek' in sessionSource && typeof sessionSource.peek === 'function') {
            return sessionSource as ReadonlySignal<Session | null>;
        }
        if (typeof sessionSource === 'function') {
            return (sessionSource as () => ReadonlySignal<Session | null> | undefined)();
        }
        return undefined;
    }

    function shouldConnect(): boolean {
        const sig = getSessionSignal();
        if (sig === undefined) {
            return true;
        }
        return sig.peek() !== null;
    }

    function disconnect(): void {
        if (es !== null) {
            es.close();
            es = null;
        }
        openedOnce = false;
    }

    function ensureConnected(): EventSourceLike | null {
        if (isDisposed) return null;
        if (es !== null) return es;
        if (!shouldConnect()) return null;

        const source = factory!(url);
        es = source;

        const onOpen = () => {
            if (openedOnce) {
                // Reconnect!
                for (const r of Array.from(reconnectListeners)) {
                    r();
                }
            } else {
                openedOnce = true;
                for (const r of Array.from(firstOpenListeners)) {
                    r();
                }
            }
        };

        if (typeof source.addEventListener === 'function') {
            source.addEventListener('open', onOpen);
            source.addEventListener('reconnect', () => {
                for (const r of Array.from(reconnectListeners)) {
                    r();
                }
            });
            source.addEventListener('close', () => {
                if (es === source) {
                    es = null;
                    openedOnce = false;
                }
            });
        } else {
            source.onopen = onOpen;
        }

        const handleIncoming = (eventName: string, rawData: unknown) => {
            let data = rawData;
            if (typeof rawData === 'string') {
                try {
                    data = JSON.parse(rawData);
                } catch {
                    log?.(`models: dropped a '${eventName}' event that is not JSON`);
                    return;
                }
            }
            const listeners = eventListeners.get(eventName);
            if (listeners) {
                for (const listener of Array.from(listeners)) {
                    listener(data);
                }
            }
        };

        for (const [eventName] of eventListeners) {
            if (typeof source.addEventListener === 'function') {
                source.addEventListener(eventName, (event) => {
                    handleIncoming(eventName, event.data);
                });
            }
        }

        source.onmessage = (event) => {
            const evType = event.type || 'message';
            if (evType !== 'message') {
                handleIncoming(evType, event.data);
                return;
            }
            let parsed = event.data;
            if (typeof event.data === 'string') {
                try {
                    parsed = JSON.parse(event.data);
                } catch {
                    log?.(`models: dropped a stream message that is not JSON: ${event.data.slice(0, 200)}`);
                    return;
                }
            }
            const frame = StreamFrame.safeParse(parsed);
            if (frame.success) {
                handleIncoming(frame.data.event, frame.data.data ?? frame.data);
            } else {
                log?.('models: dropped a stream message with no event name');
            }
        };

        return source;
    }

    let sessionEffectDispose: (() => void) | null = null;
    if (sessionSource !== undefined) {
        sessionEffectDispose = runDetached(() => {
            let prevSession: Session | null | undefined = undefined;

            return effect(() => {
                const signal = getSessionSignal();
                const currentSession = signal ? signal() : null;

                if (prevSession === undefined) {
                    prevSession = currentSession;
                    if (currentSession !== null && (eventListeners.size > 0 || reconnectListeners.size > 0)) {
                        ensureConnected();
                    }
                    return;
                }

                const hadSession = prevSession !== null;
                const hasSession = currentSession !== null;
                const userChanged = prevSession !== null && currentSession !== null && prevSession.userId !== currentSession.userId;
                prevSession = currentSession;

                if (!hadSession && hasSession) {
                    // Session arrived (sign-in or restore from storage)
                    if (eventListeners.size > 0 || reconnectListeners.size > 0) {
                        ensureConnected();
                        for (const r of Array.from(reconnectListeners)) {
                            r();
                        }
                    }
                } else if (hadSession && !hasSession) {
                    // Sign-out
                    disconnect();
                } else if (userChanged) {
                    // Switched user
                    disconnect();
                    if (eventListeners.size > 0 || reconnectListeners.size > 0) {
                        ensureConnected();
                        for (const r of Array.from(reconnectListeners)) {
                            r();
                        }
                    }
                }
            });
        });
    }

    return {
        isAvailable: true,
        subscribe(eventName: string, handler: (payload: unknown) => void) {
            let listeners = eventListeners.get(eventName);
            const isFirst = !listeners;
            if (!listeners) {
                listeners = new Set();
                eventListeners.set(eventName, listeners);
            }
            listeners.add(handler);

            if (isFirst) {
                const source = ensureConnected();
                if (source && typeof source.addEventListener === 'function') {
                    source.addEventListener(eventName, (event) => {
                        let data = event.data;
                        if (typeof event.data === 'string') {
                            try {
                                data = JSON.parse(event.data);
                            } catch {
                                log?.(`models: dropped a '${eventName}' event that is not JSON`);
                                return;
                            }
                        }
                        const cur = eventListeners.get(eventName);
                        if (cur) {
                            for (const l of Array.from(cur)) {
                                l(data);
                            }
                        }
                    });
                }
            }

            return () => {
                const current = eventListeners.get(eventName);
                if (current) {
                    current.delete(handler);
                    if (current.size === 0) {
                        eventListeners.delete(eventName);
                    }
                }
            };
        },
        onReconnect(handler: () => void) {
            reconnectListeners.add(handler);
            ensureConnected();
            return () => {
                reconnectListeners.delete(handler);
            };
        },
        onFirstOpen(handler: () => void) {
            firstOpenListeners.add(handler);
            return () => {
                firstOpenListeners.delete(handler);
            };
        },
        close() {
            isDisposed = true;
            if (sessionEffectDispose !== null) {
                sessionEffectDispose();
                sessionEffectDispose = null;
            }
            disconnect();
            eventListeners.clear();
            reconnectListeners.clear();
            firstOpenListeners.clear();
        },
    };
}

export interface MeshCaller {
    /** Throws MeshCallError on failure -- matching net/client.ts's MeshClient.call. */
    call(action: string, input?: unknown): Promise<unknown>;
    readonly descriptor?: unknown;
    readonly eventSource?: EventSourceFactory;
    readonly origin?: string;
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
    readonly live: ReadonlySignal<boolean>;
} {
    Object.defineProperties(target, {
        data: { get: () => getQuery().data, enumerable: true, configurable: true },
        rows: { get: () => getQuery().rows, enumerable: true, configurable: true },
        loading: { get: () => getQuery().loading, enumerable: true, configurable: true },
        error: { get: () => getQuery().error, enumerable: true, configurable: true },
        empty: { get: () => getQuery().empty, enumerable: true, configurable: true },
        status: { get: () => getQuery().status, enumerable: true, configurable: true },
        live: { get: () => getQuery().live, enumerable: true, configurable: true },
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
    readonly live: ReadonlySignal<boolean>;
} {
    return true;
}

function createCollection<TCalls extends Record<string, AnyApiCall>, C extends string>(
    name: C,
    mesh: MeshCaller,
    session?: SessionSource,
    api?: unknown,
    streamClient?: EventStreamClient,
): CollectionHandle<TCalls, C> {
    type TItem = ItemOf<TCalls, C>;
    type TQuery = QueryOf<TCalls, C>;

    const activeQueries = new Set<CollectionQueryImpl<TItem, TQuery>>();

    const apiObj = (api ?? mesh.descriptor) as Api<Record<string, AnyApiCall & { readonly gate?: Gate }>> | undefined;
    const findCall = apiObj?.calls?.[`${name}.find`];
    const gate: Gate | undefined = findCall?.gate;

    const isStreamed = isCollectionStreamed(name, apiObj?.events) && (streamClient?.isAvailable ?? false);

    const streamCleanups: (() => void)[] = [];
    if (isStreamed && streamClient) {
        streamCleanups.push(
            streamClient.subscribe(`${name}.created`, (payload) => {
                for (const q of activeQueries) {
                    q.applyCreated(payload);
                }
            }),
            streamClient.subscribe(`${name}.updated`, (payload) => {
                for (const q of activeQueries) {
                    q.applyUpdated(payload);
                }
            }),
            streamClient.subscribe(`${name}.deleted`, (payload) => {
                for (const q of activeQueries) {
                    q.applyDeleted(payload);
                }
            }),
            streamClient.onReconnect(() => {
                for (const q of activeQueries) {
                    void q.refetch();
                }
            }),
            // A list that fetched before the stream first opened heard nothing in between — on
            // api.surfdns.net that was ~16 s, while the gateway checked each event's gate. Only
            // those refetch; a list whose first fetch comes after the open misses nothing.
            streamClient.onFirstOpen(() => {
                for (const q of activeQueries) {
                    if (q.hasFetched) void q.refetch();
                }
            }),
        );
    }

    const fetcher: QueryFetcher<TItem, TQuery> = async (queryInput) => {
        const action = `${name}.find`;
        const value = await mesh.call(action, queryInput);
        return isTypedArray<TItem>(value) ? value : [];
    };

    function instantiateQuery(
        qInput?: TQuery | (() => TQuery),
        bindScope = true,
    ): CollectionQuery<TItem, TQuery> {
        const queryImpl = new CollectionQueryImpl<TItem, TQuery>(fetcher, qInput, bindScope, session, gate, isStreamed);
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
            live: queryImpl.live,
            refetch: () => queryImpl.refetch(),
            dispose: () => queryImpl.dispose(),
        });
        return q;
    }

    let defaultQueryInstance: CollectionQuery<TItem, TQuery> | null = null;
    function getDefaultQuery(): CollectionQuery<TItem, TQuery> {
        if (defaultQueryInstance === null) {
            /**
             * **Detached, because this one is created by whoever reads it first.**
             *
             * The collection owns this query and disposes it in `handle.dispose`, so it must not
             * also be owned by whatever scope happened to be evaluating at the first read — which
             * is an accident of render order, not a lifetime anybody chose.
             *
             * The console found it: the first read of `parts` was inside a `computed` deriving an
             * error message, so the query's session effect belonged to that computed and died the
             * moment it re-evaluated — which the first successful fetch guaranteed. The collection
             * kept its rows, lost its effects, and never heard about a sign-out, so a signed-out
             * page went on showing the previous user's data. Constructing it there also threw
             * `Cannot write to a signal inside a computed`, because starting a fetch writes
             * `loading` — and that throw went into the computed's caller and was lost.
             */
            defaultQueryInstance = runDetached(() => instantiateQuery(undefined, false));
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
            for (const cleanup of streamCleanups) {
                cleanup();
            }
            streamCleanups.length = 0;
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
        // A write that went around this handle — a tool call such as `dns.record_create` — changed
        // rows the open lists hold. With a stream, its events bring the change; without one, the
        // lists must be refetched.
        afterWrite: () => (isStreamed ? Promise.resolve() : invalidate()),

        // A live collection's own writes are applied to its open lists from the result, and not
        // refetched: the event the write causes arrives next and is de-duplicated by id. Refetching
        // every open list after every write is what a collection without a stream has to do, and
        // it used to do it even with one.
        async create(...input: CreateInputOf<TCalls, C> extends void ? [] : [input: CreateInputOf<TCalls, C>]) {
            const action = `${name}.create`;
            const value = await mesh.call(action, input[0]);
            if (isStreamed) for (const q of activeQueries) q.applyCreated(value);
            else await invalidate();
            return value as CreateOutputOf<TCalls, C>;
        },

        async update(...input: UpdateInputOf<TCalls, C> extends void ? [] : [input: UpdateInputOf<TCalls, C>]) {
            const action = `${name}.update`;
            const value = await mesh.call(action, input[0]);
            if (isStreamed) for (const q of activeQueries) q.applyUpdated(value);
            else await invalidate();
            return value as UpdateOutputOf<TCalls, C>;
        },

        async delete(...input: DeleteInputOf<TCalls, C> extends void ? [] : [input: DeleteInputOf<TCalls, C>]) {
            const action = `${name}.delete`;
            const value = await mesh.call(action, input[0]);
            if (isStreamed) for (const q of activeQueries) q.applyDeleted(input[0]);
            else await invalidate();
            return value as DeleteOutputOf<TCalls, C>;
        },

        async get(...input: GetInputOf<TCalls, C> extends void ? [] : [input: GetInputOf<TCalls, C>]) {
            const action = `${name}.get`;
            return await mesh.call(action, input[0]) as GetOutputOf<TCalls, C>;
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
    session?: SessionSource,
    api?: A,
    options?: ModelsOptions,
): Models<A> {
    type TCalls = CallsOf<A>;
    const collections = new Map<string, { dispose(): void }>();

    const apiObj = (api ?? mesh.descriptor) as Api<Record<string, AnyApiCall & { readonly gate?: Gate }>> | undefined;
    const base = apiObj?.base ?? '/api';
    const origin = options?.origin ?? mesh.origin ?? '';
    const eventsUrl = origin ? `${origin}${base}/events` : `${base}/events`;

    const factory: EventSourceFactory | undefined =
        options?.eventSource ??
        mesh.eventSource ??
        (typeof EventSource !== 'undefined' ? (u: string) => new EventSource(u) : undefined);

    const streamClient = createEventStreamClient(eventsUrl, factory, session, options?.log);
    if (onDispose !== undefined) {
        onDispose(() => {
            streamClient.close();
        });
    }

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

        const created = createCollection<TCalls, K>(name, mesh, session, api, streamClient);
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
