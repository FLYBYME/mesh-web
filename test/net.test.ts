/**
 * The typed network layer — spec/network.md, roadmap A3.1a and A3.1c.
 *
 * Two things are under test and they are not the same thing. The runtime half is ordinary: a request
 * is built, a response becomes a result, a status becomes a named failure. The type half is the
 * point of the exercise, and it is tested the way spec/type-safety.md section 5 says to — with
 * `@ts-expect-error`, which fails the build if the thing it guards ever starts compiling.
 */

import { describe, expect, it } from 'vitest';

import {
    Kernel, call, createClient, createServices, defineApi, describe as describeError, diffExposure, exposureDifference, fetchApiSpec,
    needs, provider, toApiSpec, withHeaders,
    type Api, type Application, type Context, type ExposureDescriptor, type ExposureDifference, type NetRequest, type NetResponse, type Transport, KEEPS_NOTHING,
} from '../src/index.js';

// ---------------------------------------------------------------------------- a generated API

/**
 * What the generator will emit, written by hand.
 *
 * Note what is *not* here: no zod, no schema import, no reference into another package's types.
 * spec/network.md section 3.1 — surfdns #15 was a `z.infer` reaching across a package boundary, and
 * the fix is that a generated file states the shapes it means.
 */
interface Credential {
    readonly id: string;
    readonly name: string;
    readonly provider: 'cloudflare' | 'route53';
    readonly createdAt: number;
}

interface Session {
    readonly userId: string;
    readonly roles: readonly string[];
}

const siteApi = defineApi({
    id: 'surfdns',
    // Deliberately different values. The staleness check compares `shapeHash` against
    // `x-exposure-shape`; if it ever regresses to comparing `exposure` against `x-exposure`, these
    // being equal would have hidden it — which is exactly how the original defect survived.
    exposure: 'sha256:gate-hash',
    shapeHash: 'sha256:abc123',
    calls: {
        'credential.resolve': call<{ id: string }, Credential, 'revoked'>('GET', '/credential/resolve'),
        'credential.create': call<{ name: string; provider: string }, Credential>('POST', '/credential'),
        'session.whoami': call<void, Session>('GET', '/session/whoami'),
        // Parameterised, because five of the console's eighteen calls are and not one of them
        // worked: the path was sent with `:id` still in it.
        'credential.get': call<{ id: string }, Credential>('GET', '/credentials/:id'),
        'site.deploy': call<{ host: string; release: string }, { changed: boolean }>(
            'POST', '/sites/:host/deploy'),
    },
});

// ---------------------------------------------------------------------------- a transport for tests

interface Recorded {
    readonly sent: NetRequest[];
    readonly transport: Transport;
}

function fakeTransport(reply: (request: NetRequest) => NetResponse | Promise<NetResponse>): Recorded {
    const sent: NetRequest[] = [];
    return {
        sent,
        transport: {
            async send(request: NetRequest): Promise<NetResponse> {
                sent.push(request);
                return reply(request);
            },
        },
    };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): NetResponse => ({
    status,
    headers,
    body: JSON.stringify(body),
});

// ---------------------------------------------------------------------------- the type story

describe('the types are the feature', () => {
    it('infers input and output from the action name', async () => {
        const fake = fakeTransport(() =>
            json(200, { id: 'c1', name: 'prod', provider: 'cloudflare', createdAt: 1 }));
        const client = createClient(siteApi, { transport: fake.transport });

        const result = await client.call('credential.resolve', { id: 'c1' });

        if (!result.ok) throw new Error('expected ok');

        // Inferred, not asserted. If `value` were `unknown` these would not compile, which is the
        // whole claim: `cred` has full types, exactly as `ctx.call` does inside the mesh.
        const name: string = result.value.name;
        const provider: 'cloudflare' | 'route53' = result.value.provider;
        expect([name, provider]).toEqual(['prod', 'cloudflare']);
    });

    it('will not accept an action the site does not expose', async () => {
        const client = createClient(siteApi, { transport: fakeTransport(() => json(200, {})).transport });

        // spec/network.md section 3.3 — the descriptor names what is exposed, so this is a compile
        // error rather than a 404 discovered by a user.
        // @ts-expect-error "credential.delete" is not in the exposure descriptor
        await client.call('credential.delete', { id: 'c1' });
    });

    it('will not accept the wrong input shape', async () => {
        const client = createClient(siteApi, { transport: fakeTransport(() => json(200, {})).transport });

        // @ts-expect-error credential.resolve takes { id: string }, not { name: string }
        await client.call('credential.resolve', { name: 'prod' });

        // @ts-expect-error id is a string
        await client.call('credential.resolve', { id: 7 });
    });

    it('takes no second argument when a call declares no input', async () => {
        const fake = fakeTransport(() => json(200, { userId: 'u1', roles: ['user'] }));
        const client = createClient(siteApi, { transport: fake.transport });

        // No `undefined`, no `{}` — `void` input means the argument is absent from the signature.
        const result = await client.call('session.whoami');
        expect(result.ok && result.value.roles).toEqual(['user']);
    });

    it('keeps two APIs from shadowing each other', async () => {
        const other = defineApi({
            id: 'billing',
            exposure: 'sha256:zzz',
            calls: { 'invoice.get': call<{ id: string }, { total: number }>('GET', '/invoice') },
        });

        const client = createClient(other, { transport: fakeTransport(() => json(200, { total: 1 })).transport });

        // spec/network.md section 3.2: scoped to a declared API, not `declare global`. An action
        // from the other API is not in this one's union.
        // @ts-expect-error "credential.resolve" belongs to surfdns, not billing
        await client.call('credential.resolve', { id: 'c1' });
    });

    it('makes the value unreachable until the failure has been considered', async () => {
        const client = createClient(siteApi, { transport: fakeTransport(() => json(404, {})).transport });
        const result = await client.call('credential.resolve', { id: 'c1' });

        // roadmap A3.1c. `value` does not exist on the union until `ok` narrows it.
        // @ts-expect-error value is not available before the check
        void result.value;

        if (result.ok) return;
        expect(result.error.kind).toBe('not_found');
    });
});

