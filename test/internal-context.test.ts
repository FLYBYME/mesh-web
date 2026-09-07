/**
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import {
    element,
    flushSync,
    needs,
    provider,
    start,
    text,
    type Api,
    type Application,
    type Context,
    type ProviderToken,
    type ReadonlySignal,
    type Signal,
    type ViewContext,
    applicationInstance,
    isApplicationInstance,
} from '../src/index.js';

describe('internal context (two objects: internal context vs published API)', () => {
    it('a view renders from internal state, which the published API does not expose and the type system refuses from outside', async () => {
        const WINDOWS_NEEDS = needs('windows', 'state');

        // 1. The published API: deliberately small, only ReadonlySignal and public operations
        interface CartApi {
            readonly itemCount: ReadonlySignal<number>;
            readonly publicName: string;
        }
        const CART: ProviderToken<CartApi> = provider<CartApi>('test/cart');

        // 2. The internal context: raw writable signals, internal drafts, private methods
        interface CartInternal {
            readonly secretDiscount: Signal<string>;
            readonly internalDraft: Signal<string>;
            setSecretDiscount(code: string): void;
        }

        let capturedInternal: CartInternal | undefined;

        // 3. The Application declares its internal context type via TInternal
        class CartApp implements Application<
            typeof WINDOWS_NEEDS,
            readonly [],
            typeof CART,
            Api<Record<string, never>>,
            CartInternal
        > {
            readonly needs = WINDOWS_NEEDS;
            readonly provides = CART;
            readonly views = [
                {
                    id: 'cart-view',
                    title: 'Cart View',
                    render(vx: ViewContext<Record<string, never>, CartApi, CartInternal>) {
                        // The view reads BOTH its own internal state and public API
                        return element('Stack', {
                            children: [
                                element('Text', {
                                    props: { id: 'public-count' },
                                    children: [text(() => `Items: ${vx.app.itemCount()}`)],
                                }),
                                element('Text', {
                                    props: { id: 'public-name' },
                                    children: [text(vx.app.publicName)],
                                }),
                                element('Text', {
                                    props: { id: 'internal-discount' },
                                    children: [text(() => `Discount: ${vx.internal.secretDiscount()}`)],
                                }),
                                element('Text', {
                                    props: { id: 'internal-draft' },
                                    children: [text(() => `Draft: ${vx.internal.internalDraft()}`)],
                                }),
                            ],
                        });
                    },
                },
            ];

            async start(cx: Context<typeof WINDOWS_NEEDS, readonly []>): Promise<{
                readonly api: CartApi;
                readonly internal: CartInternal;
            }> {
                const itemCount = cx.state.signal<number>(5);
                const secretDiscount = cx.state.signal<string>('VIP-SECRET-50');
                const internalDraft = cx.state.signal<string>('uncommitted cart item #42');

                const internal: CartInternal = {
                    secretDiscount,
                    internalDraft,
                    setSecretDiscount(code: string): void {
                        secretDiscount.set(code);
                    },
                };
                capturedInternal = internal;

                const api: CartApi = {
                    itemCount,
                    publicName: 'Main Store Cart',
                };

                cx.windows.open({ view: 'cart-view' });

                return { api, internal };
            }
        }

        const started = start({
            application: 'cart',
            parts: [{ id: 'cart', contribution: new CartApp() }],
        });
        await started.ready;

        // Verify the view rendered correctly from public API
        const publicCountEl = started.page.host?.querySelector('#public-count');
        expect(publicCountEl?.textContent).toBe('Items: 5');
        const publicNameEl = started.page.host?.querySelector('#public-name');
        expect(publicNameEl?.textContent).toBe('Main Store Cart');

        // Verify the view rendered correctly from internal state
        const discountEl = started.page.host?.querySelector('#internal-discount');
        expect(discountEl?.textContent).toBe('Discount: VIP-SECRET-50');
        const draftEl = started.page.host?.querySelector('#internal-draft');
        expect(draftEl?.textContent).toBe('Draft: uncommitted cart item #42');

        // Verify published API is what other parts get via provider token
        const publishedApi = started.kernel.provided(CART);
        expect(publishedApi).toBeDefined();
        if (publishedApi !== undefined) {
            expect(publishedApi.itemCount()).toBe(5);
            expect(publishedApi.publicName).toBe('Main Store Cart');

            // RUNTIME VERIFICATION: internal members are NOT on the published API
            expect('secretDiscount' in publishedApi).toBe(false);
            expect('internalDraft' in publishedApi).toBe(false);
            expect('setSecretDiscount' in publishedApi).toBe(false);

            // TYPE SYSTEM VERIFICATION:
            // The type system strictly refuses any attempt to reach internal state from outside.
            // @ts-expect-error secretDiscount is internal state and must not exist on published CartApi
            publishedApi.secretDiscount;

            // @ts-expect-error internalDraft is internal state and must not exist on published CartApi
            publishedApi.internalDraft;

            // @ts-expect-error setSecretDiscount is internal state and must not exist on published CartApi
            const _callAttempt = () => publishedApi.setSecretDiscount('ATTEMPTED_OVERWRITE');
            expect(_callAttempt).toBeDefined();
        }

        // Verify reactive updates from internal state propagate to the view
        expect(capturedInternal).toBeDefined();
        capturedInternal?.setSecretDiscount('NEW-CODE-99');
        flushSync();
        expect(discountEl?.textContent).toBe('Discount: NEW-CODE-99');

        started.dispose();
    });

    it('an application with internal state and no published API renders cleanly', async () => {
        const WINDOWS_NEEDS = needs('windows', 'state');

        interface PrivateState {
            readonly noteTitle: Signal<string>;
        }

        class PrivateApp implements Application<
            typeof WINDOWS_NEEDS,
            readonly [],
            undefined,
            Api<Record<string, never>>,
            PrivateState
        > {
            readonly needs = WINDOWS_NEEDS;
            readonly views = [
                {
                    id: 'private-view',
                    title: 'Private Notes',
                    render(vx: ViewContext<Record<string, never>, unknown, PrivateState>) {
                        return element('Text', {
                            props: { id: 'note-title' },
                            children: [text(() => `Title: ${vx.internal.noteTitle()}`)],
                        });
                    },
                },
            ];

            async start(cx: Context<typeof WINDOWS_NEEDS, readonly []>): Promise<{
                readonly internal: PrivateState;
            }> {
                const noteTitle = cx.state.signal('My Secret Notebook');
                cx.windows.open({ view: 'private-view' });
                return {
                    internal: { noteTitle },
                };
            }
        }

        const started = start({
            application: 'private',
            parts: [{ id: 'private', contribution: new PrivateApp() }],
        });
        await started.ready;

        const titleEl = started.page.host?.querySelector('#note-title');
        expect(titleEl?.textContent).toBe('Title: My Secret Notebook');

        started.dispose();
    });

    it('applicationInstance helper and isApplicationInstance guard work correctly', () => {
        const instance = applicationInstance({
            api: { publicMethod(): void {} },
            internal: { privateSignal: 123 },
        });

        expect(isApplicationInstance(instance)).toBe(true);
        expect(isApplicationInstance({ internal: 'state-only' })).toBe(true);
        expect(isApplicationInstance({ api: 'legacy-api-only' })).toBe(false);
        expect(isApplicationInstance(null)).toBe(false);
        expect(isApplicationInstance(undefined)).toBe(false);
        expect(isApplicationInstance(123)).toBe(false);
        expect(isApplicationInstance('string')).toBe(false);
    });
});
