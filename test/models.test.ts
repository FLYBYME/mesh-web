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

import { describe, expect, it } from 'vitest';
import {
    AUTH,
    AuthExtension,
    call,
    computed,
    consumes,
    createClient,
    createScope,
    createServices,
    defineApi,
    flushSync,
    Kernel,
    needs,
    recordingWindows,
    signal,
    type ReadonlySignal,
    withHeaders,
    type Api,
    type Application,
    type Context,
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
        type AppContext = Context<AppNeeds, readonly [], typeof siteApi>;

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
        type NoModelsContext = Context<NoModelsNeeds, readonly [], typeof siteApi>;

        const typeAssert = (cx: NoModelsContext) => {
            // @ts-expect-error models is not declared in needs
            void cx.models;
        };
        expect(typeof typeAssert).toBe('function');
    });

    it('infers typed mutation inputs and outputs', () => {
        type AppNeeds = readonly ['models'];
        type AppContext = Context<AppNeeds, readonly [], typeof siteApi>;

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

describe('models capability in Kernel', () => {
    const APP_NEEDS = needs('models', 'state');

    class TestApp implements Application<typeof APP_NEEDS, readonly [], undefined, typeof siteApi> {
        readonly needs = APP_NEEDS;
        readonly api = siteApi;

        startResult: Context<typeof APP_NEEDS, readonly [], typeof siteApi> | null = null;

        async start(cx: Context<typeof APP_NEEDS, readonly [], typeof siteApi>): Promise<void> {
            this.startResult = cx;
        }
    }

    it('boots and provides cx.models bound to the declared API', async () => {
        const fake = createFakeTransport(() => jsonResponse(200, [{ id: 'p1', name: 'Part 1', tag: 't1' }]));
        const services = createServices();
        services.meshClient = (api) => createClient(api, { transport: fake.transport });

        const kernel = new Kernel({ services });
        const app = new TestApp();
        kernel.boot([{ id: 'test-app', contribution: app }]);

        await kernel.start('test-app');

        expect(app.startResult).not.toBeNull();
        const cx = app.startResult!;
        const parts = cx.models('part');
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

    it('fails to start if models was declared without an api', async () => {
        const BAD_NEEDS = needs('models');
        class BadApp implements Application<typeof BAD_NEEDS> {
            readonly needs = BAD_NEEDS;
            async start(): Promise<void> {}
        }

        const kernel = new Kernel();
        kernel.boot([{ id: 'bad', contribution: new BadApp() }]);

        await expect(kernel.start('bad')).rejects.toThrow(/without declaring an api/);
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

        const kernel = new Kernel({ services });
        let capturedCx: Context<typeof APP_NEEDS, readonly [], typeof siteApi> | null = null;

        class App implements Application<typeof APP_NEEDS, readonly [], undefined, typeof siteApi> {
            readonly needs = APP_NEEDS;
            readonly api = siteApi;
            async start(cx: Context<typeof APP_NEEDS, readonly [], typeof siteApi>): Promise<void> {
                capturedCx = cx;
            }
        }

        kernel.boot([{ id: 'app', contribution: new App() }]);
        await kernel.start('app');
        const cx = capturedCx!;

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

        const kernel = new Kernel({ services });
        let cx!: Context<typeof APP_NEEDS, readonly [], typeof siteApi>;

        class App implements Application<typeof APP_NEEDS, readonly [], undefined, typeof siteApi> {
            readonly needs = APP_NEEDS;
            readonly api = siteApi;
            async start(startCx: Context<typeof APP_NEEDS, readonly [], typeof siteApi>): Promise<void> {
                cx = startCx;
            }
        }

        kernel.boot([{ id: 'app', contribution: new App() }]);
        await kernel.start('app');

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

        const kernel = new Kernel({ services });
        let cx!: Context<typeof APP_NEEDS, readonly [], typeof siteApi>;

        class App implements Application<typeof APP_NEEDS, readonly [], undefined, typeof siteApi> {
            readonly needs = APP_NEEDS;
            readonly api = siteApi;
            async start(startCx: Context<typeof APP_NEEDS, readonly [], typeof siteApi>): Promise<void> {
                cx = startCx;
            }
        }

        kernel.boot([{ id: 'app', contribution: new App() }]);
        await kernel.start('app');

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

        const kernel = new Kernel({ services });
        let cx!: Context<typeof APP_NEEDS, readonly [], typeof siteApi>;

        class App implements Application<typeof APP_NEEDS, readonly [], undefined, typeof siteApi> {
            readonly needs = APP_NEEDS;
            readonly api = siteApi;
            async start(startCx: Context<typeof APP_NEEDS, readonly [], typeof siteApi>): Promise<void> {
                cx = startCx;
            }
        }

        kernel.boot([{ id: 'app', contribution: new App() }]);
        await kernel.start('app');

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

        const kernel = new Kernel({ services });
        let cx!: Context<typeof APP_NEEDS, readonly [], typeof siteApi>;

        class App implements Application<typeof APP_NEEDS, readonly [], undefined, typeof siteApi> {
            readonly needs = APP_NEEDS;
            readonly api = siteApi;
            async start(startCx: Context<typeof APP_NEEDS, readonly [], typeof siteApi>): Promise<void> {
                cx = startCx;
            }
        }

        kernel.boot([{ id: 'app', contribution: new App() }]);
        await kernel.start('app');

        const parts = cx.models('part');
        await parts.refetch();
        expect(findCalls).toBe(1);
        expect(parts.data()?.length).toBe(2);

        // Create mutation
        const createRes = await parts.create({ name: 'Gamma', tag: 't1' });
        expect(createRes.ok).toBe(true);

        // Verify invalidation triggered a refetch
        expect(findCalls).toBe(2);
        expect(parts.data()?.length).toBe(3);
        expect(parts.data()?.map((p) => p.name)).toContain('Gamma');

        // Update mutation
        const updateRes = await parts.update({ id: '1', name: 'Alpha Updated' });
        expect(updateRes.ok).toBe(true);
        expect(findCalls).toBe(3);
        expect(parts.data()?.find((p) => p.id === '1')?.name).toBe('Alpha Updated');

        // Delete mutation
        const deleteRes = await parts.delete({ id: '2' });
        expect(deleteRes.ok).toBe(true);
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

        const kernel = new Kernel({ services });
        let cx!: Context<typeof APP_NEEDS, readonly [], typeof siteApi>;

        class App implements Application<typeof APP_NEEDS, readonly [], undefined, typeof siteApi> {
            readonly needs = APP_NEEDS;
            readonly api = siteApi;
            async start(startCx: Context<typeof APP_NEEDS, readonly [], typeof siteApi>): Promise<void> {
                cx = startCx;
            }
        }

        kernel.boot([{ id: 'app', contribution: new App() }]);
        await kernel.start('app');

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

        const kernel = new Kernel({ services });
        const APP_NEEDS = needs('models');

        let cx!: Context<typeof APP_NEEDS, readonly [], typeof siteApi>;
        class PublicApp implements Application<typeof APP_NEEDS, readonly [], undefined, typeof siteApi> {
            readonly needs = APP_NEEDS;
            readonly api = siteApi;
            async start(startCx: Context<typeof APP_NEEDS, readonly [], typeof siteApi>): Promise<void> {
                cx = startCx;
            }
        }

        // Boot WITHOUT AuthExtension
        kernel.boot([{ id: 'pub-app', contribution: new PublicApp() }]);
        await kernel.start('pub-app');

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

            const kernel = new Kernel({ services });
            const authExt = new AuthExtension();

            const APP_NEEDS = needs('models');
            const APP_CONSUMES = consumes(AUTH);

            let appCx!: Context<typeof APP_NEEDS, typeof APP_CONSUMES, typeof siteApi>;
            class SecretApp implements Application<typeof APP_NEEDS, typeof APP_CONSUMES, undefined, typeof siteApi> {
                readonly needs = APP_NEEDS;
                readonly consumes = APP_CONSUMES;
                readonly api = siteApi;
                readonly session = 'required' as const;

                async start(cx: Context<typeof APP_NEEDS, typeof APP_CONSUMES, typeof siteApi>): Promise<void> {
                    appCx = cx;
                }
            }

            kernel.boot([
                { id: 'auth', contribution: authExt },
                { id: 'app', contribution: new SecretApp() },
            ]);
            await kernel.start('app');

            const parts = appCx.models('part');
            expect(parts.loading()).toBe(true);
            await new Promise((r) => setTimeout(r, 20));

            // Initial fetch failed with 401
            expect(requestsCount).toBe(1);
            expect(parts.status()).toBe('error');
            expect(parts.error()?.kind).toBe('unauthorized');

            // Sign in
            const authApi = appCx.use(AUTH);
            await authApi.signIn({ email: 'alice@test.local', password: 'secret' });
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
                'part.find': call<PartQuery, readonly Part[]>('GET', '/parts', { kind: 'auth', level: 'user' }),
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

                const kernel = new Kernel({ services });
                const authExt = new AuthExtension();

                const APP_NEEDS = needs('models');
                const APP_CONSUMES = consumes(AUTH);

                let appCx!: Context<typeof APP_NEEDS, typeof APP_CONSUMES, typeof gatedApi>;
                class GatedApp implements Application<typeof APP_NEEDS, typeof APP_CONSUMES, undefined, typeof gatedApi> {
                    readonly needs = APP_NEEDS;
                    readonly consumes = APP_CONSUMES;
                    readonly api = gatedApi;
                    readonly session = 'required' as const;

                    async start(cx: Context<typeof APP_NEEDS, typeof APP_CONSUMES, typeof gatedApi>): Promise<void> {
                        appCx = cx;
                    }
                }

                kernel.boot([
                    { id: 'auth', contribution: authExt },
                    { id: 'app', contribution: new GatedApp() },
                ]);
                await kernel.start('app');

                // App creates collection query before sign-in:
                const parts = appCx.models('part');
                // Should not have fired blind request!
                expect(requestsCount).toBe(0);
                expect(parts.status()).toBe('idle');
                expect(parts.loading()).toBe(false);

                // Now sign in
                const authApi = appCx.use(AUTH);
                await authApi.signIn({ email: 'bob@test.local', password: 'secret' });
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
            // Initial connection open
            es.open();
            expect(fetchCount).toBe(1);

            // Reconnection: open fires again
            es.open();
            await new Promise((r) => setTimeout(r, 20));
            expect(fetchCount).toBe(2);
            expect(parts.rows()[0]?.name).toBe('Fetch 2');
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
                'part.find': call<PartQuery, readonly Part[]>('GET', '/parts', { kind: 'auth', level: 'user' }),
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
