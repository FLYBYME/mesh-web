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
    KERNEL_SOURCE, Kernel, call, consumes, createClient, createServices, defineApi, needs, provider,
    start, text, withHeaders, KEEPS_NOTHING,
    type Application, type Context, type Extension, type LogRecord, type NetRequest, type NetResponse,
} from '../src/index.js';
import { AVAILABLE, schema, type ApiDecl } from '../src/contribution/api.js';

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

const APP_NEEDS = needs('mesh', 'models');

class Catalog implements Application<typeof APP_NEEDS, readonly [], undefined, typeof siteApi> {
    readonly needs = APP_NEEDS;
    readonly api = siteApi;
    cx: Context<typeof APP_NEEDS, readonly [], typeof siteApi> | undefined;

    async start(cx: Context<typeof APP_NEEDS, readonly [], typeof siteApi>): Promise<typeof KEEPS_NOTHING> {
        this.cx = cx;
        return KEEPS_NOTHING;
    }
}

const TICKET = 'tk-9f2c1a-very-secret-ticket';
const PASSWORD = 'hunter2-correct-horse-battery';

const SESSION_NEEDS = needs('credentials');

/** Holds the page's ticket, the way a real auth Extension does, through the declared seam. */
class Ticketed implements Extension<typeof SESSION_NEEDS> {
    readonly needs = SESSION_NEEDS;
    activate(cx: Context<typeof SESSION_NEEDS>): void {
        cx.credentials.attach(() => ({ authorization: `Bearer ${TICKET}` }));
    }
}

/** A kernel whose mesh traffic goes to `reply`, with the credential seam wired the way start() wires it. */
const bootCatalog = async (reply: (request: NetRequest) => NetResponse, withTicket = false) => {
    const services = createServices();
    const sent: NetRequest[] = [];
    services.meshClient = (api) => createClient(api, {
        transport: withHeaders(
            { send: async (request) => { sent.push(request); return reply(request); } },
            () => services.credentials.headers?.() ?? {},
        ),
    });

    const kernel = new Kernel({ services });
    const app = new Catalog();
    kernel.boot([
        ...(withTicket ? [{ id: 'auth', contribution: new Ticketed() }] : []),
        { id: 'catalog', contribution: app },
    ]);
    const pid = await kernel.start('catalog');

    const cx = app.cx;
    if (cx === undefined) throw new Error('catalog did not start');
    return { kernel, cx, pid, sent };
};

// ---------------------------------------------------------------------------- refusals

describe('a refusal leaves a line naming the part and the reason', () => {
    const renameDecl: ApiDecl = {
        commands: [{
            action: 'rename',
            description: 'Gives the thing a different name.',
            input: schema<{ name: string }>(),
            output: schema<void>(),
            available: () => AVAILABLE,
        }],
    };

    class Liar implements Application<typeof NONE> {
        readonly needs = NONE;
        readonly publishes = renameDecl;
        async start(): Promise<typeof KEEPS_NOTHING> { return KEEPS_NOTHING; }
    }

    it('for a part that fails checkBindings', async () => {
        const kernel = new Kernel();
        kernel.boot([{ id: 'liar', contribution: new Liar() }]);
        const pid = await kernel.start('liar');

        const lines = kernelLines(kernel.services.logs).filter((l) => l.part === 'liar');
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ level: 'error', source: 'kernel', part: 'liar' });
        expect(lines[0]?.message).toContain(`liar (${pid}) was refused at start`);
        expect(lines[0]?.message).toContain('command "rename" is declared and not bound');
    });

    it('for an Extension whose consumes nothing provides', () => {
        const MISSING = provider<{ readonly x: number }>('test/missing');
        const CONSUMES = consumes(MISSING);

        class Needy implements Extension<typeof NONE, typeof CONSUMES> {
            readonly needs = NONE;
            readonly consumes = CONSUMES;
            activate(): void {}
        }

        const kernel = new Kernel();
        kernel.boot([{ id: 'needy', contribution: new Needy() }]);

        expect(kernelLines(kernel.services.logs)).toEqual([{
            level: 'error',
            source: 'kernel',
            part: 'needy',
            message: 'needy was not activated: no contribution provides "test/missing"',
        }]);
    });

    it('for a provider token nothing fills — once, however often it is asked for', async () => {
        // An Application's `consumes` is not in the provider graph, so this is refused at `use`.
        // Asked three times, as a render or a retry would: the promise is one line per refusal.
        const MISSING = provider<{ readonly x: number }>('test/unfilled');
        const CONSUMES = consumes(MISSING);

        class Hopeful implements Application<typeof NONE, typeof CONSUMES> {
            readonly needs = NONE;
            readonly consumes = CONSUMES;
            async start(cx: Context<typeof NONE, typeof CONSUMES>): Promise<typeof KEEPS_NOTHING> {
                for (let i = 0; i < 3; i++) {
                    try { cx.use(MISSING); } catch { /* the part copes */ }
                }
                return KEEPS_NOTHING;
            }
        }

        const kernel = new Kernel();
        kernel.boot([{ id: 'hopeful', contribution: new Hopeful() }]);
        await kernel.start('hopeful');

        const refusals = kernelLines(kernel.services.logs)
            .filter((l) => l.message.includes('was refused provider "test/unfilled"'));
        expect(refusals).toHaveLength(1);
        expect(refusals[0]).toMatchObject({ level: 'warn', part: 'hopeful' });
    });

    it('for needs("mesh") with no api — and the process is failed, not left starting', async () => {
        const MESH = needs('mesh');
        class NoApi implements Application<typeof MESH> {
            readonly needs = MESH;
            async start(): Promise<typeof KEEPS_NOTHING> { return KEEPS_NOTHING; }
        }

        const kernel = new Kernel();
        kernel.boot([{ id: 'noapi', contribution: new NoApi() }]);

        await expect(kernel.start('noapi')).rejects.toThrow(/without declaring an api/);
        expect(kernel.processes.find((p) => p.applicationId === 'noapi')?.state).toBe('failed');

        const line = kernelLines(kernel.services.logs).find((l) => l.part === 'noapi');
        expect(line?.level).toBe('error');
        expect(line?.message).toContain('without declaring an api');
    });
});

