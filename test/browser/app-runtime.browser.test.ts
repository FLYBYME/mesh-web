/**
 * Phase 2 checkpoint (docs/app-model.md): one `AuthService`, one `LoginForm` class mounted in two
 * places — and a third behind a `when` — in a real browser, **pressed**, not called. Every assertion
 * here is about what a person would see after typing and clicking.
 *
 * Mounted with `mountSite`. (It was hosted by a legacy Application until phase 5c removed those.)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import '../../src/kernel.css';
import { computed, element, signal, text, when, type Node } from '../../src/index.js';
import { App, Component, mountSite, props, Service, View, type MountedApp } from '../../src/app/index.js';

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

// ---------------------------------------------------------------------------- the harness

let root: HTMLElement;
let site: MountedApp | undefined;
let original = '';

beforeEach(() => {
    original = `${location.pathname}${location.search}`;
    history.replaceState(null, '', '/');
    root = document.createElement('div');
    document.body.appendChild(root);
});

afterEach(() => {
    site?.dispose();
    site = undefined;
    root.remove();
    history.replaceState(null, '', original);
});

function mount(): MountedApp {
    site = mountSite(DemoApp, { root });
    return site;
}

async function frame(): Promise<void> {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
}

function status(place: string): string {
    return root.querySelector(`[data-status="${place}"]`)?.textContent ?? '(missing)';
}

function input(place: string): HTMLInputElement {
    const el = root.querySelector(`[aria-label="email (${place})"]`);
    if (!(el instanceof HTMLInputElement)) throw new Error(`no email input for ${place}`);
    return el;
}

function button(label: string): Element {
    const el = root.querySelector(`[aria-label="${label}"]`);
    if (el === null) throw new Error(`no button "${label}"`);
    return el;
}

describe('app runtime in a real browser', () => {
    it('two mounts of one component keep their own state and share one service', async () => {
        mount();
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
        const site = mount();
        await frame();

        expect(formsAlive).toBe(2);
        const baseline = site.handlerCount();
        expect(root.querySelector('[data-form="third"]')).toBeNull();

        for (let i = 0; i < 5; i++) {
            await userEvent.click(button('toggle third'));
            await frame();
            expect(formsAlive).toBe(3);
            expect(root.querySelector('[data-form="third"]')).not.toBeNull();

            // Fresh every time: whatever was typed into the last third form went with it.
            expect(input('third').value).toBe('');
            await userEvent.fill(input('third'), `draft ${i}`);
            await frame();
            expect(status('third')).toBe(`third: signed out, draft "draft ${i}"`);

            await userEvent.click(button('toggle third'));
            await frame();
            expect(formsAlive).toBe(2);
            expect(root.querySelector('[data-form="third"]')).toBeNull();
            // Five flips, and not one handler left behind — counted in the site's real handler table.
            expect(site.handlerCount()).toBe(baseline);
        }

        // And the two that never left still work.
        await userEvent.fill(input('sidebar'), 'grace@example.com');
        await userEvent.click(button('sign in (sidebar)'));
        await frame();
        expect(status('header')).toBe('header: signed in as grace@example.com');
    });
});
