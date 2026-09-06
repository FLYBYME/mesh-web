import { afterEach, describe, expect, it } from 'vitest';
import {
    needs, provider, consumes, element, text, effect, flushSync,
    type Application, type Context, type Extension, type ProviderToken, type Signal,
} from '@flybyme/mesh-web';
import { mountPart, cleanup, getFrameworkInstances } from '@flybyme/mesh-web/testing';

interface AuthState {
    readonly token: string;
    readonly user: Signal<string | null>;
}

const AUTH_TOKEN: ProviderToken<AuthState> = provider<AuthState>('test/auth');
const AUTH_NEEDS = needs('state');

class FakeAuthExtension implements Extension<typeof AUTH_NEEDS, readonly [], typeof AUTH_TOKEN> {
    readonly needs = AUTH_NEEDS;
    readonly provides = AUTH_TOKEN;

    constructor(private readonly options: { readonly defaultUser?: string } = {}) {}

    activate(cx: Context<typeof AUTH_NEEDS>): AuthState {
        const user = cx.state.signal<string | null>(this.options.defaultUser ?? null);
        return {
            token: 'valid-test-ticket',
            user,
        };
    }
}

const APP_NEEDS = needs('windows', 'state');
const APP_CONSUMES = consumes(AUTH_TOKEN);

class FakeConsoleApp implements Application<typeof APP_NEEDS, typeof APP_CONSUMES> {
    readonly needs = APP_NEEDS;
    readonly consumes = APP_CONSUMES;

    readonly views = [
        {
            id: 'main',
            title: 'Console Main View',
            render: () => element('Text', { children: [text('Console View Content')] }),
        },
    ];

    async start(cx: Context<typeof APP_NEEDS, typeof APP_CONSUMES>): Promise<void> {
        cx.windows.open({ view: 'main' });
    }
}

afterEach(() => {
    cleanup();
});

describe('mountPart (browser test harness)', () => {
    it('activates an Extension and provides its capability', async () => {
        const site = await mountPart({
            parts: [{ id: 'auth', contribution: FakeAuthExtension, options: { defaultUser: 'alice' } }],
        });

        const auth = site.kernel.provided(AUTH_TOKEN);
        expect(auth).toBeDefined();
        expect(auth?.token).toBe('valid-test-ticket');
        expect(auth?.user()).toBe('alice');

        site.dispose();
    });

    it('boots an Application, opens its window, and renders into the page', async () => {
        const site = await mountPart({
            parts: [
                { id: 'auth', contribution: FakeAuthExtension },
                { id: 'console', contribution: FakeConsoleApp },
            ],
        });

        // Application opened window on start
        expect(site.manager.windows()).toHaveLength(1);
        expect(site.manager.windows()[0]?.view).toBe('main');

        // Window rendered into the root with visible, non-zero dimensions
        expect(site.root.textContent).toContain('Console View Content');
        const win = site.root.querySelector<HTMLElement>('.window');
        expect(win).not.toBeNull();
        expect(win!.getBoundingClientRect().height).toBeGreaterThan(0);
        expect(win!.getBoundingClientRect().width).toBeGreaterThan(0);

        site.dispose();
    });

    it('mounts a part and asserts a window has a non-zero height', async () => {
        const site = await mountPart({
            parts: [{ id: 'console', contribution: FakeConsoleApp }],
        });

        const win = site.root.querySelector<HTMLElement>('.window');
        expect(win).not.toBeNull();
        expect(win!.getBoundingClientRect().height).toBeGreaterThan(0);
        expect(win!.getBoundingClientRect().width).toBeGreaterThan(0);

        site.dispose();
    });

    it('cleans up DOM completely on dispose so windows do not leak to the next test', async () => {
        expect(document.getElementById('mesh-web-root')).toBeNull();

        const site = await mountPart({
            parts: [{ id: 'console', contribution: FakeConsoleApp }],
        });

        expect(document.getElementById('mesh-web-root')).not.toBeNull();
        expect(site.manager.windows()).toHaveLength(1);

        site.dispose();

        // The root must be removed from document.body
        expect(document.getElementById('mesh-web-root')).toBeNull();
    });

    it('guarantees reactivity singletons are shared across contribution and test', async () => {
        const site = await mountPart({
            parts: [{ id: 'auth', contribution: FakeAuthExtension }],
        });

        const auth = site.kernel.provided(AUTH_TOKEN)!;
        let seenUser: string | null = null;
        let runs = 0;

        effect(() => {
            runs += 1;
            seenUser = auth.user();
        });

        expect(runs).toBe(1);
        expect(seenUser).toBeNull();

        auth.user.set('bob');
        flushSync();

        expect(runs).toBe(2);
        expect(seenUser).toBe('bob');

        site.dispose();
    });

    it('verifies the one constraint that matters: exactly one copy of the framework is loaded', async () => {
        const site = await mountPart({
            parts: [{ id: 'auth', contribution: FakeAuthExtension }],
        });

        // Asserts directly on the framework module instance count
        expect(site.frameworkInstances.length).toBe(1);
        expect(() => site.assertSingleFramework()).not.toThrow();
        expect(() => site.assertSingleKernel()).not.toThrow();

        site.dispose();
    });
});