// ---------------------------------------------------------------------------- lifecycle

describe('the lifecycle of every contribution', () => {
    it('records activation, start, a failed activation with its reason, and stop', async () => {
        class Fine implements Extension<typeof NONE> {
            readonly needs = NONE;
            activate(): void {}
        }
        class Broken implements Extension<typeof NONE> {
            readonly needs = NONE;
            activate(): void { throw new Error('theme file missing'); }
        }
        class Clock implements Application<typeof NONE> {
            readonly needs = NONE;
            async start(): Promise<typeof KEEPS_NOTHING> { return KEEPS_NOTHING; }
        }

        const kernel = new Kernel();
        kernel.boot([
            { id: 'fine', contribution: new Fine() },
            { id: 'broken', contribution: new Broken() },
            { id: 'clock', contribution: new Clock() },
        ]);
        const pid = await kernel.start('clock');
        await kernel.stop(pid);

        expect(kernelLines(kernel.services.logs).map((l) => [l.level, l.part, l.message])).toEqual([
            ['info', 'fine', 'fine activated'],
            ['error', 'broken', 'broken failed to activate: theme file missing'],
            ['info', 'clock', `clock started as ${pid}`],
            ['info', 'clock', `clock (${pid}) stopped`],
        ]);
    });
});

// ---------------------------------------------------------------------------- failed calls

