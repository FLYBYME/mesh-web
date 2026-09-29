/**
 * Every domain on the account: searchable, paged, sortable — with the search and page in the URL.
 *
 * `query` makes `?q=…&page=…` this view's reactive input. Typing in the search box *replaces* the
 * URL (no history entry per keystroke); the view is not rebuilt, `this.query()` changes, and the
 * resource that read it refetches. So the add-domain form stays open, the table keeps its sort, and
 * a reload or a pasted link lands on exactly this list.
 */

import {
    command, element, Link, resource, Router, signal, text, View, when, type Node,
} from '@flybyme/mesh-web';
import { z } from 'zod';
import { DOMAIN_SORTS, type Domain, type DomainSort } from '../../api/fake-api.js';
import { Domains, PAGE_SIZE } from '../../services/domains.service.js';
import { emptyState, loaded, pageHeader } from '../../ui/async.js';
import { commandForm } from '../../ui/command-form.js';
import { dataTable } from '../../ui/data-table.js';
import { Pager } from '../../ui/pager.js';
import { DomainView } from './domain-view.js';

/** One table class for domains, declared once: every `cell` below is checked against `Domain`. */
const DomainTable = dataTable<Domain>();

export class DomainListView extends View({
    inject: { domains: Domains, router: Router },
    query: z.object({
        q: z.string().default(''),
        page: z.coerce.number().int().positive().default(1),
        sort: z.enum(DOMAIN_SORTS).default('name'),
        dir: z.enum(['asc', 'desc']).default('asc'),
    }),
    title: 'Domains · Harbor DNS',
}) {
    readonly list = resource(() => {
        const { q, page, sort, dir } = this.query();
        return this.inject.domains.list(q, page, sort, dir === 'asc' ? 1 : -1);
    });

    /** This list's URL with some of its state changed — every link and control here goes through it. */
    readonly at = (change: { q?: string; page?: number; sort?: DomainSort; dir?: 'asc' | 'desc' }): string =>
        this.inject.router.href(DomainListView, { ...this.query(), ...change });
    readonly adding = signal(false);

    readonly AddDomainForm = commandForm(this.inject.domains.create, {
        name: { label: 'Domain', placeholder: 'example.com' },
    });

    readonly add = command({ title: 'Add domain', key: 'alt+a', run: () => this.adding.set(true) });

    render(): Node {
        const { router } = this.inject;
        const q = (): string => this.query().q;

        return element('Stack', {
            props: { 'data-page': 'domains' },
            children: [
                pageHeader('Domains', [
                    element('Button', {
                        props: { class: 'ui-primary', title: 'Add domain (alt+a)' },
                        intents: { activate: { action: this.on(() => void this.add.run()) } },
                        children: [text('Add domain')],
                    }),
                ]),

                when(() => this.adding(), () => element('Stack', {
                    props: { class: 'ui-panel' },
                    children: [
                        this.mount(this.AddDomainForm, {
                            onDone: (domain) => {
                                this.adding.set(false);
                                router.navigate(router.href(DomainView, { domain: domain.name }));
                            },
                        }),
                        element('Button', { intents: { activate: { action: this.on(() => this.adding.set(false)) } }, children: [text('Cancel')] }),
                    ],
                })),

                element('Input', {
                    props: { type: 'search', 'aria-label': 'Search domains', placeholder: 'Search…', value: q, class: 'ui-search' },
                    intents: {
                        change: {
                            action: this.on((v) => router.replace(this.at({ q: typeof v === 'string' ? v : '', page: 1 }))),
                        },
                    },
                }),

                loaded(this.list, (page) => when(
                    () => page().total > 0,
                    () => [
                        this.mount(DomainTable, {
                            label: 'Domains',
                            rows: () => page().items,
                            key: (d) => d.name,
                            // The server sorts, before paging; the table shows the URL's sort and
                            // turns a header click into a new URL (back to page 1).
                            sort: {
                                current: () => ({ key: this.query().sort, direction: this.query().dir === 'asc' ? 1 : -1 }),
                                change: (next) => {
                                    const sort = DOMAIN_SORTS.find((s) => s === next.key);
                                    if (sort !== undefined) router.navigate(this.at({ sort, dir: next.direction === 1 ? 'asc' : 'desc', page: 1 }));
                                },
                            },
                            columns: [
                                {
                                    header: 'Domain',
                                    cell: (d) => this.mount(Link, { href: () => router.href(DomainView, { domain: d().name }), children: [text(() => d().name)] }),
                                    sortKey: 'name',
                                },
                                {
                                    header: 'Status',
                                    cell: (d) => element('Badge', { props: { 'data-status': () => d().status }, children: [text(() => d().status)] }),
                                    sortKey: 'status',
                                },
                                { header: 'Added', cell: (d) => text(() => d().created), sortKey: 'created', align: 'end' },
                            ],
                        }),
                        this.mount(Pager, {
                            page: () => this.query().page,
                            pages: () => Math.ceil(page().total / PAGE_SIZE),
                            href: (n) => this.at({ page: n }),
                        }),
                    ],
                    () => emptyState(
                        () => (q() === '' ? 'No domains yet' : `Nothing matches “${q()}”`),
                        () => (q() === '' ? 'Add one to start serving DNS for it.' : 'Try a shorter search.'),
                    ),
                ), 'Loading domains…'),
            ],
        });
    }
}