// ---------------------------------------------------------------------------- requests

describe('a call becomes a request', () => {
    /**
     * The generated client emits a third argument now, and this kernel has to accept it.
     *
     * mesh-serve started writing the gate as a runtime literal — `call<I, O>("GET", "/parts",
     * { kind: 'auth', level: 'user' })` — while `call()` took two parameters. Every regenerated
     * client in every repository stopped compiling with "Expected 2 arguments, but got 3", and the
     * failure was in generated code, which is the last place anybody looks for a kernel change.
     *
     * Optional, and a client generated before this existed still compiles: an older client against
     * a newer kernel is the ordinary case during a rolling upgrade.
     */
    it('accepts a gate from a generated client, and carries it as data', () => {
        const gated = defineApi({
            id: 'surfdns',
            exposure: 'sha256:gate',
            shapeHash: 'sha256:shape',
            calls: {
                'part.find': call<void, unknown>('GET', '/parts', { kind: 'auth', level: 'user' }),
                'zone.delete': call<void, unknown>('DELETE', '/zones/:id',
                    { kind: 'permission', permission: 'domains.delete' }),
                // No gate: what a client generated before this existed looks like.
                'session.whoami': call<void, unknown>('GET', '/session/whoami'),
            },
        });

        expect(gated.calls['part.find'].gate).toEqual({ kind: 'auth', level: 'user' });
        expect(gated.calls['zone.delete'].gate)
            .toEqual({ kind: 'permission', permission: 'domains.delete' });
        expect(gated.calls['session.whoami'].gate).toBeUndefined();
    });

    it('puts a GET input in the query string', async () => {
        const fake = fakeTransport(() => json(200, {}));
        await createClient(siteApi, { transport: fake.transport }).call('credential.resolve', { id: 'c1' });

        expect(fake.sent[0]!.url).toBe('/api/credential/resolve?id=c1');
        expect(fake.sent[0]!.body).toBeUndefined();
    });

    it('puts a POST input in the body, with a content type', async () => {
        const fake = fakeTransport(() => json(200, {}));
        await createClient(siteApi, { transport: fake.transport })
            .call('credential.create', { name: 'prod', provider: 'cloudflare' });

        expect(fake.sent[0]!.method).toBe('POST');
        expect(JSON.parse(fake.sent[0]!.body!)).toEqual({ name: 'prod', provider: 'cloudflare' });
        expect(fake.sent[0]!.headers['content-type']).toBe('application/json');
    });

    it('sends no query at all when a call takes no input', async () => {
        const fake = fakeTransport(() => json(200, {}));
        await createClient(siteApi, { transport: fake.transport }).call('session.whoami');
        expect(fake.sent[0]!.url).toBe('/api/session/whoami');
    });

    /**
     * Reported as a 404 on `POST /api/sites/:host/deploy` — with `:host` in the request URL,
     * literally. Nothing substituted path parameters, so every parameterised call asked for a route
     * that cannot exist and got told the endpoint does not exist. Five of the console's calls:
     * `part.get`, `partVersion.get`, `release.get`, `site.get` and `cdn.deploy`.
     *
     * It survived because the consoles list with `find` and select client-side, so the screens that
     * would have made these calls never did.
     */
    it('puts the input into the path, and does not repeat it in the query', async () => {
        const fake = fakeTransport(() => json(200, {}));
        await createClient(siteApi, { transport: fake.transport }).call('credential.get', { id: 'c1' });

        expect(fake.sent[0]!.url).toBe('/api/credentials/c1');
    });

    it('fills a path parameter on a body-carrying method, and keeps the body whole', async () => {
        const fake = fakeTransport(() => json(200, {}));
        await createClient(siteApi, { transport: fake.transport })
            .call('site.deploy', { host: 'console.localhost', release: 'sha256:abc' });

        expect(fake.sent[0]!.url).toBe('/api/sites/console.localhost/deploy');
        // Still in the body: the server merges path params last and takes the URL's value, so the
        // two cannot disagree, and stripping it would be a second rule to keep in step.
        expect(JSON.parse(fake.sent[0]!.body!))
            .toEqual({ host: 'console.localhost', release: 'sha256:abc' });
    });

    it('encodes a path value rather than letting it change the route', async () => {
        const fake = fakeTransport(() => json(200, {}));
        await createClient(siteApi, { transport: fake.transport }).call('credential.get', { id: 'a/b c' });

        expect(fake.sent[0]!.url).toBe('/api/credentials/a%2Fb%20c');
    });

    it('throws when a path parameter has no value, rather than requesting the template', async () => {
        const fake = fakeTransport(() => json(200, {}));
        const client = createClient(siteApi, { transport: fake.transport });

        // The whole cost of the original bug was that this looked like a server routing fault.
        await expect(
            client.call('credential.get', { id: undefined as unknown as string }),
        ).rejects.toThrow(/needs "id"/);

        expect(fake.sent).toHaveLength(0);
    });

    it('lets a wrapper attach a ticket, so no Application ever handles one', async () => {
        const fake = fakeTransport(() => json(200, {}));
        let ticket = 't1';

        const client = createClient(siteApi, {
            transport: withHeaders(fake.transport, () => ({ authorization: `Bearer ${ticket}` })),
        });

        await client.call('session.whoami');
        ticket = 't2';            // refreshed, as a real one is
        await client.call('session.whoami');

        // A value captured once would have gone stale here, which is the case that matters.
        expect(fake.sent.map((r) => r.headers['authorization']))
            .toEqual(['Bearer t1', 'Bearer t2']);
    });
});