describe('a failed call the kernel mediates', () => {
    it('leaves a line with the status and the contract key, for a collection fetch', async () => {
        const { kernel, cx } = await bootCatalog(() => json(401, { error: 'unauthorized' }));

        const parts = cx.models('part');
        await parts.refetch();
        expect(parts.status()).toBe('error');

        const failures = kernelLines(kernel.services.logs).filter((l) => l.message.includes('part.find'));
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
        const { kernel, cx } = await bootCatalog(() =>
            (status === 200 ? json(200, []) : json(status, { message: 'upstream down' })));

        const parts = cx.models('part');
        const failures = (): readonly LogRecord[] =>
            kernelLines(kernel.services.logs).filter((l) => l.message.includes('part.find failed'));

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
        const { kernel, cx, sent } = await bootCatalog(() => replies[next++] ?? json(500, echo), true);

        for (let i = 0; i < replies.length; i++) {
            const result = await cx.mesh.call('session.signIn', { email: 'alice@example.com', password: PASSWORD });
            expect(result.ok).toBe(false);
        }
        const parts = cx.models('part');
        await parts.refetch();

        // The secrets really were in play: the ticket went out on the wire, the password in a body.
        expect(sent.some((r) => r.headers['authorization'] === `Bearer ${TICKET}`)).toBe(true);
        expect(sent.some((r) => r.body?.includes(PASSWORD) ?? false)).toBe(true);

        // And the failures really were recorded — an empty buffer would pass the check below.
        const failures = kernelLines(kernel.services.logs).filter((l) => l.message.includes('failed'));
        expect(failures.map((l) => l.message)).toEqual([
            'catalog (p1): session.signIn failed — 401 unauthorized',
            'catalog (p1): session.signIn failed — 500 server error',
            'catalog (p1): session.signIn failed — invalid request',
            'catalog (p1): session.signIn failed — 409 conflict',
            'catalog (p1): part.find failed — 500 server error',
        ]);

        const all = everything(kernel.services.logs);
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

        const HTTP = needs('http');
        class Weather implements Application<typeof HTTP> {
            readonly needs = HTTP;
            async start(cx: Context<typeof HTTP>): Promise<typeof KEEPS_NOTHING> {
                await cx.http.get(`https://weather.example/v1/today?access_token=${TICKET}#${TICKET}`, {
                    headers: { authorization: `Bearer ${TICKET}` },
                });
                return KEEPS_NOTHING;
            }
        }

        const kernel = new Kernel();
        kernel.boot([{ id: 'weather', contribution: new Weather() }]);
        await kernel.start('weather');

        const line = kernel.services.logs.find((l) => l.message.includes('weather.example'));
        expect(line?.message).toBe('GET https://weather.example/v1/today → 401');
        expect(everything(kernel.services.logs)).not.toContain(TICKET);
    });
});

// ---------------------------------------------------------------------------- the boot, through start()

describe('a boot somebody can read', () => {
    const THEME = provider<{ readonly dark: boolean }>('test/theme');

    class Theme implements Extension<typeof NONE, readonly [], typeof THEME> {
        readonly needs = NONE;
        readonly provides = THEME;
        activate(): { readonly dark: boolean } { return { dark: true }; }
    }

    class Clock implements Application<typeof NONE> {
        readonly needs = NONE;
        readonly views = [{ id: 'face', title: 'Clock', render: () => text('12:00') }];
        async start(): Promise<typeof KEEPS_NOTHING> { return KEEPS_NOTHING; }
    }

    it('is one line per part and a summary, and nothing else', async () => {
        clean();
        const started = start({
            application: 'test',
            parts: [{ id: 'theme', contribution: new Theme() }, { id: 'clock', contribution: new Clock() }],
            open: [{ application: 'clock', views: ['face'] }],
        });
        await started.ready;

        // The whole buffer, not only the kernel's lines: rendering a window, measuring the page and
        // restoring geometry must add nothing.
        expect(started.kernel.services.logs.map((l) => [l.level, l.source, l.part, l.message])).toEqual([
            ['info', 'kernel', 'theme', 'theme activated, providing "test/theme"'],
            ['info', 'kernel', 'clock', 'clock started as p1'],
            ['info', 'kernel', undefined, 'booted 2 part(s) — running: theme, clock (p1)'],
        ]);
        expect(started.kernel.services.logs.at(-1)?.data).toEqual({
            parts: 2, running: ['theme', 'clock (p1)'], failed: [], notStarted: [],
        });
        started.dispose();
    });

    it('survives a part whose constructor throws, and says which and why', async () => {
        clean();

        class Explodes implements Application<typeof NONE> {
            readonly needs = NONE;
            constructor() { throw new Error('endpoints.base is required'); }
            async start(): Promise<typeof KEEPS_NOTHING> { return KEEPS_NOTHING; }
        }

        const started = start({
            application: 'test',
            parts: [{ id: 'explodes', contribution: Explodes }, { id: 'clock', contribution: new Clock() }],
        });
        await started.ready;

        // The page is there, with its panel, and the part that could run is running.
        expect(started.logViewer.host.isConnected).toBe(true);
        expect(started.kernel.processes.find((p) => p.applicationId === 'clock')?.state).toBe('running');

        const lines = kernelLines(started.kernel.services.logs);
        expect(lines.find((l) => l.part === 'explodes')).toMatchObject({
            level: 'error',
            message: 'explodes could not be constructed: endpoints.base is required. The page boots without it.',
        });

        const summary = lines.at(-1);
        expect(summary?.level).toBe('warn');
        expect(summary?.message).toBe('booted 2 part(s) — running: clock (p1) · failed: explodes');
        started.dispose();
    });
});
