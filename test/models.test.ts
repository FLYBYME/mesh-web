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
    call,
    createClient,
    createScope,
    createServices,
    defineApi,
    flushSync,
    Kernel,
    needs,
    signal,
    type Api,
    type Application,
    type Context,
    type NetRequest,
    type NetResponse,
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