// ---------------------------------------------------------------------------- failures

describe('failures are named, not numbered', () => {
    const failsWith = async (response: NetResponse) => {
        const client = createClient(siteApi, { transport: fakeTransport(() => response).transport });
        const result = await client.call('credential.resolve', { id: 'c1' });
        if (result.ok) throw new Error('expected a failure');
        return result.error;
    };

    it('maps the statuses a caller decides differently about', async () => {
        expect(await failsWith(json(401, {}))).toEqual({ kind: 'unauthorized' });
        expect(await failsWith(json(403, {}))).toEqual({ kind: 'forbidden' });
        expect(await failsWith(json(404, {}))).toEqual({ kind: 'not_found' });
        expect((await failsWith(json(429, {}))).kind).toBe('rate_limited');
        expect(await failsWith(json(503, 'down'))).toEqual({ kind: 'server', status: 503, detail: 'down' });
    });

    it('carries a failure the exposure declared', async () => {
        const error = await failsWith(json(409, {
            error: 'revoked',
            message: 'That credential was revoked.',
            declared: true,
        }));

        expect(error).toEqual({ kind: 'declared', name: 'revoked', detail: 'That credential was revoked.' });

        // The declared name is a literal in the type, so a switch over it is checked.
        if (error.kind === 'declared') {
            const name: 'revoked' = error.name;
            expect(name).toBe('revoked');
        }
    });

    /**
     * The bug the first real request found.
     *
     * This used to read *any* body with a string `error` as a declared failure — and mesh-api answers
     * a gate refusal with exactly that shape, `{ error: 'UNAUTHENTICATED', message }`. So every 401
     * and 403 arrived as `kind: 'declared'` with `name: 'UNAUTHENTICATED'`, and a caller checking
     * `error.kind === 'unauthorized'` to prompt a sign-in never fired.
     *
     * Neither side was wrong alone, and neither side's tests could see it: this file's fake server
     * only ever produced one of the two shapes. It took one real browser calling one real API.
     */
    it('does not mistake a gate refusal for a declared failure', async () => {
        expect(await failsWith(json(401, { error: 'UNAUTHENTICATED', message: 'Sign in.' })))
            .toEqual({ kind: 'unauthorized' });

        expect(await failsWith(json(403, { error: 'FORBIDDEN', message: 'No post.write.' })))
            .toEqual({ kind: 'forbidden' });

        // A declared failure is marked, so a site may answer one with whatever status suits it.
        expect(await failsWith(json(404, { error: 'not_found', message: 'No such post.', declared: true })))
            .toEqual({ kind: 'declared', name: 'not_found', detail: 'No such post.' });
    });

    it('reports the API’s own message rather than the raw body', async () => {
        expect(await failsWith(json(400, { error: 'INVALID_INPUT', message: 'id: Required' })))
            .toEqual({ kind: 'invalid', detail: 'id: Required' });
    });

    it('reports a transport failure rather than throwing', async () => {
        const client = createClient(siteApi, {
            transport: { send: () => Promise.reject(new Error('network down')) },
        });

        const result = await client.call('session.whoami');
        expect(result.ok).toBe(false);
        expect(!result.ok && result.error).toEqual({ kind: 'offline', detail: 'network down' });
    });

    it('refuses to speak to an API whose shapes have moved on', async () => {
        // spec/network.md section 6. The client was generated from one set of shapes; the API
        // reports another. Saying so once is better than a confusing 404 three calls later.
        const stale = await failsWith(json(200, {}, { 'x-exposure-shape': 'sha256:different' }));
        expect(stale).toEqual({ kind: 'stale', expected: 'sha256:abc123', actual: 'sha256:different' });
    });

    it('ignores the gate hash, because a generated client cannot know it', async () => {
        /**
         * The defect this file did not catch, and the reason it did not.
         *
         * `x-exposure` is the **gate** hash — what a site exposes and at what level. A part
         * declares what it *calls* and never the gate it runs at, so `mesh-serve client` writes
         * `auth: 'public'` uniformly and a generated client's `exposure` is computed over that
         * placeholder. The two cannot match by construction.
         *
         * Comparing them meant **every gated site answered `stale` forever**: the request
         * succeeded, the response arrived, and the client discarded it. Found on
         * `console.localhost`, where dev tools showed successful requests and a view that never
         * updated. The old tests passed because the fixture used one hash for both roles.
         */
        const client = createClient(siteApi, {
            transport: fakeTransport(() => json(200, { userId: 'u1', roles: [] }, {
                'x-exposure': 'sha256:some-other-sites-gates',
                'x-exposure-shape': 'sha256:abc123',
            })).transport,
        });
        expect((await client.call('session.whoami')).ok).toBe(true);
    });

    it('proceeds when the shape matches, and when either side reports none', async () => {
        const matching = createClient(siteApi, {
            transport: fakeTransport(() => json(200, { userId: 'u1', roles: [] }, { 'x-exposure-shape': 'sha256:abc123' })).transport,
        });
        expect((await matching.call('session.whoami')).ok).toBe(true);

        // An older API sends no header.
        const silent = createClient(siteApi, {
            transport: fakeTransport(() => json(200, { userId: 'u1', roles: [] })).transport,
        });
        expect((await silent.call('session.whoami')).ok).toBe(true);

        // And a client generated before D4 carries no shapeHash. Unverifiable beats refusing
        // everything, and it is a state that resolves itself on the next regenerate.
        const older = createClient(defineApi({ id: 'surfdns', exposure: 'sha256:gate-hash', calls: siteApi.calls }), {
            transport: fakeTransport(() => json(200, { userId: 'u1', roles: [] }, { 'x-exposure-shape': 'sha256:anything' })).transport,
        });
        expect((await older.call('session.whoami')).ok).toBe(true);
    });

    it('has a message for every failure, checked exhaustively', () => {
        // The switch in describe() has no default, so a new case in TransportError is a compile
        // error there rather than an undefined in a toast.
        expect(describeError({ kind: 'unauthorized' })).toBe('You need to sign in.');
        expect(describeError({ kind: 'declared', name: 'revoked', detail: 'Revoked.' })).toBe('Revoked.');
    });
});

