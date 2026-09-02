import { describe, it, expect } from 'vitest';
import { createScope } from '../../src/reactivity/index.js';
import { AppStateContainerImpl, MemoryStorage } from '../../src/app/index.js';
import {
    constructExtension,
    constructApplication,
    provider,
    type Extension,
    type Application,
    type CapabilityContext,
    type ContributionBase,
    type Consumer,
    type ProviderToken,
} from '../../src/contribution/index.js';

/**
 * The claim under test is a *type-level* one: a contributor receives exactly the capabilities it
 * declared in `needs`, and reaching for anything else does not compile.
 *
 * `expect` cannot check that. `@ts-expect-error` can — TypeScript reports an *unused* directive as
 * an error, so if the narrowing ever silently widens to `Partial<CapabilityMap>` or `unknown`,
 * these lines start compiling, the directives go unused, and `npm run typecheck` fails here.
 * `tsconfig.check.json` includes `test/**` precisely so this runs in CI; vitest transpiles without
 * type-checking, which is why that separate step exists at all.
 */

/**
 * The part of a context every contributor gets, plus an erased `use` that resolves nothing.
 *
 * A real host builds `use` from the contributor's `consumes` and the providers it has already
 * activated. Here nothing is registered, so `use` throwing is the honest stand-in — a test that
 * quietly returned undefined would be a test asserting the opposite of the design.
 */
function baseContext(id: string): ContributionBase & { use(token: ProviderToken<unknown>): never } {
    return {
        id,
        state: new AppStateContainerImpl(id, createScope(), new MemoryStorage()),
        registerCleanup: () => undefined,
        use(token: ProviderToken<unknown>): never {
            throw new Error(`no provider registered for "${token.id}"`);
        },
    };
}

describe('capability narrowing', () => {
    it('gives a contributor exactly what it declared', () => {
        class NarrowExtension implements Extension<['net', 'commands']> {
            readonly needs = ['net', 'commands'] as const;

            activate(cx: CapabilityContext<['net', 'commands']>): void {
                // Declared: real types, not `unknown`.
                const url: string = cx.net.baseUrl;
                expect(typeof url).toBe('string');
                cx.commands.available();

                // Always present, never declared.
                expect(cx.id).toBe('narrow');

                // @ts-expect-error — `notifications` was not declared, so it is not on the context.
                cx.notifications.info('this line must not compile');
            }
        }

        const instance = new NarrowExtension();
        expect(instance.needs).toEqual(['net', 'commands']);
    });

    it('gives a contributor nothing but the base context when it declares nothing', () => {
        class BareExtension implements Extension {
            activate(cx: CapabilityContext<readonly []>): void {
                expect(cx.id).toBe('bare');

                // @ts-expect-error — declaring no `needs` means no capabilities at all.
                cx.log.info('this line must not compile');
            }
        }

        expect(new BareExtension()).toBeInstanceOf(BareExtension);
    });

    it('checks what activate returns against the token it promised', () => {
        interface AuthApi {
            readonly signedIn: boolean;
        }
        const Auth = provider<AuthApi>('identity.auth');

        class AuthExtension implements Extension<['storage'], readonly [], AuthApi> {
            readonly needs = ['storage'] as const;
            readonly provides = Auth;

            activate(cx: CapabilityContext<['storage']>): AuthApi {
                return { signedIn: cx.storage.get('signedIn', false) };
            }
        }

        const exports: AuthApi = new AuthExtension().activate({
            ...baseContext('auth'),
            storage: {
                get: <T,>(_key: string, fallback: T): T => fallback,
                set: () => undefined,
                remove: () => undefined,
            },
        });
        expect(exports.signedIn).toBe(false);
        expect(new AuthExtension().provides.id).toBe('identity.auth');
    });

    it('refuses an Extension whose activate does not return what its token promises', () => {
        interface AuthApi {
            readonly signedIn: boolean;
        }
        const Auth = provider<AuthApi>('identity.auth');

        class Drifted implements Extension<readonly [], readonly [], AuthApi> {
            readonly provides = Auth;
            // @ts-expect-error — `provides` is Auth, so `activate` must return AuthApi.
            activate(): string {
                return 'not an AuthApi';
            }
        }
        expect(new Drifted()).toBeInstanceOf(Drifted);
    });

    it('resolves a consumed token to the type the token carries, and refuses undeclared ones', () => {
        interface AuthApi {
            readonly signedIn: boolean;
        }
        const Auth = provider<AuthApi>('identity.auth');
        const Unrelated = provider<{ other: true }>('some.other');

        class Consumer1 implements Application<readonly [], readonly [typeof Auth]> {
            readonly consumes = [Auth] as const;
            readonly surfaces = [{ role: 'page', route: '/' }] as const;

            onLoad(cx: CapabilityContext<readonly []> & Consumer<readonly [typeof Auth]>): void {
                // Declared: `use` returns AuthApi, inferred from the token — not `unknown`.
                const signedIn: boolean = cx.use(Auth).signedIn;
                expect(typeof signedIn).toBe('boolean');

                // @ts-expect-error — `Unrelated` is not in `consumes`, so it cannot be used.
                cx.use(Unrelated);
            }
        }

        expect(new Consumer1().consumes[0].id).toBe('identity.auth');
    });

    it('lets an Application declare window preferences and surfaces', () => {
        class ChartApplication implements Application<['net']> {
            readonly needs = ['net'] as const;
            readonly window = {
                mode: 'either',
                minSize: { width: 320, height: 240 },
                // Several chart windows side by side is the point of this flag.
                singleton: false,
            } as const;

            readonly surfaces = [{ role: 'page', route: '/charts' }] as const;
        }

        const app = new ChartApplication();
        expect(app.window.singleton).toBe(false);
        expect(app.surfaces[0].route).toBe('/charts');
    });
});

