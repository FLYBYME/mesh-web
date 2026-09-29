/**
 * @vitest-environment jsdom
 *
 * **What the kernel records** — roadmap A8.17.
 *
 * The panel (ctrl+alt+q) existed and the kernel wrote almost nothing to it, so every failure chased
 * that week — a part refused at `checkBindings`, a constructor that threw, a collection fetch that
 * came back 401 — was known to the kernel at the moment it happened and written nowhere.
 *
 * These assert on the buffer the panel shows, for real scenarios, and on what must *never* be in
 * it: a ticket, an authorization header, a password, or a body.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    App, KERNEL_SOURCE, Service, View, call, createAppRuntime, createClient, createContext, createServices, defineApi,
    element, needs, start, text, withHeaders,
    type LogRecord, type MeshClient, type Models, type NetRequest, type NetResponse, type Node,
} from '../src/index.js';
import { IoManager } from '../src/kernel/io.js';

// ---------------------------------------------------------------------------- helpers

const kernelLines = (logs: readonly LogRecord[]): readonly LogRecord[] =>
    logs.filter((l) => l.source === KERNEL_SOURCE);

/**
 * Everything in the buffer, as one string — every field, and an Error's message and stack
 * expanded, because `JSON.stringify` renders an Error as `{}` and would hide a leak inside one.
 */
const everything = (logs: readonly LogRecord[]): string => logs
    .map((l) => JSON.stringify(l, (_key, value: unknown) =>
        (value instanceof Error ? { message: value.message, stack: value.stack } : value)))
    .join('\n');

const json = (status: number, body: unknown): NetResponse => ({
    status,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
});

const clean = (): void => { document.body.replaceChildren(); };

afterEach(() => { vi.unstubAllGlobals(); });

// ---------------------------------------------------------------------------- fixtures

const NONE = needs();

const siteApi = defineApi({
    id: 'site',
    exposure: 'sha256:site',
    calls: {
        'part.find': call<void, readonly { readonly id: string }[]>('GET', '/parts'),
        'session.signIn': call<{ email: string; password: string }, { ticket: string }>('POST', '/session/sign-in'),
    },
});

const TICKET = 'tk-9f2c1a-very-secret-ticket';
const PASSWORD = 'hunter2-correct-horse-battery';

interface CatalogCx {
    readonly mesh: MeshClient<typeof siteApi>;
    readonly models: Models<typeof siteApi>;
}

/**
 * A page whose mesh traffic goes to `reply`, with the credential seam wired the way `start()` wires
 * it, and an App whose `Catalog` service calls the API — optionally beside a service holding a
 * ticket, the way a real session service does, through the declared seam.
 */
const bootCatalog = async (reply: (request: NetRequest) => NetResponse, withTicket = false) => {
    const services = createServices();
    const sent: NetRequest[] = [];
    services.meshClient = (api) => createClient(api, {
        transport: withHeaders(
            { send: async (request) => { sent.push(request); return reply(request); } },
            () => services.credentials.headers?.() ?? {},
        ),
    });

    let grabbed: CatalogCx | undefined;
    const CatalogBase = Service({ needs: needs('mesh', 'models'), api: siteApi });
    class Catalog extends CatalogBase {
        constructor(...args: ConstructorParameters<typeof CatalogBase>) {
            super(...args);
            grabbed = { mesh: this.cx.mesh, models: this.cx.models };
        }
    }
    const TicketBase = Service({ needs: needs('credentials') });
    class Ticketed extends TicketBase {
        constructor(...args: ConstructorParameters<typeof TicketBase>) {
            super(...args);
            this.cx.credentials.attach(() => ({ authorization: `Bearer ${TICKET}` }));
        }
    }
    class Site extends App({
        needs: needs('mesh', 'models', 'credentials'),
        api: siteApi,
        services: withTicket ? [Ticketed, Catalog] : [Catalog],
        routes: {},
    }) {}

    const io = new IoManager();
    const granted = createContext({ id: 'catalog', declaredBy: 'catalog' }, ['mesh', 'models', 'credentials'], [], (t) => io.get(t), services, io, siteApi).context;
    createAppRuntime(Site, granted);

    const cx = grabbed;
    if (cx === undefined) throw new Error('catalog did not start');
    return { page: { services }, cx, sent };
};

// The refusal and lifecycle lines of the part model (checkBindings, unfilled provider tokens,
// Extension activation, process start/stop) went with it. Their App-model counterparts: a missing
// api for `mesh`/`models` is refused by the broker (test/net.test.ts, test/models.test.ts), and the
// boot's own lines — including an App that fails — are below.

// ---------------------------------------------------------------------------- failed calls