// ---------------------------------------------------------------------------- the capability

interface ConsoleApi {
    readonly whoami: () => Promise<string>;
}
const CONSOLE = provider<ConsoleApi>('test.console');

const CONSOLE_NEEDS = needs('mesh', 'log');

class ConsoleApp implements Application<typeof CONSOLE_NEEDS, readonly [], typeof CONSOLE> {
    readonly needs = CONSOLE_NEEDS;
    readonly provides = CONSOLE;
    readonly api = siteApi;

    async start(cx: Context<typeof CONSOLE_NEEDS, readonly [], typeof siteApi>): Promise<{ api: ConsoleApi } & typeof KEEPS_NOTHING> {
        return {
            ...KEEPS_NOTHING,
            api: {
                whoami: async () => {
                    const result = await cx.mesh.call('session.whoami');
                    if (!result.ok) {
                        cx.log.warn(describeError(result.error));
                        return 'anonymous';
                    }
                    return result.value.userId;
                },
            },
        };
    }
}

describe('mesh as a capability', () => {
    const bootWith = (reply: (request: NetRequest) => NetResponse) => {
        const services = createServices();
        const fake = fakeTransport(reply);
        services.meshClient = (api) => createClient(api as Api<Record<string, never>>, { transport: fake.transport });

        const kernel = new Kernel({ services });
        kernel.boot([{ id: 'console', contribution: new ConsoleApp() as never }]);
        return { kernel, fake };
    };

    it('reaches the Application, scoped to the API it declared', async () => {
        const { kernel, fake } = bootWith(() => json(200, { userId: 'u1', roles: ['user'] }));
        const pid = await kernel.start('console');

        const api = kernel.processes.find((p) => p.pid === pid)!.api as ConsoleApi;
        expect(await api.whoami()).toBe('u1');
        expect(fake.sent[0]!.url).toBe('/api/session/whoami');
    });

    it('is absent from a context that did not ask for it', async () => {
        const NO_MESH = needs('log');
        const cx = {} as Context<typeof NO_MESH>;

        // @ts-expect-error mesh was not declared in needs
        void cx.mesh;
    });

    it('refuses to start an Application that asked for mesh without declaring an api', async () => {
        const NEEDS = needs('mesh');

        class Bad implements Application<typeof NEEDS> {
            readonly needs = NEEDS;
            async start(): Promise<typeof KEEPS_NOTHING> { /* never reached */ return KEEPS_NOTHING; }
        }

        const kernel = new Kernel();
        kernel.boot([{ id: 'bad', contribution: new Bad() as never }]);

        // A manifest mistake, so it fails loudly at start rather than yielding a client that can
        // call nothing.
        await expect(kernel.start('bad')).rejects.toThrow(/without declaring an api/);
    });

    it('records the APIs a site talks to before anything runs', () => {
        const { kernel } = bootWith(() => json(200, {}));

        // spec/network.md section 4 — the list a review, a CSP or an audit wants, available from
        // the manifest with nothing started.
        expect(kernel.processes).toHaveLength(0);
        expect(kernel.manifest.apis.map((a) => a.decl.id)).toEqual(['surfdns']);
    });
});

