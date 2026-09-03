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
    Kernel, call, createClient, createServices, defineApi, describe as describeError, needs,
    provider, withHeaders,
    type Api, type Application, type Context, type NetRequest, type NetResponse, type Transport,
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
    exposure: 'sha256:abc123',
    calls: {
        'credential.resolve': call<{ id: string }, Credential, 'revoked'>('GET', '/credential/resolve'),
        'credential.create': call<{ name: string; provider: string }, Credential>('POST', '/credential'),
        'session.whoami': call<void, Session>('GET', '/session/whoami'),
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

    it('refuses to speak to an API that has moved on', async () => {
        // spec/network.md section 6. The client was generated from one exposure; the API reports
        // another. Saying so once is better than a confusing 404 three calls later.
        const stale = await failsWith(json(200, {}, { 'x-exposure': 'sha256:different' }));
        expect(stale).toEqual({ kind: 'stale', expected: 'sha256:abc123', actual: 'sha256:different' });
    });

    it('proceeds when the exposure matches, and when the API does not report one', async () => {
        const matching = createClient(siteApi, {
            transport: fakeTransport(() => json(200, { userId: 'u1', roles: [] }, { 'x-exposure': 'sha256:abc123' })).transport,
        });
        expect((await matching.call('session.whoami')).ok).toBe(true);

        const silent = createClient(siteApi, {
            transport: fakeTransport(() => json(200, { userId: 'u1', roles: [] })).transport,
        });
        expect((await silent.call('session.whoami')).ok).toBe(true);
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

const CONSOLE_NEEDS = needs('net', 'log');

class ConsoleApp implements Application<typeof CONSOLE_NEEDS, readonly [], typeof CONSOLE> {
    readonly needs = CONSOLE_NEEDS;
    readonly provides = CONSOLE;
    readonly api = siteApi;

    async start(cx: Context<typeof CONSOLE_NEEDS, readonly [], typeof siteApi>): Promise<ConsoleApi> {
        return {
            whoami: async () => {
                const result = await cx.net.call('session.whoami');
                if (!result.ok) {
                    cx.log.warn(describeError(result.error));
                    return 'anonymous';
                }
                return result.value.userId;
            },
        };
    }
}

describe('net as a capability', () => {
    const bootWith = (reply: (request: NetRequest) => NetResponse) => {
        const services = createServices();
        const fake = fakeTransport(reply);
        services.netClient = (api) => createClient(api as Api<Record<string, never>>, { transport: fake.transport });

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
        const NO_NET = needs('log');
        const cx = {} as Context<typeof NO_NET>;

        // @ts-expect-error net was not declared in needs
        void cx.net;
    });

    it('refuses to start an Application that asked for net without declaring an api', async () => {
        const NEEDS = needs('net');

        class Bad implements Application<typeof NEEDS> {
            readonly needs = NEEDS;
            async start(): Promise<void> { /* never reached */ }
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
