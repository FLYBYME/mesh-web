/**
 * What the contract refuses.
 *
 * Every `@ts-expect-error` below is load-bearing: if the design ever stops catching one of these,
 * the directive becomes unused and *this file stops compiling*. That is the trick that keeps
 * type-level guarantees from quietly eroding — the assertions fail the build when they start
 * passing.
 *
 * Delete any one of the directives to see the real error.
 */

import {
    needs,
    consumes,
    provider,
    view,
    type Extension,
    type Application,
    type Context,
} from '@flybyme/mesh-web';

import { AUTH, AUTH_ADMIN, type AuthApi } from './contracts/auth.js';

// ---------------------------------------------------------------------------- capabilities

const NEEDS = needs('net', 'notifications');

class UndeclaredCapability implements Extension<typeof NEEDS> {
    readonly needs = NEEDS;

    activate(cx: Context<typeof NEEDS>): void {
        cx.net.baseUrl;                 // declared — fine
        cx.notifications.info('ok');    // declared — fine

        // @ts-expect-error  'windows' is not in NEEDS
        cx.windows.open({ view: 'x' });

        // @ts-expect-error  'storage' is not in NEEDS
        void cx.storage.get('k');
    }
}

class MisspelledCapability {
    // @ts-expect-error  'nett' is not a CapabilityName — the error lands on the typo itself
    readonly needs = needs('net', 'nett');
}

// ---------------------------------------------------------------------------- providers

const CONSUMES = consumes(AUTH);

class UndeclaredProvider implements Application<typeof NEEDS, typeof CONSUMES> {
    readonly needs = NEEDS;
    readonly consumes = CONSUMES;

    async start(cx: Context<typeof NEEDS, typeof CONSUMES>): Promise<void> {
        const auth: AuthApi = cx.use(AUTH);   // declared — and fully typed
        auth.signedIn();

        // @ts-expect-error  AUTH_ADMIN was not declared in `consumes`
        cx.use(AUTH_ADMIN);
    }
}

const WRONG = provider<{ ping(): void }>('demo.wrong');

class ProvidesWhatItDoesNotReturn implements Extension<typeof NEEDS, readonly [], typeof WRONG> {
    readonly needs = NEEDS;
    readonly provides = WRONG;

    // @ts-expect-error  declared `provides: WRONG` but returns something without ping()
    activate(_cx: Context<typeof NEEDS>): { pong(): void } {
        return { pong: () => {} };
    }
}

// ---------------------------------------------------------------------------- views

class Views implements Application<typeof NEEDS> {
    readonly needs = NEEDS;

    readonly views = [
        view({ id: 'header', title: 'Header', tile: 'header', mount: () => {} }),
        view({ id: 'content', title: 'Content', tile: 'content', mount: () => {} }),
    ];

    async start(): Promise<void> {}
}

// Ids survive as literals, because `views` is declared statically rather than registered at
// runtime. A route or an `open` call can be checked against them — spec/application.md §6.
type ViewIds = Views['views'][number]['id'];

const real: ViewIds = 'content';

// @ts-expect-error  this Application has no view called 'sidebar'
const notReal: ViewIds = 'sidebar';

// ---------------------------------------------------------------------------- the erased side

/**
 * The host holds contributions without knowing any of their type parameters, and this still works
 * — via method bivariance, with no cast anywhere. The first draft of the deleted code reached for
 * `as unknown as ...` here and did not need it.
 */
const loaded: Array<{ readonly needs: readonly string[] }> = [
    new UndeclaredCapability(),
    new UndeclaredProvider(),
    new Views(),
];

export { UndeclaredCapability, MisspelledCapability, UndeclaredProvider, ProvidesWhatItDoesNotReturn, Views, loaded, real, notReal };
