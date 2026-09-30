/**
 * The models capability — spec/network.md §5, roadmap A3.7.
 *
 * Tests:
 * 1. Compile-time typing:
 *    - Unknown collection name is a compile error (@ts-expect-error).
 *    - Missing 'models' in needs is a compile error (@ts-expect-error).
 *    - Query and mutation input/output types inferred from declared Api.
 * 2. Runtime status tracking:
 *    - loading -> ready / empty / error
 *    - Error preservation across failed refetches.
 * 3. Reactivity:
 *    - Signal changes in query function automatically trigger refetch.
 *    - Deduplication of concurrent in-flight requests.
 *    - Out-of-order response rejection.
 * 4. Automatic mutation invalidation:
 *    - create / update / delete trigger refetch of active queries in the collection.
 *    - Mutations on one collection do not invalidate other collections.
 * 5. Scope-bound disposal:
 *    - Disposing query or scope unregisters effects and stops background activity.
 */

import { describe, expect, it, vi } from 'vitest';
import { IoManager } from '../src/kernel/io.js';
import { createEventStreamClient } from '../src/models/models.js';
import {
    call,
    computed,
    createClient,
    createScope,
    createServices,
    defineApi,
    flushSync,
    App,
    Service,
    createAppRuntime,
    createContext,
    needs,
    recordingWindows,
    signal,
    type ReadonlySignal,
    withHeaders,
    type Api,
    type AnyApiCall,
    type Capabilities,
    type Models,
    type NetRequest,
    type NetResponse,
    type Session,
    type Transport,
} from '../src/index.js';

// ---------------------------------------------------------------------------- API descriptor

interface Part {
    readonly id: string;
    readonly name: string;
    readonly tag: string;
}

interface PartQuery {
    readonly tag?: string;
    readonly search?: string;
}

interface CreatePartInput {
    readonly name: string;
    readonly tag: string;
}

interface UpdatePartInput {
    readonly id: string;
    readonly name?: string;
}

interface DeletePartInput {
    readonly id: string;
}

interface StatRecord {
    readonly total: number;
}

/**
 * **A session provider, standing in for whatever a real site loads.**
 *
 * These tests used the framework's own `AuthExtension`, which has moved to mesh-core — a part a site
 * decides about is a part, and the kernel does not ship one. That turned out to make the tests
 * *better* rather than merely different: what is under test here is that `models` reacts to
 * `services.session`, and pinning it to one implementation tested the implementation as much as the
 * seam.
 *
 * This fills the same seam the real one does, through the same declared capability:
 * `credentials.attach(headers, session)`. Nothing about `models` knows which of them it is talking
 * to, which is the property the move exists to have.
 *
 * It also does it without mocking `fetch`. The three identity endpoints the old fixture had to fake
 * were incidental to every assertion below — the tests care that a ticket appears and requests
 * reload, not how it was obtained.
 */
const SessionBase = Service({ needs: needs('credentials') });

/** A session, as a service: the shape of the company site's `AuthService`, minus the API calls. */
class TestSession extends SessionBase {
    readonly session = signal<Session | null>(null);
    #ticket: string | undefined;