describe('loading a bundle', () => {
    it('constructs the Extension a module default-exports', () => {
        class Ext implements Extension {
            activated = false;
            activate(): void {
                this.activated = true;
            }
        }

        const instance = constructExtension({ default: Ext }, 'test://ext.js');
        instance.activate(baseContext('ext'));
        expect(instance).toBeInstanceOf(Ext);
    });

    it('names the bundle when there is no default export', () => {
        expect(() => constructExtension({ notDefault: class {} }, 'test://broken.js')).toThrow(
            /extension bundle at test:\/\/broken\.js has no default export/,
        );
    });

    it('names the bundle when the default export is not constructable', () => {
        expect(() => constructExtension({ default: 'not a class' }, 'test://string.js')).toThrow(
            /has no default export, or its default export is not constructable/,
        );
    });

    it('rejects a default export that does not implement Extension', () => {
        // Constructable, produces an object, but has no `activate` — the exact shape of exporting
        // the wrong class from the right file.
        class NotAnExtension {
            readonly title = 'wrong';
        }
        expect(() => constructExtension({ default: NotAnExtension }, 'test://wrong.js')).toThrow(
            /has no `activate` method, so it does not implement Extension/,
        );
    });

    it('constructs a fresh Application per call, so two windows do not share state', () => {
        class App implements Application {
            readonly surfaces = [{ role: 'page', route: '/' }] as const;
            readonly openedAt = Symbol('window');
        }

        const first = constructApplication({ default: App }, 'test://app.js');
        const second = constructApplication({ default: App }, 'test://app.js');
        expect(first).not.toBe(second);
        expect(first.surfaces).toHaveLength(1);
    });

    it('names the bundle when an application module has no default export', () => {
        expect(() => constructApplication({}, 'test://noapp.js')).toThrow(
            /application bundle at test:\/\/noapp\.js has no default export/,
        );
    });

    it('rejects an Application that declares no surfaces, and says to write an Extension', () => {
        class NoSurfaces {
            readonly title = 'nowhere';
        }
        expect(() => constructApplication({ default: NoSurfaces }, 'test://nowhere.js')).toThrow(
            /declares no `surfaces`.*is an Extension/s,
        );
    });

    it('rejects a module that is not an object at all', () => {
        expect(() => constructExtension(null, 'test://null.js')).toThrow(/has no default export/);
        expect(() => constructExtension(42, 'test://number.js')).toThrow(/has no default export/);
    });
});
