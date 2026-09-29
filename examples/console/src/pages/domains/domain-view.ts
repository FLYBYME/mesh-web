/**
 * One domain: its records, adding and removing them, and removing the domain.
 *
 * `params.domain` is path state — fixed for this instance. Going to another domain is another
 * instance, so nothing typed into this page's form can leak onto the next domain's.
 *
 * Nothing here refetches by hand. The service's writes bump `Domains.changed`, which both resources
 * read, so an added record appears because the list was fetched again, not because this page
 * patched a copy of it.
 */

import { element, Link, resource, Router, text, View, when, type Node } from '@flybyme/mesh-web';
import { z } from 'zod';
import { RECORD_TYPES, type DnsRecord } from '../../api/fake-api.js';
import { Domains } from '../../services/domains.service.js';
import { emptyState, loaded, pageHeader } from '../../ui/async.js';
import { commandForm } from '../../ui/command-form.js';
import { ConfirmButton } from '../../ui/confirm.js';
import { dataTable } from '../../ui/data-table.js';
import { DomainListView } from './domain-list.view.js';

const RecordTable = dataTable<DnsRecord>();

export class DomainView extends View({
    inject: { domains: Domains, router: Router },
    params: z.object({ domain: z.string().min(1) }),
    title: 'Domain · Harbor DNS',
}) {
    readonly domain = resource(() => this.inject.domains.get(this.params.domain));
    readonly records = resource(() => this.inject.domains.records(this.params.domain));

    /** The tab says which domain; the spec's static title is only the fallback. */
    readonly title = (): string => `${this.params.domain} · Harbor DNS`;

    readonly AddRecordForm = commandForm(this.inject.domains.addRecord, {
        type: { label: 'Type', options: RECORD_TYPES },
        name: { label: 'Name', placeholder: '@ or www' },
        value: { label: 'Value', placeholder: '192.0.2.10' },
        ttl: { label: 'TTL (seconds)', type: 'number' },
    });

    render(): Node {
        const { domains, router } = this.inject;
        const name = this.params.domain;

        return element('Stack', {
            props: { 'data-page': 'domain' },
            children: [
                this.mount(Link, { href: router.href(DomainListView), class: 'ui-back', children: [text('← All domains')] }),
                pageHeader(name, [
                    this.mount(ConfirmButton, {
                        label: 'Remove domain',
                        question: `Remove ${name} and all its records? Its DNS stops being served.`,
                        confirm: 'Remove',
                        run: async () => {
                            await domains.remove.run({ name });
                            router.navigate(router.href(DomainListView));
                        },
                    }),
                ]),

                // A domain that does not exist is the resource's error, shown where the page would be.
                loaded(this.domain, (domain) => element('Text', {
                    props: { class: 'domain-status' },
                    children: [text(() => `Status: ${domain().status} · added ${domain().created}`)],
                })),

                element('Heading', { props: { level: 2 }, children: [text('Records')] }),
                loaded(this.records, (records) => [
                    this.mount(RecordTable, {
                        label: `Records for ${name}`,
                        rows: records,
                        key: (r) => r.id,
                        columns: [
                            { header: 'Type', cell: (r) => element('Badge', { children: [text(() => r().type)] }), compare: (a, b) => a.type.localeCompare(b.type) },
                            { header: 'Name', cell: (r) => text(() => r().name), compare: (a, b) => a.name.localeCompare(b.name) },
                            { header: 'Value', cell: (r) => element('Span', { props: { code: true }, children: [text(() => r().value)] }) },
                            { header: 'TTL', cell: (r) => text(() => String(r().ttl)), compare: (a, b) => a.ttl - b.ttl, align: 'end' },
                            {
                                header: '',
                                cell: (r) => this.mount(ConfirmButton, {
                                    label: 'Remove',
                                    question: `Remove the ${r().type} record ${r().name}?`,
                                    confirm: 'Remove record',
                                    run: () => domains.removeRecord.run({ id: r().id }),
                                }),
                            },
                        ],
                    }),
                    when(() => records().length === 0, () => emptyState('No records', 'Add one below.')),
                ], 'Loading records…'),

                element('Heading', { props: { level: 2 }, children: [text('Add a record')] }),
                element('Stack', {
                    props: { class: 'ui-panel' },
                    children: [this.mount(this.AddRecordForm, {
                        fixed: { domain: name },
                        initial: { type: 'A', ttl: '3600' },
                        submitLabel: 'Add record',
                    })],
                }),
            ],
        });
    }
}
