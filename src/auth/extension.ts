/**
 * The auth Extension — roadmap A6.4, spec/extension.md §7, spec/network.md §4.
 *
 * It holds the session, attaches the ticket, and handles the revocation event. **One per site**,
 * because [the site is the boundary](../../spec/hosting.md): a site is a hostname is an origin, it
 * talks to one mesh-api address, and every Application on that page therefore talks to the same API.
 * One session for that API, provided by one Extension, is not a compromise — it is the right shape.
 *
 * ## Why this ships here but is not built in
 *
 * spec/extension.md §7 lists it under **site-supplied**, not built-in, and that is deliberate: a
 * site decides whether it has accounts at all, and a blog that never signs anyone in should not be
 * carrying a session. So this is a class a site *declares*, exported for the sites that want it, and
 * absent from every page that does not.
 *
 * ## What an Application sees
 *
 * Nothing. An Application declares `needs('net')` and calls `cx.net.call(...)`, and the ticket is on
 * the request. It cannot read the ticket, cannot attach a different one, and does not know whether
 * there is one — which is the whole of "an Application never handles a credential". The Extension
 * reaches that seam through `needs('credentials')`, which is visible in its manifest, so a site can
 * see exactly which contribution has it.
 */

import { needs } from '../contribution/capabilities.js';
import type { Context, Extension } from '../contribution/contract.js';
import { provider, type ProviderToken } from '../contribution/provider.js';
import type { Signal } from '../reactivity/types.js';

// ---------------------------------------------------------------------------- what it provides

export interface Session {
    readonly userId: string;
    readonly displayName: string;
    readonly roles: readonly string[];
    /** When the ticket stops being accepted. The Extension signs out on its own at that point. */
    readonly expiresAt: number;
}

export interface Credentialed {
    readonly email: string;
    readonly password: string;
}

/**
 * What other contributions may do with the session.
 *
 * Note what is **not** here: the ticket. A consumer can ask who is signed in and can ask to sign
 * out; it cannot obtain the credential, because the moment it can, "the auth Extension attaches the
 * ticket" becomes advice rather than a property.
 */
export interface AuthApi {
    readonly session: Signal<Session | null>;
    signIn(credentials: Credentialed): Promise<Session>;
    signOut(): Promise<void>;
}

export const AUTH: ProviderToken<AuthApi> = provider<AuthApi>('mesh-web/auth');

// ---------------------------------------------------------------------------- what it needs

/**
 * How the Extension reaches identity.
 *
 * A parameter rather than a generated client, because *which* API a site talks to and what it calls
 * its sign-in route is the site's business — mesh-identity's contracts are the usual answer and not
 * the only possible one. The Extension is given three requests it can make and knows nothing else
 * about the API.
 */
export interface AuthEndpoints {
    /** Exchange credentials for a ticket. Defaults to mesh-identity's REST path. */
    readonly issue?: string;
    /** Who the caller is, called once on boot to restore a session from a held ticket. */
    readonly whoami?: string;
    readonly revoke?: string;
}

export interface AuthOptions {
    readonly endpoints?: AuthEndpoints;
    /**
     * Where the ticket is kept between page loads.
     *
     * `undefined` means it is not kept: a reload signs you out. That is the safe default and a real
     * choice for a console, and a site that wants the other behaviour says so — a framework that
     * silently persisted a credential would be making a security decision on the site's behalf.
     */
    readonly store?: TicketStore;
    readonly now?: () => number;
}

export interface TicketStore {
    read(): string | undefined;
    write(token: string): void;
    clear(): void;
}

/**
 * `sessionStorage`, scoped to the tab.
 *
 * Offered rather than assumed. `localStorage` is deliberately not the default: it outlives the tab
 * and is readable by every script on the origin, which is a longer life than a ticket wants.
 */
export function sessionTicketStore(key = 'mesh-web/ticket'): TicketStore {
    return {
        read: () => {
            try { return globalThis.sessionStorage?.getItem(key) ?? undefined; } catch { return undefined; }
        },
        write: (token) => {
            try { globalThis.sessionStorage?.setItem(key, token); } catch { /* a private window; not fatal */ }
        },
        clear: () => {
            try { globalThis.sessionStorage?.removeItem(key); } catch { /* as above */ }
        },
    };
}

/**
 * Deliberately without `net`.
 *
 * `net` is typed by the API a contribution declares in its manifest, and this Extension is not tied
 * to one generated client — a site may point it at any identity answering the three shapes below.
 * Declaring `needs('net')` with no `api` is a manifest mistake the kernel refuses outright, and it
 * would be the wrong tool here anyway: `credentials` already carries the origin.
 */
const NEEDS = needs('credentials', 'state', 'log');

const DEFAULTS = {
    issue: '/api/identity/ticket',
    whoami: '/api/identity/whoami',
    revoke: '/api/identity/ticket/revoke',
} as const;

