/**
 * Live collections through the kernel's real `models` capability — spec/network.md §5.
 *
 * Booted the way a deployed site is: the kernel's `start()`, so `cx.models` is the one the broker
 * builds for the App's declared API, over the real fetch transport (answered here by a stand-in
 * `fetch`). A collection loads into the page, a create made by *pressing a button* updates it, a
 * refusal renders as one, and disposing takes the page away.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import {
    App, call, command, defineApi, each, element, needs, Service, text, View, when,
    type Node,
} from '@flybyme/mesh-web';
import { start, type Started } from '../../src/kernel/start.js';

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

/** The collection, shared: one query for the page, not one per view that shows it. */
class Catalog extends Service({ needs: needs('models'), api: catalogApi }) {
    readonly parts = this.cx.models('part');
    readonly add = command({
        title: 'Add part',
        run: async () => { await this.parts.create({ name: 'Titanium Panel', tag: 'hardware' }); },
    });
}

class CatalogView extends View({ inject: { catalog: Catalog } }) {
    render(): Node {
        const { catalog } = this.inject;
        const parts = catalog.parts;
        return element('Stack', {
            props: { class: 'catalog-container' },
            children: [
                element('Button', {
                    props: { 'aria-label': 'add part' },
                    intents: { activate: { action: this.on(() => void catalog.add.run()) } },
                    children: [text('Add')],
                }),
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
                                        (item) => element('Text', { props: { class: 'item-row' }, children: [text(() => item().name)] }),
                                    ),
                                ],
                            }),
                        ),
                    ),
                ),
            ],
        });
    }
}

class CatalogApp extends App({ needs: needs('models'), api: catalogApi, services: [Catalog], routes: { '/': CatalogView } }) {}

/** Wait until the page says something — the query is asynchronous, and there is no handle to await. */
async function until(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
}

describe('models capability in a real browser, booted by start()', () => {
    let partsStore: PartItem[] = [];
    let returnStatus = 200;
    let started: Started | undefined;
    let original = '';
    const originalFetch = globalThis.fetch;
    const page = (): string => document.getElementById('mesh-web-root')?.textContent ?? '';

    beforeEach(() => {
        original = `${location.pathname}${location.search}`;
        history.replaceState(null, '', '/');
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
                return new Response(JSON.stringify(partsStore), { status: 200, headers: { 'content-type': 'application/json' } });
            }

            if (urlStr.includes('/api/parts') && method === 'POST') {
                const bodyText = typeof init?.body === 'string' ? init.body : '';
                const body = bodyText !== '' ? JSON.parse(bodyText) as { name: string; tag: string } : { name: '', tag: '' };
                const created: PartItem = { id: String(partsStore.length + 1), name: body.name, tag: body.tag };
                partsStore.push(created);
                return new Response(JSON.stringify(created), { status: 200, headers: { 'content-type': 'application/json' } });
            }

            return originalFetch(input, init);
        };
    });

    afterEach(() => {
        started?.dispose();
        started = undefined;
        globalThis.fetch = originalFetch;
        history.replaceState(null, '', original);
    });

    const boot = (): Started => {
        started = start({ application: 'catalog', api: '', parts: [{ id: 'catalog', contribution: CatalogApp }] });
        return started;
    };

    it('renders the collection into the page', async () => {
        boot();
        await until(() => page().includes('Carbon Strut'), 'the parts to load');
        expect(page()).toContain('Alloy Bolt');
    });

    it('updates the page when a create is made — by pressing a button, not by calling it', async () => {
        boot();
        await until(() => page().includes('Alloy Bolt'), 'the parts to load');
        expect(page()).not.toContain('Titanium Panel');

        await userEvent.click(document.querySelector('[aria-label="add part"]')!);
        await until(() => page().includes('Titanium Panel'), 'the new part to appear');
    });

    it('renders a refusal as an error, not as an empty list', async () => {
        returnStatus = 403;
        boot();
        await until(() => page().includes('Failed to load parts'), 'the error state');
        expect(page()).not.toContain('No parts found');
    });

    it('takes the page away when disposed', async () => {
        const booted = boot();
        expect(document.getElementById('mesh-web-root')).not.toBeNull();
        booted.dispose();
        started = undefined;
        expect(document.getElementById('mesh-web-root')).toBeNull();
    });
});
