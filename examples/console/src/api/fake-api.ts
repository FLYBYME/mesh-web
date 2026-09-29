/**
 * The backend, faked: an in-memory DNS provider with latency, so loading states are real.
 *
 * In a real site this file does not exist. Its place is taken by the generated client
 * (`mesh-serve generate`) reached through `cx.mesh`, and the services above it do not change shape:
 * they call something asynchronous that can fail. That is why it is a service like any other and
 * not a module of functions — a test can hand the app a different one, and nothing else knows.
 */

import { Service } from '@flybyme/mesh-web';

export type RecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT';
export const RECORD_TYPES: readonly RecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];

export interface Domain {
    readonly name: string;
    readonly status: 'active' | 'pending';
    readonly created: string;
}

export interface DnsRecord {
    readonly id: string;
    readonly domain: string;
    readonly type: RecordType;
    readonly name: string;
    readonly value: string;
    readonly ttl: number;
}

export interface Page<T> {
    readonly items: readonly T[];
    readonly total: number;
}

export interface User {
    readonly email: string;
    readonly name: string;
}

/** What a failed call throws. `status` is the HTTP-ish code a real client would carry. */
export class ApiError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
        this.name = 'ApiError';
    }
}

const SEED = [
    'surfdns.net', 'example.com', 'example.org', 'harbor.dev', 'lighthouse.io', 'tidepool.app',
    'driftwood.net', 'seagrass.org', 'kelp.dev', 'breakwater.io', 'riptide.app', 'undertow.net',
    'swell.dev', 'estuary.org', 'lagoon.app', 'marina.io', 'jetty.dev', 'shoal.net', 'reef.org',
    'atoll.app', 'cove.dev', 'inlet.io', 'fjord.net',
];

export class FakeApi extends Service({}) {
    /** Milliseconds per call. A test sets 0; the dev page leaves it, so spinners are seen. */
    latency = 250;

    #domains = new Map<string, Domain>(SEED.map((name, i) => [name, {
        name,
        status: i % 7 === 3 ? 'pending' : 'active',
        created: new Date(Date.UTC(2026, 0, 1 + i * 9)).toISOString().slice(0, 10),
    }]));

    #nextId = 1;
    // Field initializers run in order, so this sees the two above.
    #records = new Map<string, DnsRecord>([...this.#domains.keys()].flatMap((domain) => [
        this.#make({ domain, type: 'A', name: '@', value: '192.0.2.10', ttl: 3600 }),
        this.#make({ domain, type: 'CNAME', name: 'www', value: domain, ttl: 3600 }),
    ]).map((r) => [r.id, r]));

    signIn(email: string, password: string): Promise<User> {
        return this.#reply(() => {
            if (password !== 'correct horse') throw new ApiError(401, 'Wrong email or password.');
            return { email, name: email.split('@')[0] ?? email };
        });
    }

    listDomains(query: { readonly q: string; readonly page: number; readonly pageSize: number }): Promise<Page<Domain>> {
        return this.#reply(() => {
            const q = query.q.trim().toLowerCase();
            const all = [...this.#domains.values()]
                .filter((d) => q === '' || d.name.includes(q))
                .sort((a, b) => a.name.localeCompare(b.name));
            const start = (query.page - 1) * query.pageSize;
            return { items: all.slice(start, start + query.pageSize), total: all.length };
        });
    }

    getDomain(name: string): Promise<Domain> {
        return this.#reply(() => {
            const domain = this.#domains.get(name);
            if (domain === undefined) throw new ApiError(404, `No domain ${name}.`);
            return domain;
        });
    }

    createDomain(name: string): Promise<Domain> {
        return this.#reply(() => {
            if (this.#domains.has(name)) throw new ApiError(409, `${name} is already on this account.`);
            const domain: Domain = { name, status: 'pending', created: new Date().toISOString().slice(0, 10) };
            this.#domains.set(name, domain);
            return domain;
        });
    }

    deleteDomain(name: string): Promise<void> {
        return this.#reply(() => {
            this.#domains.delete(name);
            for (const [id, record] of this.#records) if (record.domain === name) this.#records.delete(id);
        });
    }

    listRecords(domain: string): Promise<readonly DnsRecord[]> {
        return this.#reply(() => [...this.#records.values()]
            .filter((r) => r.domain === domain)
            .sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type)));
    }

    createRecord(record: Omit<DnsRecord, 'id'>): Promise<DnsRecord> {
        return this.#reply(() => {
            if (!this.#domains.has(record.domain)) throw new ApiError(404, `No domain ${record.domain}.`);
            return this.#add(record);
        });
    }

    deleteRecord(id: string): Promise<void> {
        return this.#reply(() => { this.#records.delete(id); });
    }

    #make(record: Omit<DnsRecord, 'id'>): DnsRecord {
        return { ...record, id: `r${this.#nextId++}` };
    }

    #add(record: Omit<DnsRecord, 'id'>): DnsRecord {
        const full = this.#make(record);
        this.#records.set(full.id, full);
        return full;
    }

    #reply<T>(fn: () => T): Promise<T> {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                try {
                    resolve(fn());
                } catch (error) {
                    reject(error);
                }
            }, this.latency);
        });
    }
}