    constructor(...args: ConstructorParameters<typeof SessionBase>) {
        super(...args);
        // Attached once, before any request can be made — the lookup runs per request, so a ticket
        // that arrives later rides the next call rather than the next page load.
        this.cx.credentials.attach(
            (): Readonly<Record<string, string>> =>
                (this.#ticket === undefined ? {} : { authorization: `Bearer ${this.#ticket}` }),
            this.session,
        );
    }

    signIn(): void {
        this.#ticket = 'tk-alice';
        this.session.set({ userId: 'alice', displayName: 'Alice', roles: ['admin'], expiresAt: Date.now() + 3_600_000 });
    }

    signOut(): void {
        this.#ticket = undefined;
        this.session.set(null);
    }
}

/**
 * An App with a session service and `cx.models` for `api`, on `services` — both granted from one
 * context, as `startApp` would. Returns the collections and the session to sign in and out with.
 */
function signedApp<A extends Api<Record<string, AnyApiCall>>>(services: ReturnType<typeof createServices>, api: A): {
    readonly models: Models<A>;
    readonly auth: TestSession;
} {
    let grabbed: Models<A> | undefined;
    let auth: TestSession | undefined;
    const Base = Service({ needs: needs('models'), api, inject: { session: TestSession } });
    class Grab extends Base {
        constructor(...args: ConstructorParameters<typeof Base>) {
            super(...args);
            grabbed = this.cx.models;
            auth = this.inject.session;
        }
    }
    class Host extends App({ needs: needs('models', 'credentials'), api, services: [TestSession, Grab], routes: {} }) {}
    const io = new IoManager();
    createAppRuntime(Host, createContext({ id: 'app', declaredBy: 'app' }, ['models', 'credentials'], [], (t) => io.get(t), services, io, api).context);
    if (grabbed === undefined || auth === undefined) throw new Error('expected models and a session');
    return { models: grabbed, auth };
}

const siteApi = defineApi({
    id: 'site-models',
    exposure: 'sha256:models1234',
    calls: {
        'part.find': call<PartQuery, readonly Part[]>('GET', '/parts'),
        'part.get': call<{ id: string }, Part, 'not_found'>('GET', '/parts/get'),
        'part.create': call<CreatePartInput, Part, 'invalid_name'>('POST', '/parts'),
        'part.update': call<UpdatePartInput, Part, 'not_found'>('PUT', '/parts'),
        'part.delete': call<DeletePartInput, void, 'not_found'>('DELETE', '/parts'),
        'stat.find': call<void, readonly StatRecord[]>('GET', '/stats'),
    },
});

function jsonResponse(status: number, body: unknown): NetResponse {
    return {
        status,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    };
}

interface FakeTransportController {
    readonly transport: Transport;
    readonly sent: NetRequest[];
}

function createFakeTransport(handler: (req: NetRequest) => NetResponse | Promise<NetResponse>): FakeTransportController {
    const sent: NetRequest[] = [];
    return {
        sent,
        transport: {
            send: async (request: NetRequest) => {
                sent.push(request);
                return handler(request);
            },
        },
    };
}

// ---------------------------------------------------------------------------- Type-level assertions

describe('models capability type checking', () => {
    it('enforces that unknown collection names are compile errors', () => {
        type AppNeeds = readonly ['models'];
        // A unit's `this.cx` type for these needs and this API.
        type AppContext = Capabilities<AppNeeds, typeof siteApi>;

        const typeAssert = (cx: AppContext) => {
            // Valid collections compile cleanly
            const parts = cx.models('part');
            const stats = cx.models('stat');
            void parts;
            void stats;

            // @ts-expect-error 'nonexistent' is not a declared collection in siteApi
            cx.models('nonexistent');

            // @ts-expect-error 'stat' does not accept PartQuery
            cx.models('stat', { tag: 'invalid' });
        };
        expect(typeof typeAssert).toBe('function');
    });

    it('enforces that cx.models is absent without needs("models")', () => {
        type NoModelsNeeds = readonly ['mesh'];
        type NoModelsContext = Capabilities<NoModelsNeeds, typeof siteApi>;

        const typeAssert = (cx: NoModelsContext) => {
            // @ts-expect-error models is not declared in needs
            void cx.models;
        };
        expect(typeof typeAssert).toBe('function');
    });

    it('infers typed mutation inputs and outputs', () => {
        type AppNeeds = readonly ['models'];
        type AppContext = Capabilities<AppNeeds, typeof siteApi>;

        const typeAssert = (cx: AppContext) => {
            const parts = cx.models('part');

            // @ts-expect-error create requires name and tag
            void parts.create({ name: 'missing-tag' });

            // @ts-expect-error delete requires id
            void parts.delete({ invalid: true });
        };
        expect(typeof typeAssert).toBe('function');
    });
});

// ---------------------------------------------------------------------------- Runtime capability tests

/**
 * `cx.models` for `siteApi`, as an App is granted it: the broker's `createContext` (what `startApp`
 * calls), read through an app-model service so it arrives typed by the API — no cast. Replaces
 * booting a `Kernel` and a test Application only to capture their context.
 */
function modelsFor(services: ReturnType<typeof createServices>): Models<typeof siteApi> {
    let grabbed: Models<typeof siteApi> | undefined;
    const Base = Service({ needs: needs('models'), api: siteApi });
    class Grab extends Base {
        constructor(...args: ConstructorParameters<typeof Base>) {
            super(...args);
            grabbed = this.cx.models;
        }
    }
    class Host extends App({ needs: needs('models'), api: siteApi, services: [Grab], routes: {} }) {}
    const io = new IoManager();
    createAppRuntime(Host, createContext({ id: 'app', declaredBy: 'app' }, ['models'], [], (t) => io.get(t), services, io, siteApi).context);
    if (grabbed === undefined) throw new Error('expected cx.models');
    return grabbed;
}

describe('models capability, as an App is granted it', () => {
    /** Holds the collection — typed by the API through its spec, no cast. */
    let catalog: Catalog | undefined;
    const Base = Service({ needs: needs('models'), api: siteApi });
    class Catalog extends Base {
        readonly parts = this.cx.models('part');
        constructor(...args: ConstructorParameters<typeof Base>) {
            super(...args);
            catalog = this;
        }
    }
    class Host extends App({ needs: needs('models'), api: siteApi, services: [Catalog], routes: {} }) {}

    it('boots and provides cx.models bound to the declared API', async () => {
        const fake = createFakeTransport(() => jsonResponse(200, [{ id: 'p1', name: 'Part 1', tag: 't1' }]));
        const services = createServices();
        services.meshClient = (api) => createClient(api, { transport: fake.transport });

        // The broker builds the App's context exactly as `startApp` does.
        const io = new IoManager();
        const granted = createContext({ id: 'test-app', declaredBy: 'test-app' }, ['models'], [], (t) => io.get(t), services, io, siteApi).context;
        createAppRuntime(Host, granted);

        if (catalog === undefined) throw new Error('expected the catalog service to be constructed');
        const parts = catalog.parts;
        expect(parts.name).toBe('part');

        // Let the initial fetch resolve
        await parts.refetch();

        expect(parts.status()).toBe('ready');
        expect(parts.data()).toEqual([{ id: 'p1', name: 'Part 1', tag: 't1' }]);
        expect(parts.rows()).toEqual([{ id: 'p1', name: 'Part 1', tag: 't1' }]);
        expect(parts()).toEqual([{ id: 'p1', name: 'Part 1', tag: 't1' }]);
        expect(parts.loading()).toBe(false);
        expect(parts.empty()).toBe(false);
        expect(parts.error()).toBeNull();
    });

    it('refuses to build a context with models and no api to bind them to', () => {
        const io = new IoManager();
        expect(() => createContext({ id: 'bad', declaredBy: 'bad' }, ['models'], [], (t) => io.get(t), createServices(), io))
            .toThrow(/without declaring an api/);
    });
});

// ---------------------------------------------------------------------------- Status tracking and queries

describe('status tracking and query behavior', () => {
    const APP_NEEDS = needs('models', 'state');

    it('transitions through loading, ready, empty, and error states', async () => {
        let statusCode = 200;
        let responseBody: unknown = [{ id: 'p1', name: 'Widget', tag: 'metal' }];

        const fake = createFakeTransport(() => jsonResponse(statusCode, responseBody));
        const services = createServices();
        services.meshClient = (api) => createClient(api, { transport: fake.transport });

        const cx = { models: modelsFor(services) };

        const parts = cx.models('part');

        // Initial state before fetch settles is loading
        expect(parts.status()).toBe('loading');
        expect(parts.loading()).toBe(true);

        await parts.refetch();

        // Settles to ready with data
        expect(parts.status()).toBe('ready');
        expect(parts.loading()).toBe(false);
        expect(parts.empty()).toBe(false);
        expect(parts.data()?.length).toBe(1);

        // When API answers empty array
        responseBody = [];
        await parts.refetch();
        expect(parts.status()).toBe('empty');
        expect(parts.loading()).toBe(false);
        expect(parts.empty()).toBe(true);
        expect(parts.data()).toEqual([]);
        expect(parts.rows()).toEqual([]);

        // When API returns an error (403 forbidden)
        statusCode = 403;
        responseBody = { error: 'FORBIDDEN', message: 'Forbidden' };
        await parts.refetch();
        expect(parts.status()).toBe('error');
        expect(parts.loading()).toBe(false);
        expect(parts.error()).toEqual({ kind: 'forbidden' });
        // Empty array preserved from previous successful response
        expect(parts.data()).toEqual([]);
    });

    it('preserves existing data across failed refetches', async () => {
        let returnError = false;
        const fake = createFakeTransport(() => {
            if (returnError) {
                return jsonResponse(500, 'Server failure');
            }
            return jsonResponse(200, [{ id: 'p1', name: 'Preserved Part', tag: 'special' }]);
        });

        const services = createServices();
        services.meshClient = (api) => createClient(api, { transport: fake.transport });

        const cx = { models: modelsFor(services) };

        const parts = cx.models('part');
        await parts.refetch();

        expect(parts.status()).toBe('ready');
        expect(parts.data()).toEqual([{ id: 'p1', name: 'Preserved Part', tag: 'special' }]);

        // Now subsequent fetch fails
        returnError = true;
        await parts.refetch();

        expect(parts.status()).toBe('error');
        expect(parts.error()?.kind).toBe('server');
        // Old data remains accessible
        expect(parts.data()).toEqual([{ id: 'p1', name: 'Preserved Part', tag: 'special' }]);
        expect(parts.rows()).toEqual([{ id: 'p1', name: 'Preserved Part', tag: 'special' }]);
    });

    it('reacts to signal changes in query functions', async () => {
        const receivedQueries: string[] = [];
        const fake = createFakeTransport((req) => {
            receivedQueries.push(req.url);
            return jsonResponse(200, []);
        });

        const services = createServices();
        services.meshClient = (api) => createClient(api, { transport: fake.transport });

        const cx = { models: modelsFor(services) };

        const tagFilter = signal('widgets');
        const query = cx.models('part', () => ({ tag: tagFilter() }));

        await query.refetch();
        expect(receivedQueries[receivedQueries.length - 1]).toContain('tag=widgets');

        // Update the signal
        tagFilter.set('gadgets');
        flushSync();

        // Effect triggered refetch
        await query.refetch();
        expect(receivedQueries[receivedQueries.length - 1]).toContain('tag=gadgets');
    });

    it('rejects out-of-order responses so older requests do not overwrite newer responses', async () => {
        interface Deferred {
            resolve: (res: NetResponse) => void;
        }
        const deferreds: Deferred[] = [];

        const fake = createFakeTransport(() => {
            return new Promise<NetResponse>((resolve) => {
                deferreds.push({ resolve });
            });
        });

        const services = createServices();
        services.meshClient = (api) => createClient(api, { transport: fake.transport });

        const cx = { models: modelsFor(services) };

        const searchSignal = signal('query1');
        const query = cx.models('part', () => ({ search: searchSignal() }));

        // Initial request 1 is in-flight
        expect(deferreds.length).toBe(1);

        // Change signal to trigger request 2
        searchSignal.set('query2');
        flushSync();
        expect(deferreds.length).toBe(2);

        // Complete request 2 first with newer data
        deferreds[1]?.resolve(jsonResponse(200, [{ id: 'p2', name: 'Newer', tag: 'q2' }]));
        await new Promise((r) => setTimeout(r, 10));

        expect(query.data()).toEqual([{ id: 'p2', name: 'Newer', tag: 'q2' }]);

        // Now complete the older request 1 with older data
        deferreds[0]?.resolve(jsonResponse(200, [{ id: 'p1', name: 'Older', tag: 'q1' }]));
        await new Promise((r) => setTimeout(r, 10));

        // Data should NOT be overwritten by older request!
        expect(query.data()).toEqual([{ id: 'p2', name: 'Newer', tag: 'q2' }]);
    });
});

// ---------------------------------------------------------------------------- Mutation invalidation

describe('mutation invalidation', () => {
    const APP_NEEDS = needs('models', 'state');

    it('invalidates and refetches active queries belonging to the collection on create/update/delete', async () => {
        const store: Part[] = [
            { id: '1', name: 'Alpha', tag: 't1' },
            { id: '2', name: 'Beta', tag: 't2' },
        ];

        let findCalls = 0;
        const fake = createFakeTransport((req) => {
            if (req.url.startsWith('/api/parts') && req.method === 'GET') {
                findCalls++;
                return jsonResponse(200, [...store]);
            }
            if (req.url === '/api/parts' && req.method === 'POST') {
                const body = JSON.parse(req.body ?? '{}') as CreatePartInput;
                const created: Part = { id: String(store.length + 1), name: body.name, tag: body.tag };
                store.push(created);
                return jsonResponse(200, created);
            }
            if (req.url === '/api/parts' && req.method === 'PUT') {
                const body = JSON.parse(req.body ?? '{}') as UpdatePartInput;
                const idx = store.findIndex((p) => p.id === body.id);
                if (idx !== -1) {
                    const existing = store[idx]!;
                    store[idx] = { ...existing, name: body.name ?? existing.name };
                    return jsonResponse(200, store[idx]);
                }
                return jsonResponse(404, { error: 'not_found', declared: true });
            }
            if (req.url.startsWith('/api/parts') && req.method === 'DELETE') {
                const url = new URL(req.url, 'http://localhost');
                const id = url.searchParams.get('id');
                const idx = store.findIndex((p) => p.id === id);
                if (idx !== -1) {
                    store.splice(idx, 1);
                    return jsonResponse(200, undefined);
                }
                return jsonResponse(404, { error: 'not_found', declared: true });
            }
            return jsonResponse(200, []);
        });

        const services = createServices();
        services.meshClient = (api) => createClient(api, { transport: fake.transport });

        const cx = { models: modelsFor(services) };

        const parts = cx.models('part');
        await parts.refetch();
        expect(findCalls).toBe(1);
        expect(parts.data()?.length).toBe(2);

        // Create mutation -- success means the call resolves; a throw would fail this test on its own.
        await parts.create({ name: 'Gamma', tag: 't1' });

        // Verify invalidation triggered a refetch
        expect(findCalls).toBe(2);
        expect(parts.data()?.length).toBe(3);
        expect(parts.data()?.map((p) => p.name)).toContain('Gamma');

        // Update mutation
        await parts.update({ id: '1', name: 'Alpha Updated' });
        expect(findCalls).toBe(3);
        expect(parts.data()?.find((p) => p.id === '1')?.name).toBe('Alpha Updated');

        // Delete mutation
        await parts.delete({ id: '2' });
        expect(findCalls).toBe(4);
        expect(parts.data()?.length).toBe(2);
        expect(parts.data()?.find((p) => p.id === '2')).toBeUndefined();
    });

    it('does not invalidate other collections when one collection mutates', async () => {
        let partFinds = 0;
        let statFinds = 0;

        const fake = createFakeTransport((req) => {
            if (req.url.startsWith('/api/parts') && req.method === 'GET') {
                partFinds++;
                return jsonResponse(200, [{ id: '1', name: 'P1', tag: 't1' }]);
            }
            if (req.url === '/api/parts' && req.method === 'POST') {
                return jsonResponse(200, { id: '2', name: 'P2', tag: 't1' });
            }
            if (req.url.startsWith('/api/stats') && req.method === 'GET') {
                statFinds++;
                return jsonResponse(200, [{ total: 10 }]);
            }
            return jsonResponse(200, []);
        });

        const services = createServices();
        services.meshClient = (api) => createClient(api, { transport: fake.transport });

        const cx = { models: modelsFor(services) };

        const parts = cx.models('part');
        const stats = cx.models('stat');

        await parts.refetch();
        const initialStatFinds = statFinds;

        expect(partFinds).toBe(1);

        // Mutate parts
        await parts.create({ name: 'P2', tag: 't1' });

        // parts invalidated, but stats was NOT invalidated
        expect(partFinds).toBe(2);
        expect(statFinds).toBe(initialStatFinds);
    });
});

// ---------------------------------------------------------------------------- Scope-bound disposal

describe('scope-bound disposal', () => {
    it('cleans up queries and effects when parent scope disposes', async () => {
        let fetches = 0;
        const fake = createFakeTransport(() => {
            fetches++;
            return jsonResponse(200, []);
        });

        const client = createClient(siteApi, { transport: fake.transport });
        const scope = createScope();

        const filterSignal = signal('initial');

        const { createModels } = await import('../src/models/index.js');
        const models = createModels<typeof siteApi>(client);

        let query!: ReturnType<typeof models<'part'>>;
        scope.run(() => {
            query = models('part', () => ({ tag: filterSignal() }));
        });

        await query.refetch();
        expect(fetches).toBe(1);

        // Dispose the scope
        scope.dispose();

        // Updating signal should no longer trigger refetch
        filterSignal.set('changed');
        flushSync();

        await new Promise((r) => setTimeout(r, 10));
        expect(fetches).toBe(1);
    });
});

// ---------------------------------------------------------------------------- Session-aware collections

describe('session-aware collections', () => {
    it('reloads automatically when session transitions from absent to present after 401', async () => {
        const sessionSignal = signal<Session | null>(null);
        let fetchCount = 0;

        const fake = createFakeTransport((req) => {
            fetchCount++;
            if (!req.headers['authorization']) {
                return jsonResponse(401, { error: 'unauthorized' });
            }
            return jsonResponse(200, [{ id: 'p1', name: 'Alice Part', tag: 't1' }]);
        });

        const client = createClient(siteApi, {
            transport: {
                send: (req) => {
                    const session = sessionSignal.peek();
                    const headers = { ...req.headers };
                    if (session) {
                        headers['authorization'] = `Bearer ticket-${session.userId}`;
                    }
                    return fake.transport.send({ ...req, headers });
                },
            },
        });

        const { createModels } = await import('../src/models/index.js');
        const models = createModels<typeof siteApi>(client, undefined, sessionSignal);

        const parts = models('part');
        expect(parts.loading()).toBe(true);
        await new Promise((r) => setTimeout(r, 20));

        // Initially unauthenticated: failed with 401
        expect(fetchCount).toBe(1);
        expect(parts.status()).toBe('error');
        expect(parts.error()?.kind).toBe('unauthorized');
        expect(parts.rows()).toEqual([]);
        expect(parts.data()).toBeUndefined();

        // User signs in (session transitions absent -> present)
        sessionSignal.set({
            userId: 'alice',
            displayName: 'Alice',
            roles: ['user'],
            expiresAt: Date.now() + 10000,
        });
        flushSync();
        await new Promise((r) => setTimeout(r, 15));

        // Automatically reloaded with the new session
        expect(fetchCount).toBe(2);
        expect(parts.status()).toBe('ready');
        expect(parts.error()).toBeNull();
        expect(parts.rows()).toEqual([{ id: 'p1', name: 'Alice Part', tag: 't1' }]);
        expect(parts.data()).toEqual([{ id: 'p1', name: 'Alice Part', tag: 't1' }]);
    });

    it('clears data and rows on sign-out (present -> absent) without leaking data', async () => {
        const sessionSignal = signal<Session | null>({
            userId: 'alice',
            displayName: 'Alice',
            roles: ['user'],
            expiresAt: Date.now() + 10000,
        });
        let fetchCount = 0;

        const fake = createFakeTransport(() => {
            fetchCount++;
            return jsonResponse(200, [{ id: 'p1', name: 'Secret Part', tag: 'confidential' }]);
        });

        const client = createClient(siteApi, { transport: fake.transport });
        const { createModels } = await import('../src/models/index.js');
        const models = createModels<typeof siteApi>(client, undefined, sessionSignal);

        const parts = models('part');
        expect(parts.loading()).toBe(true);
        await new Promise((r) => setTimeout(r, 20));

        // Loaded with session
        expect(fetchCount).toBe(1);
        expect(parts.status()).toBe('ready');
        expect(parts.rows()).toHaveLength(1);
        expect(parts.data()).toBeDefined();

        // Sign-out (present -> absent)
        sessionSignal.set(null);
        flushSync();

        // Rows and data cleared immediately, status idle, no new fetch fired
        expect(parts.data()).toBeUndefined();
        expect(parts.rows()).toEqual([]);
        expect(parts.empty()).toBe(false);
        expect(parts.status()).toBe('idle');
        expect(parts.loading()).toBe(false);
        expect(fetchCount).toBe(1);
    });

    it('does not fire requests certain to fail for want of a session', async () => {
        const sessionSignal = signal<Session | null>(null);
        const filterSignal = signal('initial');
        let fetchCount = 0;

        const fake = createFakeTransport(() => {
            fetchCount++;
            return jsonResponse(401, { error: 'unauthorized' });
        });

        const client = createClient(siteApi, { transport: fake.transport });
        const { createModels } = await import('../src/models/index.js');
        const models = createModels<typeof siteApi>(client, undefined, sessionSignal);

        const parts = models('part', () => ({ search: filterSignal() }));
        await new Promise((r) => setTimeout(r, 15));

        expect(fetchCount).toBe(1);
        expect(parts.status()).toBe('error');
        expect(parts.error()?.kind).toBe('unauthorized');

        // Unrelated query signal changes while signed out: must not fire requests certain to fail
        filterSignal.set('changed');
        flushSync();
        await new Promise((r) => setTimeout(r, 15));
        expect(fetchCount).toBe(1);

        // Explicit manual refetch still attempts
        await parts.refetch();
        expect(fetchCount).toBe(2);
    });

    it('switches users (User A -> User B) without leaking rows across sessions', async () => {
        const sessionSignal = signal<Session | null>({
            userId: 'alice',
            displayName: 'Alice',
            roles: ['user'],
            expiresAt: Date.now() + 10000,
        });

        const fake = createFakeTransport((req) => {
            const authHeader = req.headers['authorization'];
            if (authHeader === 'Bearer ticket-alice') {
                return jsonResponse(200, [{ id: 'p-alice', name: 'Alice Doc', tag: 'private' }]);
            }
            if (authHeader === 'Bearer ticket-bob') {
                return jsonResponse(200, [{ id: 'p-bob', name: 'Bob Doc', tag: 'private' }]);
            }
            return jsonResponse(401, { error: 'unauthorized' });
        });

        const client = createClient(siteApi, {
            transport: {
                send: (req) => {
                    const session = sessionSignal();
                    const headers = { ...req.headers };
                    if (session) {
                        headers['authorization'] = `Bearer ticket-${session.userId}`;
                    }
                    return fake.transport.send({ ...req, headers });
                },
            },
        });

        const { createModels } = await import('../src/models/index.js');
        const models = createModels<typeof siteApi>(client, undefined, sessionSignal);

        const parts = models('part');
        expect(parts.loading()).toBe(true);
        await new Promise((r) => setTimeout(r, 20));

        expect(parts.status()).toBe('ready');
        expect(parts.rows()).toEqual([{ id: 'p-alice', name: 'Alice Doc', tag: 'private' }]);

        // User switches from Alice directly to Bob
        sessionSignal.set({
            userId: 'bob',
            displayName: 'Bob',
            roles: ['user'],
            expiresAt: Date.now() + 10000,
        });
        flushSync();
        await new Promise((r) => setTimeout(r, 15));

        expect(parts.status()).toBe('ready');
        expect(parts.rows()).toEqual([{ id: 'p-bob', name: 'Bob Doc', tag: 'private' }]);
    });

    it('boots cleanly and loads public collections on a site without AuthExtension', async () => {
        let fetches = 0;
        const fake = createFakeTransport(() => {
            fetches++;
            return jsonResponse(200, [{ id: 'pub1', name: 'Public Part', tag: 'public' }]);
        });

        const services = createServices();
        services.meshClient = (api) => createClient(api, { transport: fake.transport });

        // Nothing on this page signs anyone in: no credentials were ever attached.
        const cx = { models: modelsFor(services) };

        const parts = cx.models('part');
        expect(parts.loading()).toBe(true);
        await new Promise((r) => setTimeout(r, 20));

        expect(fetches).toBe(1);
        expect(parts.status()).toBe('ready');
        expect(parts.rows()).toEqual([{ id: 'pub1', name: 'Public Part', tag: 'public' }]);
    });

    it('reloads in-flight request when session arrives concurrently before 401 returns', async () => {
        const sessionSignal = signal<Session | null>(null);
        let resolveFirstFetch!: (resp: NetResponse) => void;
        let secondFetchFired = false;

        const fake = createFakeTransport((req) => {
            if (!req.headers['authorization']) {
                return new Promise<NetResponse>((resolve) => {
                    resolveFirstFetch = resolve;
                });
            }
            secondFetchFired = true;
            return jsonResponse(200, [{ id: 'p1', name: 'Concurrent Part', tag: 't1' }]);
        });

        const client = createClient(siteApi, {
            transport: {
                send: (req) => {
                    const session = sessionSignal();
                    const headers = { ...req.headers };
                    if (session) {
                        headers['authorization'] = `Bearer ticket-${session.userId}`;
                    }
                    return fake.transport.send({ ...req, headers });
                },
            },
        });

        const { createModels } = await import('../src/models/index.js');
        const models = createModels<typeof siteApi>(client, undefined, sessionSignal);

        const parts = models('part');
        // Initial fetch is in flight...
        expect(parts.loading()).toBe(true);

        // Session arrives WHILE the request is still pending
        sessionSignal.set({
            userId: 'alice',
            displayName: 'Alice',
            roles: ['user'],
            expiresAt: Date.now() + 10000,
        });

        // Now first fetch completes with 401 (since it was sent unauthenticated)
        resolveFirstFetch(jsonResponse(401, { error: 'unauthorized' }));
        await new Promise((r) => setTimeout(r, 15));

        // It should have detected that session arrived while in flight, and reloaded with the session
        expect(secondFetchFired).toBe(true);
        expect(parts.status()).toBe('ready');
        expect(parts.rows()).toEqual([{ id: 'p1', name: 'Concurrent Part', tag: 't1' }]);
    });

    it('integrates end-to-end with Kernel, AuthExtension, and Application models', async () => {
        let requestsCount = 0;

        // Mock global fetch for AuthExtension sign in / sign out / endpoints
        const origFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.endsWith('/api/identity/ticket') && init?.method === 'POST') {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ token: 'tk-alice', userId: 'alice', expiresAt: Date.now() + 3600000 }),
                } as unknown as Response;
            }
            if (url.endsWith('/api/identity/whoami')) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => ({ userId: 'alice', displayName: 'Alice', roles: ['admin'] }),
                } as unknown as Response;
            }
            if (url.endsWith('/api/identity/ticket/revoke')) {
                return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
            }
            return { ok: false, status: 404 } as unknown as Response;
        }) as typeof globalThis.fetch;

        try {
            const fake = createFakeTransport((req) => {
                requestsCount++;
                if (!req.headers['authorization']) {
                    return jsonResponse(401, { error: 'unauthorized' });
                }
                return jsonResponse(200, [{ id: 'p1', name: 'Alice Exclusive', tag: 't1' }]);
            });

            const services = createServices(recordingWindows(), { apiOrigin: 'https://test.local' });
            services.meshClient = (api) => createClient(api, {
                transport: withHeaders(fake.transport, () => services.credentials.headers?.() ?? {}),
            });

            const { models, auth } = signedApp(services, siteApi);

            const parts = models('part');
            expect(parts.loading()).toBe(true);
            await new Promise((r) => setTimeout(r, 20));

            // Initial fetch failed with 401
            expect(requestsCount).toBe(1);
            expect(parts.status()).toBe('error');
            expect(parts.error()?.kind).toBe('unauthorized');

            // Sign in
            const authApi = auth;
            authApi.signIn();
            flushSync();
            await new Promise((r) => setTimeout(r, 15));

            // Reloaded automatically
            expect(requestsCount).toBe(2);
            expect(parts.status()).toBe('ready');
            expect(parts.rows()).toEqual([{ id: 'p1', name: 'Alice Exclusive', tag: 't1' }]);

            // Sign out
            await authApi.signOut();
            flushSync();

            // Data cleared immediately
            expect(parts.status()).toBe('idle');
            expect(parts.rows()).toEqual([]);
            expect(parts.data()).toBeUndefined();
        } finally {
            globalThis.fetch = origFetch;
        }
    });

    describe('gate and session reactivity (FLYBYME/surfdns#56)', () => {
        const gatedApi = defineApi({
            id: 'gated-models',
            exposure: 'sha256:gated1234',
            calls: {
                'part.find': call<PartQuery, readonly Part[]>('GET', '/parts', { kind: 'role', role: 'user' }),
                'part.get': call<{ id: string }, Part, 'not_found'>('GET', '/parts/get'),
                'part.create': call<CreatePartInput, Part, 'invalid_name'>('POST', '/parts'),
                'part.update': call<UpdatePartInput, Part, 'not_found'>('PUT', '/parts'),
                'part.delete': call<DeletePartInput, void, 'not_found'>('DELETE', '/parts'),
            },
        });

        it('does not fire blind fetch when collection gate requires auth and session is absent', async () => {
            let requestsCount = 0;
            const fake = createFakeTransport((_req) => {
                requestsCount++;
                return jsonResponse(200, [{ id: 'p1', name: 'Gated Part', tag: 't1' }]);
            });

            const client = createClient(gatedApi, { transport: fake.transport });
            const sessionSignal = signal<Session | null>(null);

            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof gatedApi>(client, undefined, sessionSignal, gatedApi);

            const parts = models('part');
            expect(parts.status()).toBe('idle');
            expect(parts.loading()).toBe(false);
            expect(requestsCount).toBe(0);

            // When session arrives, it automatically fetches
            sessionSignal.set({
                userId: 'alice',
                displayName: 'Alice',
                roles: ['user'],
                expiresAt: Date.now() + 10000,
            });
            flushSync();
            await new Promise((r) => setTimeout(r, 15));

            expect(requestsCount).toBe(1);
            expect(parts.status()).toBe('ready');
            expect(parts.rows()).toEqual([{ id: 'p1', name: 'Gated Part', tag: 't1' }]);
        });

        it('binds reactive session effect at construction time before session is published by AuthExtension', async () => {
            let requestsCount = 0;
            const origFetch = globalThis.fetch;
            globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                if (url.endsWith('/api/identity/ticket') && init?.method === 'POST') {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({ token: 'tk-bob', userId: 'bob', expiresAt: Date.now() + 3600000 }),
                    } as unknown as Response;
                }
                if (url.endsWith('/api/identity/whoami')) {
                    return {
                        ok: true,
                        status: 200,
                        json: async () => ({ userId: 'bob', displayName: 'Bob', roles: ['user'] }),
                    } as unknown as Response;
                }
                return { ok: false, status: 404 } as unknown as Response;
            }) as typeof globalThis.fetch;

            try {
                const fake = createFakeTransport((_req) => {
                    requestsCount++;
                    return jsonResponse(200, [{ id: 'p1', name: 'Bob Part', tag: 't1' }]);
                });

                const services = createServices(recordingWindows(), { apiOrigin: 'https://test.local' });
                services.meshClient = (api) => createClient(api, {
                    transport: withHeaders(fake.transport, () => services.credentials.headers?.() ?? {}),
                });

                const { models, auth } = signedApp(services, gatedApi);

                // App creates collection query before sign-in:
                const parts = models('part');
                // Should not have fired blind request!
                expect(requestsCount).toBe(0);
                expect(parts.status()).toBe('idle');
                expect(parts.loading()).toBe(false);

                // Now sign in
                const authApi = auth;
                authApi.signIn();
                flushSync();
                await new Promise((r) => setTimeout(r, 15));

                // Should have reacted to session arrival and loaded data
                expect(requestsCount).toBe(1);
                expect(parts.status()).toBe('ready');
                expect(parts.rows()).toEqual([{ id: 'p1', name: 'Bob Part', tag: 't1' }]);
            } finally {
                globalThis.fetch = origFetch;
            }
        });
    });

    describe('live collections over SSE event stream (FLYBYME/surfdns#56)', () => {
        class MockEventSource {
            static instances: MockEventSource[] = [];
            public readonly url: string;
            public listeners = new Map<string, Set<(event: any) => void>>();
            public onopen: ((e: any) => void) | null = null;
            public onmessage: ((e: any) => void) | null = null;
            public onerror: ((e: any) => void) | null = null;
            public closed = false;

            constructor(url: string) {
                this.url = url;
                MockEventSource.instances.push(this);
            }

            addEventListener(type: string, listener: (event: any) => void) {
                if (!this.listeners.has(type)) {
                    this.listeners.set(type, new Set());
                }
                this.listeners.get(type)!.add(listener);
            }

            removeEventListener(type: string, listener: (event: any) => void) {
                this.listeners.get(type)?.delete(listener);
            }

            emit(type: string, data: any) {
                const event = { type, data: typeof data === 'string' ? data : JSON.stringify(data) };
                const set = this.listeners.get(type);
                if (set) {
                    for (const l of Array.from(set)) l(event);
                }
                if (this.onmessage && (type === 'message' || !set)) {
                    this.onmessage(event);
                }
            }

            open() {
                const event = { type: 'open' };
                this.onopen?.(event);
                const set = this.listeners.get('open');
                if (set) {
                    for (const l of Array.from(set)) l(event);
                }
            }

            close() {
                this.closed = true;
            }
        }

        const liveApi = defineApi({
            id: 'live-models',
            exposure: 'sha256:live1234',
            calls: {
                'part.find': call<PartQuery, readonly Part[]>('GET', '/parts'),
                'part.get': call<{ id: string }, Part, 'not_found'>('GET', '/parts/get'),
                'part.create': call<CreatePartInput, Part, 'invalid_name'>('POST', '/parts'),
                'part.update': call<UpdatePartInput, Part, 'not_found'>('PUT', '/parts'),
                'part.delete': call<DeletePartInput, void, 'not_found'>('DELETE', '/parts'),
                'stat.find': call<void, readonly StatRecord[]>('GET', '/stats'),
            },
            events: ['part.created', 'part.updated', 'part.deleted'],
        });

        it('reports live: true for streamed collections and live: false for non-streamed collections', async () => {
            MockEventSource.instances = [];
            const fake = createFakeTransport((req) => {
                if (req.url === '/api/parts') {
                    return jsonResponse(200, [{ id: 'p1', name: 'Part 1', tag: 't1' }]);
                }
                if (req.url === '/api/stats') {
                    return jsonResponse(200, [{ total: 42 }]);
                }
                return jsonResponse(404, {});
            });

            const client = createClient(liveApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof liveApi>(client, undefined, undefined, liveApi, {
                eventSource: (url) => new MockEventSource(url),
            });

            const parts = models('part');
            const stats = models('stat');
            expect(parts.loading()).toBe(true);
            expect(stats.loading()).toBe(true);

            await new Promise((r) => setTimeout(r, 20));

            expect(parts.live()).toBe(true);
            expect(stats.live()).toBe(false);
            expect(stats.status()).toBe('ready');
            expect(stats.rows()).toEqual([{ total: 42 }]);
        });

        it('delivers an event that is no collection\'s to models.on, over the one stream, until unsubscribed', async () => {
            MockEventSource.instances = [];
            const fake = createFakeTransport((req) => {
                if (req.url.startsWith('/api/parts')) return jsonResponse(200, []);
                return jsonResponse(404, {});
            });
            const client = createClient(liveApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof liveApi>(client, undefined, undefined, liveApi, {
                eventSource: (url) => new MockEventSource(url),
            });

            const parts = models('part');
            const got: unknown[] = [];
            const off = models.on('telemetry.live_updated', (payload) => got.push(payload));
            await new Promise((r) => setTimeout(r, 20));

            expect(MockEventSource.instances).toHaveLength(1);
            const es = MockEventSource.instances[0]!;
            es.emit('telemetry.live_updated', { at: 1, graphs: [] });
            expect(got).toEqual([{ at: 1, graphs: [] }]);
            expect(parts.live()).toBe(true);

            off();
            es.emit('telemetry.live_updated', { at: 2, graphs: [] });
            expect(got).toHaveLength(1);
        });

        it('applies created, updated, and deleted events live to collection rows', async () => {
            MockEventSource.instances = [];
            const fake = createFakeTransport((req) => {
                if (req.url.startsWith('/api/parts')) {
                    return jsonResponse(200, [{ id: 'p1', name: 'Initial Part', tag: 't1' }]);
                }
                return jsonResponse(404, {});
            });

            const client = createClient(liveApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof liveApi>(client, undefined, undefined, liveApi, {
                eventSource: (url) => new MockEventSource(url),
            });

            const parts = models('part');
            expect(parts.loading()).toBe(true);
            await new Promise((r) => setTimeout(r, 20));
            expect(parts.rows()).toEqual([{ id: 'p1', name: 'Initial Part', tag: 't1' }]);

            const es = MockEventSource.instances[0]!;
            expect(es).toBeDefined();
            expect(es.url).toBe('/api/events');

            // 1. Created event
            es.emit('part.created', { id: 'p2', name: 'Second Part', tag: 't1' });
            expect(parts.rows()).toEqual([
                { id: 'p1', name: 'Initial Part', tag: 't1' },
                { id: 'p2', name: 'Second Part', tag: 't1' },
            ]);
            expect(parts.status()).toBe('ready');
            expect(parts.empty()).toBe(false);

            // 2. Updated event (with { id, item } format)
            es.emit('part.updated', {
                id: 'p2',
                item: { id: 'p2', name: 'Second Part Modified', tag: 't1' },
            });
            expect(parts.rows()).toEqual([
                { id: 'p1', name: 'Initial Part', tag: 't1' },
                { id: 'p2', name: 'Second Part Modified', tag: 't1' },
            ]);

            // 3. Deleted event
            es.emit('part.deleted', { id: 'p1' });
            expect(parts.rows()).toEqual([
                { id: 'p2', name: 'Second Part Modified', tag: 't1' },
            ]);

            // Delete last item -> empty
            es.emit('part.deleted', { id: 'p2' });
            expect(parts.rows()).toEqual([]);
            expect(parts.empty()).toBe(true);
            expect(parts.status()).toBe('empty');
        });

        it('filters live events by query view and removes rows that no longer match', async () => {
            MockEventSource.instances = [];
            const fake = createFakeTransport((_req) => jsonResponse(200, []));

            const client = createClient(liveApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof liveApi>(client, undefined, undefined, liveApi, {
                eventSource: (url) => new MockEventSource(url),
            });

            const parts = models('part');
            const tag1Query = parts.find({ tag: 't1' });
            const tag2Query = parts.find({ tag: 't2' });
            await new Promise((r) => setTimeout(r, 20));

            const es = MockEventSource.instances[0]!;

            // Created with tag: 't1' -> only tag1Query receives it
            es.emit('part.created', { id: 'p1', name: 'Widget 1', tag: 't1' });
            expect(tag1Query.rows()).toEqual([{ id: 'p1', name: 'Widget 1', tag: 't1' }]);
            expect(tag2Query.rows()).toEqual([]);

            // Created with tag: 't2' -> only tag2Query receives it
            es.emit('part.created', { id: 'p2', name: 'Widget 2', tag: 't2' });
            expect(tag1Query.rows()).toEqual([{ id: 'p1', name: 'Widget 1', tag: 't1' }]);
            expect(tag2Query.rows()).toEqual([{ id: 'p2', name: 'Widget 2', tag: 't2' }]);

            // Updated: p1 moves from tag 't1' to 't2'
            es.emit('part.updated', {
                id: 'p1',
                item: { id: 'p1', name: 'Widget 1', tag: 't2' },
            });
            // tag1Query dropped it; tag2Query gained it
            expect(tag1Query.rows()).toEqual([]);
            expect(tag2Query.rows()).toEqual([
                { id: 'p2', name: 'Widget 2', tag: 't2' },
                { id: 'p1', name: 'Widget 1', tag: 't2' },
            ]);
        });

        it('deduplicates by ID so duplicate created events or local writes do not create duplicates', async () => {
            MockEventSource.instances = [];
            const fake = createFakeTransport((_req) =>
                jsonResponse(200, [{ id: 'p1', name: 'Original', tag: 't1' }]),
            );

            const client = createClient(liveApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof liveApi>(client, undefined, undefined, liveApi, {
                eventSource: (url) => new MockEventSource(url),
            });

            const parts = models('part');
            expect(parts.loading()).toBe(true);
            await new Promise((r) => setTimeout(r, 20));
            expect(parts.rows().length).toBe(1);

            const es = MockEventSource.instances[0]!;

            // Emit duplicate created event for already existing p1
            es.emit('part.created', { id: 'p1', name: 'Updated in place', tag: 't1' });
            expect(parts.rows().length).toBe(1);
            expect(parts.rows()[0]?.name).toBe('Updated in place');
        });

        // The real CRUD shape: `find({ query: { field }, sort })`, as every generated client has it.
        interface Rec { readonly id: string; readonly zone: string; readonly name: string; readonly createdAt: string }
        interface RecFind {
            readonly query?: { readonly zone?: string }; readonly sort?: string; readonly search?: string;
            readonly limit?: number; readonly offset?: number;
        }
        const crudApi = defineApi({
            id: 'crud-models',
            exposure: 'sha256:crud1234',
            calls: {
                'rec.find': call<RecFind, readonly Rec[]>('GET', '/recs'),
                'rec.create': call<Omit<Rec, 'id' | 'createdAt'>, Rec>('POST', '/recs'),
                'rec.update': call<{ id: string; name?: string }, Rec>('PUT', '/recs'),
                'rec.delete': call<{ id: string }, { success: boolean }>('DELETE', '/recs'),
            },
            events: ['rec.created', 'rec.updated', 'rec.deleted'],
        });
        const plainApi = defineApi({
            id: 'crud-plain',
            exposure: 'sha256:plain1234',
            calls: {
                'rec.find': call<RecFind, readonly Rec[]>('GET', '/recs'),
                'rec.create': call<Omit<Rec, 'id' | 'createdAt'>, Rec>('POST', '/recs'),
            },
        });

        it('applies events to a list filtered the CRUD way ({ query, sort }), in the list\'s order', async () => {
            MockEventSource.instances = [];
            const fake = createFakeTransport(() => jsonResponse(200, [
                { id: 'r1', zone: 'z1', name: 'old', createdAt: '2026-01-01' },
            ]));
            const client = createClient(crudApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof crudApi>(client, undefined, undefined, crudApi, {
                eventSource: (url) => new MockEventSource(url),
            });
            const zoneOne = models('rec').find({ query: { zone: 'z1' }, sort: '-createdAt' });
            await new Promise((r) => setTimeout(r, 20));
            const es = MockEventSource.instances[0]!;

            // In the filter: added — and first, because the list is newest first.
            es.emit('rec.created', { id: 'r2', zone: 'z1', name: 'new', createdAt: '2026-02-01' });
            expect(zoneOne.rows().map((r) => r.id)).toEqual(['r2', 'r1']);

            // Another zone's record: not this list's.
            es.emit('rec.created', { id: 'r3', zone: 'z2', name: 'elsewhere', createdAt: '2026-03-01' });
            expect(zoneOne.rows().map((r) => r.id)).toEqual(['r2', 'r1']);

            // Moved out of the filter by an update: leaves the list.
            es.emit('rec.updated', { id: 'r1', item: { id: 'r1', zone: 'z2', name: 'old', createdAt: '2026-01-01' } });
            expect(zoneOne.rows().map((r) => r.id)).toEqual(['r2']);
            zoneOne.dispose();
        });

        it('does not refetch after its own writes when live: the result, then the event, update the lists', async () => {
            MockEventSource.instances = [];
            let finds = 0;
            const fake = createFakeTransport((req) => {
                if (req.method === 'GET') { finds++; return jsonResponse(200, [{ id: 'r1', zone: 'z1', name: 'a', createdAt: '2026-01-01' }]); }
                if (req.method === 'POST') return jsonResponse(200, { id: 'r2', zone: 'z1', name: 'b', createdAt: '2026-02-01' });
                if (req.method === 'PUT') return jsonResponse(200, { id: 'r2', zone: 'z1', name: 'B', createdAt: '2026-02-01' });
                return jsonResponse(200, { success: true });
            });
            const client = createClient(crudApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof crudApi>(client, undefined, undefined, crudApi, {
                eventSource: (url) => new MockEventSource(url),
            });
            const recs = models('rec');
            const list = recs.find({ query: { zone: 'z1' }, sort: 'name' });
            await new Promise((r) => setTimeout(r, 20));
            expect(finds).toBe(1);

            await recs.create({ zone: 'z1', name: 'b' });
            expect(list.rows().map((r) => r.name)).toEqual(['a', 'b']);
            // The event for the same write: de-duplicated, not doubled.
            MockEventSource.instances[0]!.emit('rec.created', { id: 'r2', zone: 'z1', name: 'b', createdAt: '2026-02-01' });
            expect(list.rows()).toHaveLength(2);

            await recs.update({ id: 'r2', name: 'B' });
            expect(list.rows().map((r) => r.name)).toEqual(['B', 'a']);
            await recs.delete({ id: 'r1' });
            expect(list.rows().map((r) => r.id)).toEqual(['r2']);

            // Three writes, and still the one fetch that loaded the list.
            expect(finds).toBe(1);
            list.dispose();
        });

        it('keeps a limited list to its limit, and asks the server only for what it cannot know', async () => {
            MockEventSource.instances = [];
            let finds = 0;
            // The server's newest two, whatever has happened: what a refetch would answer.
            let server = [
                { id: 'r3', zone: 'z1', name: 'c', createdAt: '2026-03-01' },
                { id: 'r2', zone: 'z1', name: 'b', createdAt: '2026-02-01' },
                { id: 'r1', zone: 'z1', name: 'a', createdAt: '2026-01-01' },
            ];
            const fake = createFakeTransport((req) => {
                finds++;
                const offset = Number(new URL(req.url, 'http://x').searchParams.get('offset') ?? 0);
                return jsonResponse(200, server.slice(offset, offset + 2));
            });
            const client = createClient(crudApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof crudApi>(client, undefined, undefined, crudApi, {
                eventSource: (url) => new MockEventSource(url),
            });
            const newest = models('rec').find({ sort: '-createdAt', limit: 2 });
            await new Promise((r) => setTimeout(r, 20));
            expect(newest.rows().map((r) => r.id)).toEqual(['r3', 'r2']);
            const es = MockEventSource.instances[0]!;
            const fetched = finds;

            // A new row: placed first, the oldest pushed out — no fetch needed.
            const r4 = { id: 'r4', zone: 'z1', name: 'd', createdAt: '2026-04-01' };
            server = [r4, ...server];
            es.emit('rec.created', r4);
            expect(newest.rows().map((r) => r.id)).toEqual(['r4', 'r3']);
            expect(finds).toBe(fetched);

            // A row leaves a full page: gone at once, and the row that moves up comes from the server.
            server = server.filter((r) => r.id !== 'r4');
            es.emit('rec.deleted', { id: 'r4' });
            expect(newest.rows().map((r) => r.id)).toEqual(['r3']);
            await vi.waitFor(() => expect(newest.rows().map((r) => r.id)).toEqual(['r3', 'r2']));
            expect(finds).toBe(fetched + 1);

            // Past the first page, where a row lands depends on rows never fetched: refetched.
            const second = models('rec').find({ sort: '-createdAt', limit: 2, offset: 2 });
            await vi.waitFor(() => expect(second.rows().map((r) => r.id)).toEqual(['r1']));
            const before = finds;
            const r0 = { id: 'r0', zone: 'z1', name: 'z', createdAt: '2025-12-01' };
            server = [...server, r0];
            es.emit('rec.created', r0);
            await vi.waitFor(() => expect(second.rows().map((r) => r.id)).toEqual(['r1', 'r0']));
            expect(finds).toBeGreaterThan(before);
            newest.dispose();
            second.dispose();
        });

        it('still refetches after its own writes when the api streams nothing for the collection', async () => {
            let finds = 0;
            const fake = createFakeTransport((req) => {
                if (req.method === 'GET') { finds++; return jsonResponse(200, []); }
                return jsonResponse(200, { id: 'r9', zone: 'z1', name: 'x', createdAt: '2026-01-01' });
            });
            const client = createClient(plainApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof plainApi>(client, undefined, undefined, plainApi, {
                eventSource: (url) => new MockEventSource(url),
            });
            const recs = models('rec');
            const list = recs.find({ query: { zone: 'z1' } });
            await new Promise((r) => setTimeout(r, 20));
            expect(list.live()).toBe(false);
            await recs.create({ zone: 'z1', name: 'x' });
            expect(finds).toBe(2);
            // A write made around the handle (a tool call): refetched too, with nothing to say so.
            await recs.afterWrite();
            expect(finds).toBe(3);
            list.dispose();
        });

        it('refetches, when the stream first opens, the lists that fetched before it — only those', async () => {
            MockEventSource.instances = [];
            const fetched: string[] = [];
            const fake = createFakeTransport((req) => {
                fetched.push(new URL(req.url, 'http://x').searchParams.get('query') ?? 'all');
                return jsonResponse(200, []);
            });
            const client = createClient(crudApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof crudApi>(client, undefined, undefined, crudApi, {
                eventSource: (url) => new MockEventSource(url),
            });
            const early = models('rec').find({ query: { zone: 'early' } });
            await new Promise((r) => setTimeout(r, 20));
            expect(fetched).toHaveLength(1);

            // The stream opens late (the gateway was slow): anything written meanwhile was missed.
            MockEventSource.instances[0]!.emit('open', '');
            await new Promise((r) => setTimeout(r, 20));
            expect(fetched).toHaveLength(2);

            // A list opened after the stream is up misses nothing: one fetch.
            const late = models('rec').find({ query: { zone: 'late' } });
            await new Promise((r) => setTimeout(r, 20));
            expect(fetched).toHaveLength(3);
            early.dispose();
            late.dispose();
        });

        it('leaves a write made around a live handle to the event stream', async () => {
            MockEventSource.instances = [];
            let finds = 0;
            const fake = createFakeTransport(() => { finds++; return jsonResponse(200, []); });
            const client = createClient(crudApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof crudApi>(client, undefined, undefined, crudApi, {
                eventSource: (url) => new MockEventSource(url),
            });
            const recs = models('rec');
            const list = recs.find({ query: { zone: 'z1' } });
            await new Promise((r) => setTimeout(r, 20));
            await recs.afterWrite();
            expect(finds).toBe(1);
            MockEventSource.instances[0]!.emit('rec.created', { id: 'r1', zone: 'z1', name: 'by a tool', createdAt: '2026-01-01' });
            expect(list.rows().map((r) => r.name)).toEqual(['by a tool']);
            list.dispose();
        });

        it('resyncs active queries via refetch() on stream reconnect', async () => {
            MockEventSource.instances = [];
            let fetchCount = 0;
            const fake = createFakeTransport((_req) => {
                fetchCount++;
                return jsonResponse(200, [{ id: 'p1', name: `Fetch ${fetchCount}`, tag: 't1' }]);
            });

            const client = createClient(liveApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof liveApi>(client, undefined, undefined, liveApi, {
                eventSource: (url) => new MockEventSource(url),
            });

            const parts = models('part');
            expect(parts.loading()).toBe(true);
            await new Promise((r) => setTimeout(r, 20));
            expect(fetchCount).toBe(1);
            expect(parts.rows()[0]?.name).toBe('Fetch 1');

            const es = MockEventSource.instances[0]!;
            // Initial connection open, after the list's fetch: what was written in between was
            // never heard, so it refetches (see "refetches, when the stream first opens" above).
            es.open();
            await new Promise((r) => setTimeout(r, 20));
            expect(fetchCount).toBe(2);

            // Reconnection: open fires again
            es.open();
            await new Promise((r) => setTimeout(r, 20));
            expect(fetchCount).toBe(3);
            expect(parts.rows()[0]?.name).toBe('Fetch 3');
        });

        it('does not open event stream before login, connects on session arrival, and closes on sign-out', async () => {
            MockEventSource.instances = [];
            const fake = createFakeTransport((req) => {
                if (req.url.startsWith('/api/parts')) {
                    return jsonResponse(200, [{ id: 'p1', name: 'Initial Part', tag: 't1' }]);
                }
                return jsonResponse(404, {});
            });

            const sessionSignal = signal<Session | null>(null);
            const client = createClient(liveApi, { transport: fake.transport });
            const { createModels } = await import('../src/models/index.js');
            const models = createModels<typeof liveApi>(client, undefined, sessionSignal, liveApi, {
                eventSource: (url) => new MockEventSource(url),
            });

            const parts = models('part');
            expect(parts.loading()).toBe(true);
            await new Promise((r) => setTimeout(r, 20));

            // While session is null (logged out), NO EventSource connection should be created!
            expect(MockEventSource.instances.length).toBe(0);

            // Now log in (session arrives)
            sessionSignal.set({ userId: 'user-1', displayName: 'User One', roles: ['operator'], expiresAt: Date.now() + 60000 });
            await new Promise((r) => setTimeout(r, 20));

            // Now connection is established!
            expect(MockEventSource.instances.length).toBe(1);
            const es = MockEventSource.instances[0]!;
            expect(es.closed).toBe(false);

            // Streamed events work
            es.emit('part.created', { id: 'p2', name: 'Second Part', tag: 't1' });
            expect(parts.rows().length).toBe(2);

            // Log out (session becomes null)
            sessionSignal.set(null);
            await new Promise((r) => setTimeout(r, 20));

            // Connection should be closed!
            expect(es.closed).toBe(true);
            expect(parts.rows()).toEqual([]);

            // Log in as user 2
            sessionSignal.set({ userId: 'user-2', displayName: 'User Two', roles: ['operator'], expiresAt: Date.now() + 60000 });
            await new Promise((r) => setTimeout(r, 20));

            // A new EventSource connection should be created
            expect(MockEventSource.instances.length).toBe(2);
            const es2 = MockEventSource.instances[1]!;
            expect(es2.closed).toBe(false);
        });
    });
});

// ---------------------------------------------------------------------------- ownership of the default query

describe("a collection's default query is nobody else's to own", () => {
    /**
     * **A signed-out console kept showing the previous user's rows.**
     *
     * `models('part')` with no query returns the collection *handle*, whose query is built lazily on
     * the first read. In a console that first read is inside a `computed` — an error message derived
     * from `parts.error()` — so the query's session effect became owned by that computed, and was
     * disposed the moment it re-evaluated, which the first successful fetch guarantees. After that
     * the collection had rows, no effects, and no way to hear about a sign-out.
     *
     * Constructing it there also threw `Cannot write to a signal inside a computed`, because
     * starting a fetch writes `loading` — and the throw was swallowed by the computed's caller,
     * which is why this looked like a stale list rather than an error.
     *
     * The fix is `runDetached`: a thing the collection owns and disposes must not also be owned by
     * whoever happened to read it first. Same rule as `createDetachedScope`, one level down.
     */
    it('survives the computed that first read it, and still clears on sign-out', async () => {
        const gatedApi = defineApi({
            id: 'site-models-gated',
            exposure: 'sha256:models1234',
            calls: {
                'part.find': call<PartQuery, readonly Part[]>('GET', '/parts', { kind: 'role', role: 'user' }),
            },
        });

        const sessionSignal = signal<Session | null>(null);
        const fake = createFakeTransport(() => jsonResponse(
            200, [{ id: 'p1', name: 'Secret Part', tag: 'confidential' }],
        ));

        const client = createClient(gatedApi, { transport: fake.transport });
        const { createModels } = await import('../src/models/index.js');

        // The shape the kernel actually hands a contribution: a function returning a computed over
        // a holder, not the auth Extension's own signal.
        const holder = signal<ReadonlySignal<Session | null> | undefined>(sessionSignal);
        const kernelSession = computed<Session | null>(() => {
            const inner = holder();
            return inner ? inner() : null;
        });

        const models = createModels<typeof gatedApi>(client, undefined, () => kernelSession);
        const parts = models('part');

        // **The first read is inside a computed.** This is the line that broke it.
        const message = computed<string | null>(() => (parts.error() === null ? null : 'failed'));
        void message();
        void parts.rows();
        await new Promise((r) => setTimeout(r, 20));

        // Gated, no session: declined rather than fired blind.
        expect(parts.status()).toBe('idle');
        expect(fake.sent).toHaveLength(0);

        sessionSignal.set({
            userId: 'alice', displayName: 'Alice', roles: ['user'], expiresAt: Date.now() + 10_000,
        });
        flushSync();
        await new Promise((r) => setTimeout(r, 20));

        expect(parts.status()).toBe('ready');
        expect(parts.rows()).toHaveLength(1);

        // And the effect is still alive to hear this, which is the whole point.
        sessionSignal.set(null);
        flushSync();
        await new Promise((r) => setTimeout(r, 20));

        expect(parts.rows()).toEqual([]);
        expect(parts.status()).toBe('idle');
    });
});

describe('the stream edge: a frame that cannot be read is dropped and reported', () => {
    it('reports bad JSON and a frame with no event name, and still delivers good frames', () => {
        const sources: { onmessage?: ((event: { type?: string; data?: unknown }) => void) | null }[] = [];
        const reports: string[] = [];
        const client = createEventStreamClient(
            '/api/events',
            () => {
                const source = { onmessage: null, close: () => {} };
                sources.push(source);
                return source;
            },
            undefined,
            (message) => reports.push(message),
        );
        const got: unknown[] = [];
        client.subscribe('part.created', (payload) => got.push(payload));
        const send = sources[0]?.onmessage;
        expect(send).toBeTypeOf('function');

        send?.({ type: 'message', data: '{not json' });
        send?.({ type: 'message', data: JSON.stringify({ nameless: true }) });
        send?.({ type: 'message', data: JSON.stringify({ event: 'part.created', data: { id: 'p1' } }) });

        expect(got).toEqual([{ id: 'p1' }]);
        expect(reports).toHaveLength(2);
        expect(reports[0]).toContain('not JSON');
        expect(reports[1]).toContain('no event name');
        client.close();
    });
});
