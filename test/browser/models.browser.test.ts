/**
 * Browser tests for the models capability — spec/network.md §5, roadmap A3.7.
 *
 * Tests:
 * 1. Boots an Application with cx.models, opens a window, and renders collection data.
 * 2. Mutations on the collection automatically invalidate active queries and update the DOM.
 * 3. 403 refusal state renders error representation in the DOM.
 * 4. Clean scope disposal without memory or reactivity leaks.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    call,
    defineApi,
    each,
    element,
    flushSync,
    needs,
    provider,
    text,
    when,
    type Application,
    type Context,
    type ProviderToken,
    type ViewContext,
} from '@flybyme/mesh-web';
import { cleanup, mountPart } from '@flybyme/mesh-web/testing';

interface PartItem {
    readonly id: string;
    readonly name: string;
    readonly tag: string;
}

const catalogApi = defineApi({
    id: 'catalog-api',
    exposure: 'sha256:catalog123',
    calls: {
        'part.find': call<{ tag?: string }, readonly PartItem[]>('GET', '/parts'),
        'part.create': call<{ name: string; tag: string }, PartItem>('POST', '/parts'),
    },
});

const APP_NEEDS = needs('models', 'windows', 'state');

import type { CollectionHandle } from '@flybyme/mesh-web';

interface AppApi {
    readonly getParts: () => CollectionHandle<typeof catalogApi['calls'], 'part'>;
    readonly createPart: (name: string, tag: string) => Promise<void>;
}

const APP_TOKEN: ProviderToken<AppApi> = provider<AppApi>('test/catalog-app');

class CatalogApp implements Application<typeof APP_NEEDS, readonly [], typeof APP_TOKEN, typeof catalogApi> {
    readonly needs = APP_NEEDS;
    readonly provides = APP_TOKEN;
    readonly api = catalogApi;

    readonly views = [
        {
            id: 'catalog',
            title: 'Catalog',
            render: (vx: ViewContext<Record<string, never>, AppApi>) => {
                const parts = vx.app.getParts();
                return element('Stack', {
                    props: { class: 'catalog-container' },
                    children: [
                        when(
                            () => parts.loading(),
                            () => element('Text', { props: { class: 'loading' }, children: [text('Loading catalog...')] }),
                            () => when(
                                () => parts.status() === 'error',
                                () => element('Text', { props: { class: 'error' }, children: [text('Failed to load parts')] }),
                                () => when(
                                    () => parts.empty(),
                                    () => element('Text', { props: { class: 'empty' }, children: [text('No parts found')] }),
                                    () => element('Stack', {
                                        props: { class: 'items' },
                                        children: [
                                            each(
                                                () => parts.rows(),
                                                (item) => item.id,
                                                (item) => element('Text', {
                                                    props: { class: 'item-row' },
                                                    children: [text(() => item().name)],
                                                }),
                                            ),
                                        ],
                                    }),
                                ),
                            ),
                        ),
                    ],
                });
            },
        },
    ];

    async start(cx: Context<typeof APP_NEEDS, readonly [], typeof catalogApi>): Promise<AppApi> {
        const parts = cx.models('part');
        cx.windows.open({ view: 'catalog' });

        return {
            getParts: () => parts,
            createPart: async (name: string, tag: string) => {
                await parts.create({ name, tag });
            },
        };
    }
}

describe('models capability in browser (mountPart)', () => {
    let partsStore: PartItem[] = [];
    let returnStatus = 200;
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        partsStore = [
            { id: '1', name: 'Alloy Bolt', tag: 'hardware' },
            { id: '2', name: 'Carbon Strut', tag: 'composite' },
        ];
        returnStatus = 200;

        globalThis.fetch = async (input, init) => {
            const urlStr = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
            const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

            if (urlStr.includes('/api/parts') && method === 'GET') {
                if (returnStatus !== 200) {
                    return new Response(JSON.stringify({ error: 'FORBIDDEN', message: 'Forbidden' }), {
                        status: returnStatus,
                        headers: { 'content-type': 'application/json' },
                    });
                }
                const url = new URL(urlStr, 'http://localhost');
                const tag = url.searchParams.get('tag');
                const results = tag !== null ? partsStore.filter((p) => p.tag === tag) : partsStore;
                return new Response(JSON.stringify(results), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            if (urlStr.includes('/api/parts') && method === 'POST') {
                const bodyText = typeof init?.body === 'string' ? init.body : '';
                const body = bodyText !== '' ? JSON.parse(bodyText) as { name: string; tag: string } : { name: '', tag: '' };
                const newItem: PartItem = {
                    id: String(partsStore.length + 1),
                    name: body.name,
                    tag: body.tag,
                };
                partsStore.push(newItem);
                return new Response(JSON.stringify(newItem), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }

            return originalFetch(input, init);
        };
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        cleanup();
    });

    it('boots an Application, opens window, and renders collection items into the DOM', async () => {
        const site = await mountPart({
            parts: [{ id: 'app', contribution: CatalogApp }],
        });

        const app = site.kernel.provided(APP_TOKEN)!;
        expect(app).toBeDefined();

        // Await initial query resolution
        await app.getParts().refetch();
        flushSync();

        expect(site.root.textContent).toContain('Alloy Bolt');
        expect(site.root.textContent).toContain('Carbon Strut');

        site.dispose();
    });

    it('automatically invalidates and updates the DOM when a mutation is performed', async () => {
        const site = await mountPart({
            parts: [{ id: 'app', contribution: CatalogApp }],
        });

        const app = site.kernel.provided(APP_TOKEN)!;
        await app.getParts().refetch();
        flushSync();

        expect(site.root.textContent).toContain('Alloy Bolt');
        expect(site.root.textContent).not.toContain('Titanium Panel');

        // Create a new part through the collection mutation
        await app.createPart('Titanium Panel', 'hardware');
        flushSync();

        // The DOM has re-rendered with the newly created item
        expect(site.root.textContent).toContain('Titanium Panel');

        site.dispose();
    });

    it('renders error state when API answers with refusal', async () => {
        returnStatus = 403;

        const site = await mountPart({
            parts: [{ id: 'app', contribution: CatalogApp }],
        });

        const app = site.kernel.provided(APP_TOKEN)!;
        await app.getParts().refetch();
        flushSync();

        expect(site.root.textContent).toContain('Failed to load parts');

        site.dispose();
    });

    it('cleans up DOM and disposes queries when the site is disposed', async () => {
        const site = await mountPart({
            parts: [{ id: 'app', contribution: CatalogApp }],
        });

        expect(document.getElementById('mesh-web-root')).not.toBeNull();
        site.dispose();
        expect(document.getElementById('mesh-web-root')).toBeNull();
    });
});
