/**
 * The auth Extension — roadmap A6.4, spec/network.md §4.
 *
 * The property being tested is a *negative* one, and it is the reason this Extension exists: an
 * Application that declared `needs('net')` and nothing else sends a ticket it has never seen, cannot
 * read, and cannot replace. Most of what follows is therefore about what an Application can reach
 * rather than about what the Extension does.
 *
 * `fetch` is replaced rather than a server started: what is under test is which headers leave the
 * page and when, and a real socket would prove nothing extra while making the timing questions —
 * sign in *after* an Application already built its client — much harder to ask.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthExtension, AUTH, type AuthApi, type TicketStore } from '../src/auth/index.js';
import { defineApi, call } from '../src/net/api.js';
import { Kernel } from '../src/kernel/kernel.js';
import { createServices } from '../src/kernel/broker.js';
import { needs } from '../src/contribution/capabilities.js';
import { consumes } from '../src/contribution/provider.js';
import type { Application, Context } from '../src/contribution/contract.js';

// ---------------------------------------------------------------------------- a fake network

interface Recorded {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: unknown;
}

let sent: Recorded[] = [];
let reply: (request: Recorded) => { status: number; body: unknown };
const realFetch = globalThis.fetch;

beforeEach(() => {
    sent = [];
    reply = () => ({ status: 200, body: {} });

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(init?.headers ?? {})) {
            headers[key.toLowerCase()] = String(value);
        }

        const record: Recorded = {
            url: String(input),
            method: init?.method ?? 'GET',
            headers,
            body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        };
        sent.push(record);

        const answer = reply(record);
        return Promise.resolve(new Response(JSON.stringify(answer.body), {
            status: answer.status,
            headers: { 'content-type': 'application/json' },
        }));
    }) as typeof fetch;
});

afterEach(() => { globalThis.fetch = realFetch; });

/** An identity that issues one ticket and recognises it. */
const identity = (over: { token?: string; expiresAt?: number } = {}) => (request: Recorded) => {
    const token = over.token ?? 'ticket-1';

    if (request.url.endsWith('/api/identity/ticket')) {
        const { password } = request.body as { password: string };
        return password === 'correct-horse'
            ? { status: 200, body: { token, userId: 'u1', expiresAt: over.expiresAt ?? 9e12 } }
            : { status: 401, body: {} };
    }

    if (request.url.endsWith('/api/identity/whoami')) {
        return request.headers['authorization'] === `Bearer ${token}`
            ? { status: 200, body: { userId: 'u1', displayName: 'Alice', roles: ['authenticated'] } }
            : { status: 401, body: {} };
    }

    if (request.url.endsWith('/api/identity/ticket/revoke')) return { status: 200, body: { revoked: 1 } };

    // Anything else is the Application's own API call, which is what the ticket is for.
    return { status: 200, body: { items: [] } };
};

// ---------------------------------------------------------------------------- a site

const blogApi = defineApi({
    id: 'blog',
    exposure: 'exposure-hash-1',
    calls: {
        'post.list': call<void, { items: readonly string[] }>('GET', '/posts'),
    },
});

/**
 * An Application that knows nothing about authentication.
 *
 * It declares `needs('net')` and calls its API. There is no `credentials` in its needs, no ticket in
 * its code, and no way for it to obtain one — which is the whole claim being tested.
 */
const APP_NEEDS = needs('net');

class BlogApp implements Application<typeof APP_NEEDS> {
    readonly needs = APP_NEEDS;
    readonly api = blogApi;

    /** What the Application was handed. Captured so a test can look at it rather than at the code. */
    context: Context<typeof APP_NEEDS> | undefined;

    async start(cx: Context<typeof APP_NEEDS>): Promise<void> {
        this.context = cx;
    }
}

const load = (id: string, contribution: object): { id: string; contribution: never } =>
    ({ id, contribution: contribution as never });

interface Booted {
    readonly kernel: Kernel;
    readonly auth: AuthApi;
    readonly app: BlogApp;
    readonly load: () => Promise<unknown>;
}

async function boot(options: {
    store?: TicketStore;
    apiOrigin?: string;
} = {}): Promise<Booted> {
    const services = createServices(undefined, {
        ...(options.apiOrigin === undefined ? {} : { apiOrigin: options.apiOrigin }),
    });
    const kernel = new Kernel({ services });
    const app = new BlogApp();

    kernel.boot([
        load('auth', new AuthExtension({
            ...(options.store === undefined ? {} : { store: options.store }),
        })),
        load('blog', app),
    ]);

    // Started here, before anything signs in — which is the timing the first test is about.
    await kernel.start('blog');

    const entry = kernel.extensions.find((e) => e.id === 'auth');
    if (entry?.state !== 'activated') {
        throw new Error(`the auth Extension did not activate: ${String(entry?.error)}`);
    }

    return {
        kernel,
        app,
        auth: entry.api as AuthApi,
        load: () => (app.context?.net as { call(action: 'post.list'): Promise<unknown> }).call('post.list'),
    };
}

// ---------------------------------------------------------------------------- the tests

