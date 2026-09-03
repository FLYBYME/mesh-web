/**
 * The browser talking to a real API.
 *
 * The last big seam verified only by imagination. `net` had twenty tests against a fake transport;
 * mesh-api had a hundred against a fake browser; the generated client compiled against a descriptor
 * nothing had served. Three times in one day a seam like that turned out to have a bug in it, so
 * this is the fourth check of the same kind — real Chromium, real HTTP, a real mesh-api process, and
 * a client generated from that API's own exposure list.
 *
 * **Needs the API running:** `npm run example:blog` in mesh-api. Skipped rather than failed when it
 * is not, because "the server is not up" and "the code is broken" should not look the same.
 */

import { describe, expect, it } from 'vitest';

import {
    createClient, describe as describeError, fetchTransport, withHeaders,
    createRegistry, each, element, mountView, text, PRIMITIVES,
} from '../../src/index.js';
import { blogApi, type PostListOutputItem } from '../../browser/generated/blog-api.js';

const ORIGIN = 'http://127.0.0.1:5005';

const reachable = await fetch(`${ORIGIN}/_api/status`)
    .then((r) => r.ok)
    .catch(() => false);

const clientFor = (ticket: string | undefined) =>
    createClient(blogApi, {
        transport: withHeaders(
            fetchTransport(ORIGIN),
            (): Readonly<Record<string, string>> =>
                (ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }),
        ),
    });

describe.skipIf(!reachable)('a browser calling a real mesh-api', () => {
    it('reads posts, typed from the API’s own schema', async () => {
        const result = await clientFor('alice-ticket').call('post.list', {});

        if (!result.ok) throw new Error(`expected ok, got ${describeError(result.error)}`);

        // Inference, not assertion: if `value` were `unknown` these lines would not compile.
        const organization: string = result.value.organization;
        const first: PostListOutputItem | undefined = result.value.items[0];

        expect(organization).toBe('org-a');
        expect(result.value.items.length).toBeGreaterThan(0);
        expect(typeof first?.published).toBe('boolean');
    });

    it('is anonymous without a ticket, and says so as a named failure', async () => {
        const result = await clientFor(undefined).call('post.list', {});

        expect(result.ok).toBe(false);
        if (result.ok) return;

        // A named case, not a status code — the caller's decision differs per case, and a number
        // does not say which decision to make.
        expect(result.error.kind).toBe('unauthorized');
        expect(describeError(result.error)).toBe('You need to sign in.');
    });

    it('sees only its own organization, decided by the API and not by the request', async () => {
        const alice = await clientFor('alice-ticket').call('post.list', {});
        const bob = await clientFor('bob-ticket').call('post.list', {});

        if (!alice.ok || !bob.ok) throw new Error('expected both to succeed');

        expect(alice.value.organization).toBe('org-a');
        expect(bob.value.organization).toBe('org-b');

        // The scope came from each caller's memberships. Nothing the browser sent chose it, and
        // there is no argument it could have passed to choose differently.
        const aliceSlugs = alice.value.items.map((p) => p.slug);
        expect(aliceSlugs).not.toContain('other');
        expect(bob.value.items.map((p) => p.slug)).toEqual(['other']);
    });

    it('refuses a write the caller has no permission for', async () => {
        const result = await clientFor('bob-ticket').call('post.create', { title: 'Bob was here' });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('forbidden');
    });

    it('will not let a caller act on another organization’s record by naming it', async () => {
        // The attack the scope mechanism exists to stop: bob knows the slug and asks for it anyway.
        const result = await clientFor('bob-ticket').call('post.publish', { slug: 'welcome' });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(['forbidden', 'not_found']).toContain(result.error.kind);
    });

    it('agrees with the API about which exposure it was generated from', async () => {
        // spec/network.md §6, both halves live at once: the client carries the hash it was built
        // from, the API reports its own, and a mismatch is a `stale` failure rather than a
        // confusing 404 three calls later.
        const status = await fetch(`${ORIGIN}/_api/status`).then((r) => r.json() as Promise<{ exposure: string }>);
        expect(status.exposure).toBe(blogApi.exposure);

        const result = await clientFor('alice-ticket').call('post.list', {});
        expect(result.ok).toBe(true);
    });

    it('notices when it has gone stale', async () => {
        // The same client, lying about which exposure it came from.
        const stale = createClient(
            { ...blogApi, exposure: 'sha256:from-an-older-deploy' },
            { transport: withHeaders(fetchTransport(ORIGIN), () => ({ authorization: 'Bearer alice-ticket' })) },
        );

        const result = await stale.call('post.list', {});
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.kind).toBe('stale');
    });

    it('renders what the API returned, through the real view layer', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);

        const result = await clientFor('alice-ticket').call('post.list', {});
        if (!result.ok) throw new Error('expected ok');

        const items = result.value.items;
        const instance = mountView(host, {
            windowId: 'w1',
            decl: {
                id: 'main',
                title: 'Posts',
                render: () => element('List', {
                    children: [each(
                        () => items,
                        (p: PostListOutputItem) => p.slug,
                        (p: () => PostListOutputItem) => element('ListItem', { children: [text(() => p().title)] }),
                    )],
                }),
            } as never,
            api: undefined,
            params: {},
            windows: { setTitle: () => {}, close: () => {} } as never,
            render: { components: createRegistry(PRIMITIVES), dispatch: { dispatch: () => {} } },
            onCommand: () => {},
        });

        // The whole path, in one assertion: a zod schema in a contract, through JSON Schema in a
        // descriptor, through a generated type, over HTTP, into a description, into the DOM.
        expect(host.querySelectorAll('li').length).toBe(items.length);
        expect(host.textContent).toContain(items[0]!.title);

        instance.dispose();
        host.remove();
    });
});