// ---------------------------------------------------------------------------- live descriptor discovery

describe('runtime exposure descriptor discovery (GET /api/_describe)', () => {
    const sampleDescriptor: ExposureDescriptor = {
        application: 'surfdns.console',
        base: '/api',
        exposure: 'sha256:gate-exposure-123',
        shapeHash: 'sha256:shape-hash-456',
        calls: [
            {
                key: 'zone.list',
                domain: 'zone',
                action: 'list',
                method: 'GET',
                path: '/zones',
                description: 'List DNS zones',
                gate: 'user',
                destructive: false,
                stream: false,
                errors: ['unauthorized'],
                input: { type: 'object', properties: {} },
                output: { type: 'array', items: { type: 'object' } },
            },
            {
                key: 'zone.destroy',
                domain: 'zone',
                action: 'destroy',
                method: 'DELETE',
                path: '/zones/:id',
                description: 'Delete a DNS zone',
                gate: 'admin',
                destructive: true,
                stream: false,
                errors: ['not_found', 'forbidden'],
                input: { type: 'object', properties: { id: { type: 'string' } } },
                output: { type: 'object', properties: { deleted: { type: 'boolean' } } },
            },
        ],
    };

    it('fetches the descriptor, maps it to an ApiSpec, and carries shapeHash', async () => {
        const fake = fakeTransport(() => json(200, sampleDescriptor, {
            etag: '"etag-1"',
            'x-exposure-shape': 'sha256:shape-hash-456',
        }));

        const result = await fetchApiSpec({ transport: fake.transport });
        if (!result.ok) throw new Error('expected ok');

        expect(result.value.notModified).toBe(false);
        if (result.value.notModified) throw new Error('expected modified');

        const spec = result.value.spec;
        expect(spec.id).toBe('surfdns.console');
        expect(spec.base).toBe('/api');
        // Carries shapeHash, never exposure hash for staleness
        expect(spec.shapeHash).toBe('sha256:shape-hash-456');
        expect(spec.exposure).toBe('sha256:gate-exposure-123');

        // Calls carry all metadata: input, output, gate, destructive, errors, stream
        expect(spec.calls['zone.list']?.method).toBe('GET');
        expect(spec.calls['zone.list']?.path).toBe('/zones');
        expect(spec.calls['zone.list']?.destructive).toBe(false);
        expect(spec.calls['zone.list']?.gate).toBe('user');
        expect(spec.calls['zone.list']?.errors).toEqual(['unauthorized']);

        expect(spec.calls['zone.destroy']?.method).toBe('DELETE');
        expect(spec.calls['zone.destroy']?.path).toBe('/zones/:id');
        expect(spec.calls['zone.destroy']?.destructive).toBe(true);
        expect(spec.calls['zone.destroy']?.gate).toBe('admin');

        // Verify that defineApi and createClient work with this spec
        const api = defineApi(spec);
        const client = createClient(api, { transport: fake.transport });
        expect(client.api).toBe('surfdns.console');
    });

    it('never sends x-exposure-shape on the request to avoid recovery deadlock', async () => {
        const fake = fakeTransport(() => json(200, sampleDescriptor));

        await fetchApiSpec({ transport: fake.transport });

        expect(fake.sent).toHaveLength(1);
        expect(fake.sent[0]!.url).toBe('/api/_describe');
        expect(fake.sent[0]!.method).toBe('GET');
        expect(fake.sent[0]!.headers['x-exposure-shape']).toBeUndefined();
        expect(fake.sent[0]!.headers['x-exposure']).toBeUndefined();
    });

    it('handles ETag and 304 Not Modified', async () => {
        const fake = fakeTransport((req) => {
            if (req.headers['if-none-match'] === '"etag-1"') {
                return { status: 304, headers: { etag: '"etag-1"' }, body: '' };
            }
            return json(200, sampleDescriptor, { etag: '"etag-1"' });
        });

        // First request: gets 200
        const first = await fetchApiSpec({ transport: fake.transport });
        if (!first.ok || first.value.notModified) throw new Error('expected modified');
        expect(first.value.etag).toBe('"etag-1"');

        // Second request with ETag: gets 304
        const second = await fetchApiSpec({ transport: fake.transport, etag: first.value.etag });
        if (!second.ok) throw new Error('expected ok');
        expect(second.value.notModified).toBe(true);
        expect(second.value.etag).toBe('"etag-1"');
        expect(fake.sent[1]!.headers['if-none-match']).toBe('"etag-1"');
    });

    it('maps network errors to offline result', async () => {
        const failingTransport: Transport = {
            send: async () => { throw new Error('connection refused'); },
        };

        const result = await fetchApiSpec({ transport: failingTransport });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected err');
        expect(result.error.kind).toBe('offline');
    });

    it('maps HTTP errors to CallError cases', async () => {
        const fake = fakeTransport(() => json(404, { error: 'NOT_FOUND', message: 'Not found' }));

        const result = await fetchApiSpec({ transport: fake.transport });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected err');
        expect(result.error.kind).toBe('not_found');
    });

    it('toApiSpec converts an in-memory ExposureDescriptor correctly', () => {
        const spec = toApiSpec(sampleDescriptor);
        expect(spec.id).toBe('surfdns.console');
        expect(spec.shapeHash).toBe('sha256:shape-hash-456');
        expect(Object.keys(spec.calls)).toEqual(['zone.list', 'zone.destroy']);
    });
});

