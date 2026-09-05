/**
 * The `http` capability.
 *
 * It exists because the framework's own first Extension broke the model: `mesh-auth` declared
 * `needs('credentials', 'state', 'log')` and then called global `fetch` — network access nobody
 * granted, nobody declared, and nobody could see in a manifest. That is the exact failure the
 * capability model is for, committed by the part best placed to know better.
 *
 * The tests that matter here are about **what it refuses to send**, because those are the ones whose
 * absence is invisible: a request that quietly carried the page's ticket to a third party would work
 * perfectly and leak the session.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createContext, createServices } from '../src/kernel/broker.js';
import { needs } from '../src/contribution/capabilities.js';

const identity = { id: 'part-1', declaredBy: 'test' };
const noProviders = () => undefined;

/** A context with exactly the declared capabilities, as the kernel builds one. */
const contextWith = (...names: Parameters<typeof needs>) => {
    const services = createServices();
    const handle = createContext(identity, needs(...names), [], noProviders, services);
    return { context: handle.context as Record<string, never>, services };
};

const respondWith = (
    body: unknown,
    status = 200,
): ReturnType<typeof vi.fn> => {
    const fetchMock = vi.fn(async () => new Response(
        body === undefined ? null : JSON.stringify(body),
        { status, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
};

afterEach(() => { vi.unstubAllGlobals(); });

describe('it is a declared capability, not an ambient one', () => {
    it('is absent when it was not declared', () => {
        // The whole of "narrowed": a part that never asked for network access does not get an
        // object it could use to make a request.
        const { context } = contextWith('state', 'log');
        expect(context['http']).toBeUndefined();
    });

    it('is present when it was', () => {
        const { context } = contextWith('http');
        expect(context['http']).toBeDefined();
    });
});

describe('what it never sends', () => {
    it('omits cookies', async () => {
        // This page authenticates with a bearer ticket. An ambient cookie riding along on an
        // outbound request is a CSRF surface nobody asked for.
        const fetchMock = respondWith({ ok: true });
        const { context } = contextWith('http');

        await (context['http'] as never as { get(u: string): Promise<unknown> }).get('/thing');

        expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit' });
    });

    it('does not attach the page credentials, even when something has attached them', async () => {
        // The one that matters. `mesh` goes through the credential seam because it goes to the
        // site's own API; this goes wherever it is told, so attaching the ticket would let any part
        // holding needs('http') post the page's session to an origin of its choosing.
        const fetchMock = respondWith({ ok: true });
        const services = createServices();
        services.credentials.owner = 'auth';
        services.credentials.headers = () => ({ authorization: 'Bearer secret-ticket' });

        const handle = createContext(identity, needs('http'), [], noProviders, services);
        const http = (handle.context as never as { http: { get(u: string): Promise<unknown> } }).http;

        await http.get('https://somewhere-else.example/collect');

        const sent = JSON.stringify(fetchMock.mock.calls[0]?.[1] ?? {});
        expect(sent).not.toContain('secret-ticket');
        expect(sent).not.toContain('authorization');
    });

    it('does send a header the caller passed itself', async () => {
        // Which is how the auth Extension legitimately sends the ticket it holds: explicitly, per
        // request, on a call to an endpoint it named.
        const fetchMock = respondWith({ userId: 'u1' });
        const { context } = contextWith('http');
        const http = context['http'] as never as {
            get(u: string, i?: { headers?: Record<string, string> }): Promise<unknown>;
        };

        await http.get('/identity/whoami', { headers: { authorization: 'Bearer mine' } });

        expect(JSON.stringify(fetchMock.mock.calls[0]?.[1])).toContain('Bearer mine');
    });
});

describe('a status is an answer, not an exception', () => {
    const call = async (status: number, body: unknown = { detail: 'x' }) => {
        respondWith(body, status);
        const { context } = contextWith('http');
        const http = context['http'] as never as {
            get<T>(u: string): Promise<{ ok: boolean; status: number; body: T | undefined }>;
        };
        return http.get<{ detail: string }>('/thing');
    };

    it('reports 401 without throwing', async () => {
        // A client that cannot tell 401 from 500 reads an outage as a sign-out, and drops a
        // perfectly good ticket because a server was briefly unwell.
        const answer = await call(401);
        expect(answer.ok).toBe(false);
        expect(answer.status).toBe(401);
    });

    it('reports 500 the same way, and differently', async () => {
        const answer = await call(500);
        expect(answer.status).toBe(500);
    });

    it('parses a body on success', async () => {
        respondWith({ detail: 'here' });
        const { context } = contextWith('http');
        const http = context['http'] as never as {
            get<T>(u: string): Promise<{ ok: boolean; body: T | undefined }>;
        };

        const answer = await http.get<{ detail: string }>('/thing');
        expect(answer.ok).toBe(true);
        expect(answer.body?.detail).toBe('here');
    });

    it('survives a response that is not JSON', async () => {
        // A 204, or an HTML error page from a proxy. The status is still the answer.
        vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>nope', { status: 502 })));
        const { context } = contextWith('http');
        const http = context['http'] as never as {
            get<T>(u: string): Promise<{ status: number; body: T | undefined }>;
        };

        const answer = await http.get('/thing');
        expect(answer.status).toBe(502);
        expect(answer.body).toBeUndefined();
    });
});

describe('post', () => {
    it('sends JSON and says so', async () => {
        const fetchMock = respondWith({ token: 't' });
        const { context } = contextWith('http');
        const http = context['http'] as never as {
            post(u: string, b: unknown): Promise<unknown>;
        };

        await http.post('/identity/ticket', { email: 'a@b.c', password: 'pw' });

        const init = fetchMock.mock.calls[0]?.[1] as { method: string; body: string; headers: Record<string, string> };
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ email: 'a@b.c', password: 'pw' });
        expect(init.headers['content-type']).toBe('application/json');
    });
});

describe('what it does not claim to do', () => {
    it('cannot stop a part calling global fetch', async () => {
        // Stated as a test because it is the honest limit of the whole model: `fetch` is on
        // globalThis and the DOM lib types it, so a determined author routes around this and nothing
        // in the kernel can prevent it. `needs('http')` makes the honest case auditable; a build
        // scanning the bundle catches the careless one; only CSP on the generated page enforces.
        const fetchMock = respondWith({ ok: true });
        const { context } = contextWith('state');

        expect(context['http']).toBeUndefined();
        await fetch('https://anywhere.example');
        expect(fetchMock).toHaveBeenCalled();
    });
});

describe('it is logged against the part that called', () => {
    it('records the request on the kernel log', async () => {
        // So "which part is talking to what" is answerable from the page rather than only from a
        // network tab that nobody has open when it matters.
        respondWith({ ok: true });
        const { context, services } = contextWith('http');

        await (context['http'] as never as { get(u: string): Promise<unknown> }).get('/thing');

        const line = services.logs.find((l) => l.message.includes('/thing'));
        expect(line?.source).toBe('part-1');
        expect(line?.message).toContain('200');
    });
});
