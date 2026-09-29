/**
 * Domains and their records: every read and write the console makes, in one place.
 *
 * Reads are plain async functions a view wraps in a `resource`, so the view owns the loading state
 * and it dies with the view. Writes are commands — one object each, with the input schema that
 * forms are built from and that the command enforces before anything is sent.
 *
 * `changed` is the cache story, deliberately small: every write bumps it, and every resource that
 * read it refetches. A real app with more data grows this into per-collection versions (or uses
 * `cx.models`); the shape — views read, services write and announce — stays.
 */

import { command, Service, signal } from '@flybyme/mesh-web';
import { z } from 'zod';
import { FakeApi, RECORD_TYPES, type DnsRecord, type Domain, type Page } from '../api/fake-api.js';

const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export const PAGE_SIZE = 8;

export const domainName = z.string().trim().toLowerCase().regex(DOMAIN, 'Enter a domain like example.com.');

export class Domains extends Service({ inject: { api: FakeApi } }) {
    readonly changed = signal(0);

    list(q: string, page: number): Promise<Page<Domain>> {
        this.changed();
        return this.inject.api.listDomains({ q, page, pageSize: PAGE_SIZE });
    }

    get(name: string): Promise<Domain> {
        this.changed();
        return this.inject.api.getDomain(name);
    }

    records(domain: string): Promise<readonly DnsRecord[]> {
        this.changed();
        return this.inject.api.listRecords(domain);
    }

    readonly create = command({
        title: 'Add domain',
        input: z.object({ name: domainName }),
        run: async ({ name }) => {
            const domain = await this.inject.api.createDomain(name);
            this.#announce();
            return domain;
        },
    });

    readonly remove = command({
        title: 'Remove domain',
        input: z.object({ name: z.string() }),
        run: async ({ name }) => {
            await this.inject.api.deleteDomain(name);
            this.#announce();
        },
    });

    readonly addRecord = command({
        title: 'Add record',
        input: z.object({
            domain: z.string(),
            type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT']),
            name: z.string().trim().min(1, 'Required — use @ for the domain itself.').max(63),
            value: z.string().trim().min(1, 'Required.'),
            ttl: z.coerce.number().int().min(60, 'At least 60 seconds.').max(86400, 'At most a day.').default(3600),
        }).superRefine((record, ctx) => {
            // A rule that spans fields, reported on the one the person must change.
            if (record.type === 'A' && !IPV4.test(record.value)) {
                ctx.addIssue({ code: 'custom', path: ['value'], message: 'An A record points at an IPv4 address.' });
            }
        }),
        run: async (record) => {
            const created = await this.inject.api.createRecord(record);
            this.#announce();
            return created;
        },
    });

    readonly removeRecord = command({
        title: 'Remove record',
        input: z.object({ id: z.string() }),
        run: async ({ id }) => {
            await this.inject.api.deleteRecord(id);
            this.#announce();
        },
    });

    #announce(): void {
        this.changed.set(this.changed() + 1);
    }
}

export { RECORD_TYPES };
