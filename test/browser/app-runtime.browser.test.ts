/**
 * Phase 2 checkpoint (docs/app-model.md): one `AuthService`, one `LoginForm` class mounted in two
 * places — and a third behind a `when` — in a real browser, on the real kernel, **pressed**, not
 * called. Every assertion here is about what a person would see after typing and clicking.
 *
 * The app model has no router yet (phase 4), so an ordinary Application hosts the runtime: its one
 * view renders `runtime.view(DemoView, ...)`, registering handlers through `vx.on` / `vx.off`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import '../../src/kernel.css';
import {
    computed, element, needs, signal, text, when,
    type Application, type Context, type Node, type ViewContext,
} from '../../src/index.js';
import { App, Component, createAppRuntime, props, Service, View, type AppRuntime, type HandlerRegistry } from '../../src/app/index.js';
import { cleanup, mountPart, type MountedSite } from '../../src/testing/index.js';

// ---------------------------------------------------------------------------- the app model side

class AuthService extends Service({}) {
    readonly session = signal<{ readonly email: string } | null>(null);
    readonly signedIn = computed(() => this.session() !== null);
    signIn(email: string): void {
        this.session.set({ email });
    }
    signOut(): void {
        this.session.set(null);
    }
}

let formsAlive = 0;

class LoginForm extends Component({ inject: { auth: AuthService }, props: props<{ place: string }>() }) {
    readonly email = signal('');
    readonly born = ++formsAlive;

    render(): Node {
        const { auth } = this.inject;
        const place = this.props.place;
        return element('Stack', {
            props: { 'data-form': place },
            children: [
                element('Input', {
                    props: { 'aria-label': `email (${place})`, value: () => this.email() },
                    intents: { change: { action: this.on((v) => this.email.set(typeof v === 'string' ? v : '')) } },
                }),
                element('Button', {
                    props: { 'aria-label': `sign in (${place})` },
                    intents: { activate: { action: this.on(() => auth.signIn(this.email())) } },
                    children: [text('Sign in')],
                }),
                element('Text', {
                    props: { 'data-status': place },
                    children: [text(() => {
                        const s = auth.session();
                        return s === null ? `${place}: signed out, draft "${this.email()}"` : `${place}: signed in as ${s.email}`;
                    })],
                }),
            ],
        });
    }

    dispose(): void {
        formsAlive--;
    }
}

class DemoView extends View({}) {
    readonly showThird = signal(false);

    render(): Node {
        return element('Stack', {
            children: [
                this.mount(LoginForm, { place: 'header' }),
                this.mount(LoginForm, { place: 'sidebar' }),
                element('Button', {
                    props: { 'aria-label': 'toggle third' },
                    intents: { activate: { action: this.on(() => this.showThird.set(!this.showThird())) } },
                    children: [text('Toggle')],
                }),
                when(() => this.showThird(), () => this.mount(LoginForm, { place: 'third' })),
            ],
        });
    }
}

class DemoApp extends App({ services: [AuthService], routes: { '/': DemoView } }) {}

// ---------------------------------------------------------------------------- the bridge

/** Counts live handlers so the test can see a `when` flip give back what it took. */
let liveHandlers = 0;

function counting(vx: ViewContext<Record<string, never>, BridgeState>): HandlerRegistry {
    return {
        on(fn) {
            liveHandlers++;
            return vx.on(fn);
        },
        off(action) {
            liveHandlers--;
            vx.off(action);
        },
    };
}

interface BridgeState {
    readonly runtime: AppRuntime;
}

const BRIDGE_NEEDS = needs('windows');

class Bridge implements Application<typeof BRIDGE_NEEDS, readonly [], undefined, never, BridgeState> {
    readonly needs = BRIDGE_NEEDS;
    readonly views = [{
        id: 'main',
        title: 'Demo',
        render: (vx: ViewContext<Record<string, never>, BridgeState>) => vx.internal.runtime.view(DemoView, {}, counting(vx)),
    }];

    async start(cx: Context<typeof BRIDGE_NEEDS, readonly []>): Promise<{ internal: BridgeState }> {
        const runtime = createAppRuntime(DemoApp, cx);
        cx.windows.open({ view: 'main' });
        return { internal: { runtime } };
    }
}

// ---------------------------------------------------------------------------- the test

let site: MountedSite | undefined;

afterEach(() => {
    cleanup();
    site = undefined;
});

async function frame(): Promise<void> {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
}

function status(place: string): string {
    return site?.root.querySelector(`[data-status="${place}"]`)?.textContent ?? '(missing)';
}

function input(place: string): HTMLInputElement {
    const el = site?.root.querySelector(`[aria-label="email (${place})"]`);
    if (!(el instanceof HTMLInputElement)) throw new Error(`no email input for ${place}`);
    return el;
}

function button(label: string): Element {
    const el = site?.root.querySelector(`[aria-label="${label}"]`);
    if (el === null || el === undefined) throw new Error(`no button "${label}"`);
    return el;
}

describe('app runtime in a real browser', () => {
    it('two mounts of one component keep their own state and share one service', async () => {
        site = await mountPart({ id: 'demo', contribution: Bridge });
        await frame();

        expect(status('header')).toBe('header: signed out, draft ""');
        expect(status('sidebar')).toBe('sidebar: signed out, draft ""');

        await userEvent.fill(input('header'), 'ada@example.com');
        await frame();

        // Typing in one form does not touch the other: the draft is per instance.
        expect(status('header')).toBe('header: signed out, draft "ada@example.com"');
        expect(status('sidebar')).toBe('sidebar: signed out, draft ""');

        await userEvent.click(button('sign in (header)'));
        await frame();

        // Signing in through one form signs in everywhere: the session is the service's, and there is one.
        expect(status('header')).toBe('header: signed in as ada@example.com');
        expect(status('sidebar')).toBe('sidebar: signed in as ada@example.com');
    });

    it('a component behind a when is built and disposed with it, and gives back its handlers', async () => {
        formsAlive = 0;
        liveHandlers = 0;
        site = await mountPart({ id: 'demo', contribution: Bridge });
        await frame();

        expect(formsAlive).toBe(2);
        const baseline = liveHandlers;
        expect(site.root.querySelector('[data-form="third"]')).toBeNull();

        for (let i = 0; i < 5; i++) {
            await userEvent.click(button('toggle third'));
            await frame();
            expect(formsAlive).toBe(3);
            expect(site.root.querySelector('[data-form="third"]')).not.toBeNull();

            // Fresh every time: whatever was typed into the last third form went with it.
            expect(input('third').value).toBe('');
            await userEvent.fill(input('third'), `draft ${i}`);
            await frame();
            expect(status('third')).toBe(`third: signed out, draft "draft ${i}"`);

            await userEvent.click(button('toggle third'));
            await frame();
            expect(formsAlive).toBe(2);
            expect(site.root.querySelector('[data-form="third"]')).toBeNull();
            // Five flips, and not one handler left behind.
            expect(liveHandlers).toBe(baseline);
        }

        // And the two that never left still work.
        await userEvent.fill(input('sidebar'), 'grace@example.com');
        await userEvent.click(button('sign in (sidebar)'));
        await frame();
        expect(status('header')).toBe('header: signed in as grace@example.com');
    });
});