// ---------------------------------------------------------------------------- stale recovery and diffing

describe('stale client recovery and exposure difference reporting', () => {
    const baseClientApi = defineApi({
        id: 'surfdns',
        exposure: 'sha256:gate-v1',
        shapeHash: 'sha256:shape-v1',
        calls: {
            'domain.get': call<{ id: string }, { id: string; name: string }>('GET', '/domains/:id', { kind: 'auth', level: 'user' }),
            'domain.create': call<{ name: string }, { id: string }>('POST', '/domains', { kind: 'auth', level: 'admin' }),
            'domain.delete': call<{ id: string }, void>('DELETE', '/domains/:id', { kind: 'permission', permission: 'domain.delete' }),
        },
    });

    it('diffExposure detects missing, method, path, input, output, and gate differences', () => {
        const movedDescriptor: ExposureDescriptor = {
            application: 'surfdns',
            base: '/api',
            exposure: 'sha256:gate-v2',
            shapeHash: 'sha256:shape-v2',
            calls: [
                // domain.get path and gate changed
                {
                    key: 'domain.get',
                    method: 'GET',
                    path: '/v2/domains/:id',
                    gate: 'operator',
                },
                // domain.create method changed to PUT
                {
                    key: 'domain.create',
                    method: 'PUT',
                    path: '/domains',
                    gate: 'admin',
                },
                // domain.delete is missing from API
                // and a new call exists in API (which should not be a client difference)
                {
                    key: 'domain.list',
                    method: 'GET',
                    path: '/domains',
                },
            ],
        };

        const diffs = diffExposure(baseClientApi, movedDescriptor);

        expect(diffs).toEqual([
            {
                contract: 'domain.create',
                kind: 'method',
                message: 'Contract "domain.create" method changed from POST to PUT.',
            },
            {
                contract: 'domain.delete',
                kind: 'missing',
                message: 'Contract "domain.delete" is not exposed by the API.',
            },
            {
                contract: 'domain.get',
                kind: 'path',
                message: 'Contract "domain.get" path changed from /domains/:id to /v2/domains/:id.',
            },
            {
                contract: 'domain.get',
                kind: 'gate',
                message: 'Contract "domain.get" gate changed from user to operator.',
            },
        ]);

        // exposureDifference is an alias of diffExposure
        expect(exposureDifference(baseClientApi, movedDescriptor)).toEqual(diffs);
    });

    it('diffExposure compares input and output schema differences when present', () => {
        const clientWithSchemas = defineApi({
            id: 'schemas',
            exposure: 'sha256:g1',
            calls: {
                'item.get': {
                    method: 'GET',
                    path: '/items/:id',
                    input: { type: 'object', properties: { id: { type: 'string' } } },
                    output: { type: 'object', properties: { count: { type: 'number' } } },
                },
            },
        });

        const apiWithChangedSchemas: ExposureDescriptor = {
            calls: [
                {
                    key: 'item.get',
                    method: 'GET',
                    path: '/items/:id',
                    input: { type: 'object', properties: { id: { type: 'string' }, filter: { type: 'string' } } },
                    output: { type: 'object', properties: { count: { type: 'string' } } },
                },
            ],
        };

        const diffs = diffExposure(clientWithSchemas, apiWithChangedSchemas);
        expect(diffs).toEqual([
            {
                contract: 'item.get',
                kind: 'input',
                message: 'Contract "item.get" input schema changed.',
            },
            {
                contract: 'item.get',
                kind: 'output',
                message: 'Contract "item.get" output schema changed.',
            },
        ]);
    });

    it('stale client fetches GET /api/_describe, avoids x-exposure-shape on discovery, and returns differences', async () => {
        const updatedDescriptor: ExposureDescriptor = {
            application: 'surfdns',
            base: '/api',
            exposure: 'sha256:gate-v2',
            shapeHash: 'sha256:shape-v2',
            calls: [
                {
                    key: 'domain.get',
                    method: 'GET',
                    path: '/v2/domains/:id',
                },
                {
                    key: 'domain.create',
                    method: 'POST',
                    path: '/domains',
                },
                {
                    key: 'domain.delete',
                    method: 'DELETE',
                    path: '/domains/:id',
                },
            ],
        };

        const fake = fakeTransport((req) => {
            if (req.url === '/api/_describe') {
                return json(200, updatedDescriptor);
            }
            // Normal call returns 200 with new x-exposure-shape
            return json(200, { id: 'd1', name: 'example.com' }, { 'x-exposure-shape': 'sha256:shape-v2' });
        });

        // Wrap transport with default headers (like an auth ticket) to ensure headers travel but x-exposure-shape is never sent
        const wrappedTransport = withHeaders(fake.transport, () => ({ authorization: 'Bearer ticket-123' }));
        const client = createClient(baseClientApi, { transport: wrappedTransport });

        const result = await client.call('domain.get', { id: 'd1' });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected err');

        expect(result.error.kind).toBe('stale');
        if (result.error.kind !== 'stale') throw new Error('expected stale');

        expect(result.error.expected).toBe('sha256:shape-v1');
        expect(result.error.actual).toBe('sha256:shape-v2');
        expect(result.error.differences).toEqual([
            {
                contract: 'domain.get',
                kind: 'path',
                message: 'Contract "domain.get" path changed from /domains/:id to /v2/domains/:id.',
            },
        ]);

        // Formatted description contains the exact change
        expect(describeError(result.error)).toBe(
            'This page is out of date with the API: Contract "domain.get" path changed from /domains/:id to /v2/domains/:id.',
        );

        // Discovery request was sent and did NOT include x-exposure-shape, but carries auth headers
        const describeReq = fake.sent.find((r) => r.url === '/api/_describe');
        expect(describeReq).toBeDefined();
        expect(describeReq!.headers['x-exposure-shape']).toBeUndefined();
        expect(describeReq!.headers['authorization']).toBe('Bearer ticket-123');
    });

    it('caches differences and deduplicates concurrent descriptor fetches on stale client', async () => {
        const updatedDescriptor: ExposureDescriptor = {
            calls: [
                {
                    key: 'domain.get',
                    method: 'POST',
                    path: '/domains/:id',
                },
            ],
        };

        let describeCalls = 0;
        const fake = fakeTransport((req) => {
            if (req.url === '/api/_describe') {
                describeCalls++;
                return json(200, updatedDescriptor);
            }
            return json(200, {}, { 'x-exposure-shape': 'sha256:shape-v2' });
        });

        const client = createClient(baseClientApi, { transport: fake.transport });

        // Two concurrent calls
        const [res1, res2] = await Promise.all([
            client.call('domain.get', { id: 'd1' }),
            client.call('domain.delete', { id: 'd2' }),
        ]);

        expect(res1.ok).toBe(false);
        expect(res2.ok).toBe(false);
        // Only one fetch to /api/_describe occurred
        expect(describeCalls).toBe(1);

        // A third sequential call also uses the cached differences
        const res3 = await client.call('domain.create', { name: 'test' });
        expect(res3.ok).toBe(false);
        expect(describeCalls).toBe(1);
    });

    it('gracefully returns stale error if descriptor fetch fails', async () => {
        const fake = fakeTransport((req) => {
            if (req.url === '/api/_describe') {
                return json(500, 'internal server error');
            }
            return json(200, {}, { 'x-exposure-shape': 'sha256:shape-v2' });
        });

        const client = createClient(baseClientApi, { transport: fake.transport });
        const result = await client.call('domain.get', { id: 'd1' });

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('expected err');
        expect(result.error.kind).toBe('stale');
        if (result.error.kind !== 'stale') throw new Error('expected stale');
        expect(result.error.expected).toBe('sha256:shape-v1');
        expect(result.error.actual).toBe('sha256:shape-v2');
        expect(result.error.differences).toBeUndefined();
        expect(describeError(result.error)).toBe('This page is out of date with the API. Reload.');
    });
});