describe('a failed call the kernel mediates', () => {
    it('leaves a line with the status and the contract key, for a collection fetch', async () => {
        const { page, cx } = await bootCatalog(() => json(401, { error: 'unauthorized' }));

        const parts = cx.models('part');
        await parts.refetch();
        expect(parts.status()).toBe('error');

        const failures = kernelLines(page.services.logs).filter((l) => l.message.includes('part.find'));
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
            level: 'warn',
            part: 'catalog',
            data: { api: 'site', contract: 'part.find', kind: 'unauthorized', status: 401 },
        });
        expect(failures[0]?.message).toContain('part.find failed — 401 unauthorized');
    });

    it('is one line per failure, not one per retry — and news again after a success', async () => {
        let status = 503;
        const { page, cx } = await bootCatalog(() =>
            (status === 200 ? json(200, []) : json(status, { message: 'upstream down' })));

        const parts = cx.models('part');
        const failures = (): readonly LogRecord[] =>
            kernelLines(page.services.logs).filter((l) => l.message.includes('part.find failed'));

        await parts.refetch();
        await parts.refetch();
        await parts.refetch();
        expect(failures()).toHaveLength(1);
        expect(failures()[0]).toMatchObject({ level: 'error', data: { status: 503, kind: 'server' } });

        status = 200;
        await parts.refetch();
        expect(parts.status()).toBe('empty');
        expect(failures()).toHaveLength(1);

        status = 503;
        await parts.refetch();
        expect(failures()).toHaveLength(2);
    });

    it('never records a ticket, an authorization header, a password or a body', async () => {
        // Every failure below echoes the secrets back in its body, which a misbehaving or merely
        // helpful server does. The kernel's line may say *that* sign-in failed and how — never
        // with what.
        const echo = `wrong password ${PASSWORD} for Bearer ${TICKET}`;
        const replies = [
            json(401, { error: 'bad_credentials', message: echo }),
            json(500, { message: echo }),
            json(400, echo),
            json(409, { message: echo }),
        ];
        let next = 0;
        const { page, cx, sent } = await bootCatalog(() => replies[next++] ?? json(500, echo), true);

        for (let i = 0; i < replies.length; i++) {
            await expect(
                cx.mesh.call('session.signIn', { email: 'alice@example.com', password: PASSWORD }),
            ).rejects.toThrow();
        }
        const parts = cx.models('part');
        await parts.refetch();

        // The secrets really were in play: the ticket went out on the wire, the password in a body.
        expect(sent.some((r) => r.headers['authorization'] === `Bearer ${TICKET}`)).toBe(true);
        expect(sent.some((r) => r.body?.includes(PASSWORD) ?? false)).toBe(true);

        // And the failures really were recorded — an empty buffer would pass the check below.
        const failures = kernelLines(page.services.logs).filter((l) => l.message.includes('failed'));
        expect(failures.map((l) => l.message)).toEqual([
            'catalog: session.signIn failed — 401 unauthorized',
            'catalog: session.signIn failed — 500 server error',
            'catalog: session.signIn failed — invalid request',
            'catalog: session.signIn failed — 409 conflict',
            'catalog: part.find failed — 500 server error',
        ]);

        const all = everything(page.services.logs);
        expect(all).not.toContain(PASSWORD);
        expect(all).not.toContain(TICKET);
        expect(all).not.toContain('Bearer');
        expect(all.toLowerCase()).not.toContain('authorization');
        expect(all).not.toContain('alice@example.com');
    });

    it('strips the query string from an http line, where a careless caller puts a token', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
            status: 401, headers: { 'content-type': 'application/json' },
        })));

        let weather: Weather | undefined;
        const WeatherBase = Service({ needs: needs('http') });
        class Weather extends WeatherBase {
            constructor(...args: ConstructorParameters<typeof WeatherBase>) {
                super(...args);
                weather = this;
            }
            async today(): Promise<void> {
                await this.cx.http.get(`https://weather.example/v1/today?access_token=${TICKET}#${TICKET}`, {
                    headers: { authorization: `Bearer ${TICKET}` },
                });
            }
        }
        class Site extends App({ needs: needs('http'), services: [Weather], routes: {} }) {}

        const page = { services: createServices() };
        const io = new IoManager();
        createAppRuntime(Site, createContext({ id: 'weather', declaredBy: 'weather' }, ['http'], [], (t) => io.get(t), page.services, io).context);
        await weather?.today();

        const line = page.services.logs.find((l) => l.message.includes('weather.example'));
        expect(line?.message).toBe('GET https://weather.example/v1/today → 401');
        expect(everything(page.services.logs)).not.toContain(TICKET);
    });
});

// ---------------------------------------------------------------------------- the boot, through start()

describe('a boot somebody can read', () => {
    class Face extends View({ title: 'Clock' }) {
        render(): Node { return element('Text', { children: [text('12:00')] }); }
    }

    class Clock extends App({ routes: { '/': Face } }) {}

    it('is one line for the App that started, and nothing else', () => {
        clean();
        const started = start({ application: 'test', parts: [{ id: 'clock', contribution: Clock }] });

        // The whole buffer, not only the kernel's lines: rendering the page must add nothing.
        expect(started.services.logs.map((l) => [l.level, l.source, l.part, l.message])).toEqual([
            ['info', 'kernel', 'clock', 'clock started'],
        ]);
        started.dispose();
    });

    it('leaves a page that says it could not start, and why, when the App fails — not a blank one', () => {
        clean();

        const Base = Service({});
        class Explodes extends Base {
            constructor(...args: ConstructorParameters<typeof Base>) {
                super(...args);
                throw new Error('endpoints.base is required');
            }
        }
        class Broken extends App({ services: [Explodes], routes: { '/': Face } }) {}

        const root = document.createElement('div');
        document.body.append(root);
        expect(() => start({ application: 'test', root, parts: [{ id: 'broken', contribution: Broken }] }))
            .toThrow('endpoints.base is required');

        // The reason is on the page, and the log panel is there to read.
        expect(root.querySelector('[role="alert"]')?.textContent).toBe('This page could not start: endpoints.base is required');
        expect(root.querySelector('.mesh-log-viewer')).not.toBeNull();
    });
});