/**
 * The Extension.
 *
 * A class, and the host constructs it — spec/extension.md §2. Construction is side-effect free:
 * nothing is fetched, nothing is read from storage and no header is attached until `activate`, which
 * is what lets the kernel construct every Extension, inspect the graph, and only then start
 * activating.
 */
export class AuthExtension implements Extension<typeof NEEDS, readonly [], typeof AUTH> {
    readonly needs = NEEDS;
    readonly provides = AUTH;

    readonly #options: AuthOptions;

    constructor(options: AuthOptions = {}) {
        this.#options = options;
    }

    activate(cx: Context<typeof NEEDS, readonly []>): AuthApi {
        const endpoints = { ...DEFAULTS, ...this.#options.endpoints };
        const store = this.#options.store;
        const now = this.#options.now ?? Date.now;
        const session = cx.state.signal<Session | null>(null);

        /**
         * The ticket, held here and nowhere a contribution can reach.
         *
         * A closure variable rather than a signal: nothing renders it, and a signal would make it
         * reactive state that something could come to depend on.
         */
        let ticket = store?.read();

        // Attached once, and *before* any request could be made. The lookup runs per request, so a
        // ticket that arrives later is on the next call rather than on the next page load.
        cx.credentials.attach((): Readonly<Record<string, string>> =>
            (ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }));

        /**
         * One request, by path.
         *
         * Not `cx.net.call`: `net` is typed by the API a contribution declared, and this Extension
         * is deliberately not tied to one generated client — a site may point it at any identity
         * that answers these three shapes. The ticket goes on by hand here because this is the one
         * place that legitimately holds it.
         *
         * `undefined` for a refusal, thrown for anything else. A 401 is an *answer* — the ticket is
         * not good — while a 500 is the API failing and must not be read as "not signed in".
         */
        const request = async <T,>(
            path: string,
            method: 'GET' | 'POST',
            body?: unknown,
        ): Promise<T | undefined> => {
            const response = await fetch(`${cx.credentials.origin}${path}`, {
                method,
                headers: {
                    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                    ...(ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                credentials: 'omit',
            });

            if (response.status === 401 || response.status === 403) return undefined;
            if (!response.ok) throw new Error(`${method} ${path} failed with ${String(response.status)}`);

            return await response.json() as T;
        };

        const clear = (): void => {
            ticket = undefined;
            store?.clear();
            session.set(null);
        };

        const sessionFrom = (who: WhoamiReply, expiresAt: number): Session => ({
            userId: who.userId,
            displayName: who.displayName,
            roles: who.roles,
            expiresAt,
        });

        /** Ask the API who this ticket belongs to. The API is the only thing that can answer. */
        const restore = async (expiresAt: number): Promise<Session | null> => {
            const reply = await request<WhoamiReply>(endpoints.whoami, 'GET');
            if (reply === undefined) {
                // The ticket is not accepted any more — revoked, expired, or issued by an API this
                // page no longer talks to. Whichever it is, holding it is worse than dropping it.
                clear();
                return null;
            }
            const restored = sessionFrom(reply, expiresAt);
            session.set(restored);
            return restored;
        };

        if (ticket !== undefined) {
            // A held ticket is a claim, never a session. Nothing is signed in until the API says so,
            // which is the same rule the API applies to itself (spec/auth.md §3).
            void restore(now() + UNKNOWN_LIFETIME).catch((error: unknown) => {
                cx.log.warn('could not restore a session from the held ticket', error);
                clear();
            });
        }

        return {
            session,

            async signIn(credentials): Promise<Session> {
                const issued = await request<IssueReply>(endpoints.issue, 'POST', credentials);
                if (issued === undefined) throw new Error('Those credentials are not valid.');

                ticket = issued.token;
                store?.write(issued.token);

                const restored = await restore(issued.expiresAt);
                if (restored === null) {
                    // Issued and then not accepted. Better to fail the sign-in than to leave a page
                    // holding a ticket that works for nothing.
                    throw new Error('Signed in, but the API did not recognise the ticket.');
                }
                return restored;
            },

            async signOut(): Promise<void> {
                const held = ticket;
                // Locally first: a network failure must not leave the page believing it is signed in.
                clear();
                if (held === undefined) return;

                try {
                    await request(endpoints.revoke, 'POST', { token: held });
                } catch (error) {
                    // The ticket still expires on its own. Telling the user their sign-out failed,
                    // when locally it did not, would be worse than a log line.
                    cx.log.warn('sign-out reached the page but not the API', error);
                }
            },
        };
    }
}

/** A ticket restored from storage carries no expiry, so the API's answer is what dates it. */
const UNKNOWN_LIFETIME = 0;

interface IssueReply { readonly token: string; readonly userId: string; readonly expiresAt: number }
interface WhoamiReply {
    readonly userId: string;
    readonly displayName: string;
    readonly roles: readonly string[];
}