describe('a moved exposure is not a broken client', () => {
    /**
     * The failure this prevents, three times in two days: adding one contract anywhere moved the
     * site's whole-exposure hash, and every part on the page began refusing every call — the
     * catalog browser dead because the fleet gained a call it has never heard of.
     *
     * The two hashes are computed over different sets **by construction**: a generated client
     * hashes every contract every part declares; the server hashes the deployed release's
     * `requires` intersected with what the site exposes. They will essentially never be equal.
     */
    const describeBody = {
        application: 'surfdns',
        base: '/api',
        exposure: 'sha256:gate',
        shapeHash: 'sha256:moved',
        calls: [
            // Same shape as the client's — nothing this client uses has changed.
            { key: 'credential.resolve', method: 'GET', path: '/credential/resolve', input: {}, output: {} },
            { key: 'credential.create', method: 'POST', path: '/credential', input: {}, output: {} },
            { key: 'session.whoami', method: 'GET', path: '/session/whoami', input: {}, output: {} },
            { key: 'credential.get', method: 'GET', path: '/credentials/:id', input: {}, output: {} },
            { key: 'site.deploy', method: 'POST', path: '/sites/:host/deploy', input: {}, output: {} },
        ],
    };

    it('returns the response when nothing this client uses moved', async () => {
        const fake = fakeTransport((request) => (
            request.url.endsWith('/_describe')
                ? json(200, describeBody)
                : json(200, { id: 'c1', name: 'prod', provider: 'cloudflare', createdAt: 1 },
                    { 'x-exposure-shape': 'sha256:moved' })
        ));

        const result = await createClient(siteApi, { transport: fake.transport })
            .call('credential.resolve', { id: 'c1' });

        // The response was good. Refusing it because somebody else's contract appeared is the bug.
        expect(result.ok).toBe(true);
        expect(result.ok && result.value.name).toBe('prod');
    });

    it('still refuses the call that actually moved, and says what changed', async () => {
        const moved = {
            ...describeBody,
            calls: describeBody.calls.map((c) => (c.key === 'credential.resolve'
                ? { ...c, method: 'POST' }   // this one really did change
                : c)),
        };

        const fake = fakeTransport((request) => (
            request.url.endsWith('/_describe')
                ? json(200, moved)
                : json(200, {}, { 'x-exposure-shape': 'sha256:moved' })
        ));
        const client = createClient(siteApi, { transport: fake.transport });

        const broken = await client.call('credential.resolve', { id: 'c1' });
        expect(broken.ok).toBe(false);
        if (!broken.ok) {
            expect(broken.error.kind).toBe('stale');
            expect(JSON.stringify(broken.error)).toContain('credential.resolve');
        }

        // And a call that did not move is unaffected, on the same stale exposure.
        const fine = await client.call('session.whoami');
        expect(fine.ok).toBe(true);
    });

    /**
     * **A gate difference is reported and never refuses a call.**
     *
     * A gate is per **site**: a part declares what it *calls*, a site declares what it *exposes and
     * at what level*, so a generated client has no gate of its own to declare. `mesh-serve client`
     * writes `auth: 'public'` for every entry with a comment saying the value means nothing — which
     * makes a gate difference guaranteed for every contract a site gates above public.
     *
     * The operator console was unusable on its first deploy because of it: eight contracts, eight
     * gate differences, eight calls refused as `stale`, and a page listing all eight above an empty
     * screen. Every one of the eight was correct.
     *
     * There is also nothing a client could do with the knowledge — it cannot change its own gate,
     * and a call it may not make comes back 401 or 403 from the only thing that knows.
     */
    it('reports a gate difference and returns the response anyway', async () => {
        /**
         * The client declares `public` on every call and the site gates them at `operator` — the
         * generated shape, and the exact eight-difference state the console shipped in. `siteApi`
         * above cannot show this: it declares no gate, so no gate difference is ever produced and
         * the test would pass whether the fix existed or not.
         */
        const generated = defineApi({
            id: 'console',
            exposure: 'sha256:gate',
            shapeHash: 'sha256:shape-v1',
            calls: {
                'site.find': call<void, readonly { host: string }[]>(
                    'GET', '/sites', { kind: 'auth', level: 'public' }),
            },
        });

        const fake = fakeTransport((request) => (
            request.url.endsWith('/_describe')
                ? json(200, {
                    calls: [{ key: 'site.find', method: 'GET', path: '/sites', gate: 'operator' }],
                })
                : json(200, [{ host: '127.0.0.1' }], { 'x-exposure-shape': 'sha256:shape-v2' })
        ));

        const result = await createClient(generated, { transport: fake.transport })
            .call('site.find');

        expect(result.ok).toBe(true);
        expect(result.ok && result.value[0]?.host).toBe('127.0.0.1');
    });

    /**
     * The gate difference is still *found* — it belongs in a diagnostic. What changed is that it no
     * longer refuses anything, so this asserts the reporting half separately from the failing half.
     */
    it('still describes the gate change when asked', () => {
        /**
         * Gates declared, and `public` on every one — which is exactly what `mesh-serve client`
         * emits and why this difference is guaranteed rather than exceptional. A client that
         * declares no gate at all (like `siteApi` above) never produces one, so the fixture has to
         * be the generated shape for this to be the real case.
         */
        const generated = defineApi({
            id: 'console',
            exposure: 'sha256:gate',
            shapeHash: 'sha256:shape',
            calls: {
                'site.find': call<void, readonly unknown[]>('GET', '/sites', { kind: 'auth', level: 'public' }),
                'site.seed': call<void, unknown>('POST', '/sites/seed', { kind: 'auth', level: 'public' }),
            },
        });

        const diffs = diffExposure(generated, {
            calls: [
                { key: 'site.find', method: 'GET', path: '/sites', gate: 'operator' },
                { key: 'site.seed', method: 'POST', path: '/sites/seed', gate: 'operator' },
            ],
        } as ExposureDescriptor);

        expect(diffs.every((d) => d.kind === 'gate')).toBe(true);
        expect(diffs).toHaveLength(2);
    });

    /**
     * A gate difference must not mask a real one on the same contract. If a path moved *and* the
     * gate changed, the call still fails — the shape is what breaks it.
     */
    it('still refuses a call whose shape moved even when its gate moved too', async () => {
        const both = {
            ...describeBody,
            calls: describeBody.calls.map((c) => (c.key === 'credential.resolve'
                ? { ...c, method: 'POST', gate: 'operator' }
                : { ...c, gate: 'operator' })),
        };

        const fake = fakeTransport((request) => (
            request.url.endsWith('/_describe')
                ? json(200, both)
                : json(200, {}, { 'x-exposure-shape': 'sha256:moved' })
        ));

        const result = await createClient(siteApi, { transport: fake.transport })
            .call('credential.resolve', { id: 'c1' });

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.kind).toBe('stale');
    });
});