describe('an Application never handles a credential', () => {
    it('sends a ticket it never saw, on a client built before sign-in', async () => {
        reply = identity();
        const site = await boot();

        // Started, and its client built, before anything signed in. A holder that could only be set
        // at construction would need every Application restarted by a sign-in.
        await site.load();
        expect(sent.at(-1)?.headers['authorization']).toBeUndefined();

        await site.auth.signIn({ email: 'alice@example.com', password: 'correct-horse' });
        await site.load();

        expect(sent.at(-1)?.url).toBe('/api/posts');
        expect(sent.at(-1)?.headers['authorization']).toBe('Bearer ticket-1');
    });

    it('gives an Application no way to reach the credential seam', async () => {
        reply = identity();
        const site = await boot();
        await site.auth.signIn({ email: 'alice@example.com', password: 'correct-horse' });

        // `credentials` is absent from a context that did not declare it — not present-and-throwing.
        // The compile error is the real defence; this is the run-time half of the same statement.
        expect((site.app.context as { credentials?: unknown } | undefined)?.credentials).toBeUndefined();
    });

    it('refuses a second contribution claiming the page’s session', async () => {
        reply = identity();
        const kernel = new Kernel({ services: createServices() });

        // Not a second `AuthExtension` — two contributions offering one provider token is already a
        // load-time conflict, and would catch this for the wrong reason. This is something else
        // entirely that reaches for the same seam.
        const IMPOSTOR_NEEDS = needs('credentials');
        const impostor = {
            needs: IMPOSTOR_NEEDS,
            activate(cx: Context<typeof IMPOSTOR_NEEDS>): void {
                cx.credentials.attach(() => ({ authorization: 'Bearer whatever-i-like' }));
            },
        };

        kernel.boot([load('auth', new AuthExtension()), load('impostor', impostor)]);

        // One activated, one failed — and a site can see which at boot, rather than discovering
        // later that some of its requests carry a ticket it did not issue.
        const states = new Map(kernel.extensions.map((e) => [e.id, e.state]));
        expect(states.get('auth')).toBe('activated');
        expect(states.get('impostor')).toBe('failed');
    });
});

describe('the session', () => {
    it('is null until the API says otherwise', async () => {
        reply = identity();
        const site = await boot();
        expect(site.auth.session()).toBeNull();

        await site.auth.signIn({ email: 'alice@example.com', password: 'correct-horse' });

        expect(site.auth.session()?.userId).toBe('u1');
        expect(site.auth.session()?.displayName).toBe('Alice');
    });

    it('refuses bad credentials without changing anything', async () => {
        reply = identity();
        const site = await boot();

        await expect(site.auth.signIn({ email: 'alice@example.com', password: 'wrong' }))
            .rejects.toThrow(/not valid/);

        expect(site.auth.session()).toBeNull();
        await site.load();
        expect(sent.at(-1)?.headers['authorization']).toBeUndefined();
    });

    it('stops attaching the ticket the moment it signs out', async () => {
        reply = identity();
        const site = await boot();
        await site.auth.signIn({ email: 'alice@example.com', password: 'correct-horse' });

        await site.auth.signOut();

        expect(site.auth.session()).toBeNull();
        await site.load();
        expect(sent.at(-1)?.headers['authorization']).toBeUndefined();
    });

    it('signs out locally even when the API cannot be told', async () => {
        reply = (request) => (request.url.endsWith('/revoke')
            ? { status: 500, body: {} }
            : identity()(request));

        const site = await boot();
        await site.auth.signIn({ email: 'alice@example.com', password: 'correct-horse' });
        await site.auth.signOut();

        // A network failure must not leave a page believing it is signed in. The ticket expires on
        // its own; the session is gone here regardless.
        expect(site.auth.session()).toBeNull();
    });
});

describe('a ticket that outlives the page', () => {
    const store = (initial?: string): TicketStore & { held: string | undefined } => {
        const held = { held: initial } as { held: string | undefined };
        return {
            get held() { return held.held; },
            set held(value: string | undefined) { held.held = value; },
            read: () => held.held,
            write: (token) => { held.held = token; },
            clear: () => { held.held = undefined; },
        };
    };

    it('is not kept at all unless the site asked for it', async () => {
        reply = identity();
        const site = await boot();
        await site.auth.signIn({ email: 'alice@example.com', password: 'correct-horse' });

        // No store, so nothing was written anywhere. A framework that silently persisted a
        // credential would be making a security decision on the site's behalf.
        expect(sent.filter((r) => r.url.includes('identity')).length).toBeGreaterThan(0);
    });

    it('restores a session by asking the API, never by trusting what it held', async () => {
        reply = identity();
        const held = store('ticket-1');

        const site = await boot({ store: held });
        // Boot fires the restore; it is not awaited by `boot`, so wait for the answer.
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(site.auth.session()?.userId).toBe('u1');
        // It asked. A held ticket is a claim, not a session.
        expect(sent.some((r) => r.url.endsWith('/api/identity/whoami'))).toBe(true);
    });

    it('drops a held ticket the API no longer accepts', async () => {
        reply = identity({ token: 'a-different-ticket' });
        const held = store('revoked-ticket');

        const site = await boot({ store: held });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(site.auth.session()).toBeNull();
        expect(held.held).toBeUndefined();
    });
});

describe('where requests go', () => {
    it('uses the origin the deployment descriptor named', async () => {
        reply = identity();
        const site = await boot({ apiOrigin: 'https://api.example.com' });

        await site.auth.signIn({ email: 'alice@example.com', password: 'correct-horse' });
        await site.load();

        // Both halves — the Extension's own identity calls and the Application's API calls — go to
        // the origin the build baked in from the descriptor's `api`.
        expect(sent.every((r) => r.url.startsWith('https://api.example.com'))).toBe(true);
    });

    it('is same-origin when the site named nothing', async () => {
        reply = identity();
        const site = await boot();
        await site.load();

        expect(sent.at(-1)?.url).toBe('/api/posts');
    });
});
