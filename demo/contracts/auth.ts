/**
 * @demo/auth-contract
 *
 * The shared third place: an interface and a token, no implementation.
 *
 * Both the Extension that provides auth and every consumer of it import this module. Neither ever
 * imports the other, which is the point — see spec/extension.md §4, "Where the public interface
 * lives".
 *
 * Note this is a real runtime dependency, not a type-only one: `AUTH` is a value.
 */

import { provider, type Signal } from '@flybyme/mesh-web';

export interface Session {
    readonly userId: string;
    readonly displayName: string;
    readonly organizationId: string;
    /** Role ids. Roles are records in mesh-identity, not an enum — spec/auth.md §5. */
    readonly roles: readonly string[];
}

export interface AuthApi {
    /** `null` until signed in. A signal, so a view re-renders when it changes. */
    readonly session: Signal<Session | null>;
    readonly signedIn: () => boolean;
    signIn(): Promise<void>;
    signOut(): Promise<void>;
    /** True when the session carries a role granting this action. */
    can(action: string): boolean;
}

export const AUTH = provider<AuthApi>('demo.auth');

/**
 * A second, narrower token for the privileged surface.
 *
 * Cheaper than one interface with optional members: `consumes` then records which contributors
 * needed the privileged one — spec/extension.md §4.
 */
export interface AuthAdminApi {
    impersonate(userId: string): Promise<void>;
    revokeTicket(ticketId: string): Promise<void>;
}

export const AUTH_ADMIN = provider<AuthAdminApi>('demo.auth.admin');
