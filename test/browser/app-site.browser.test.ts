/**
 * Phase 4 checkpoint (docs/app-model.md): an App as a single-page site, on the real browser history.
 * Deep links, clicked links, back and forward, 404s, and params that change the instance — all
 * pressed, none called.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import { z } from 'zod';
import { element, signal, text, when, type Node } from '../../src/index.js';
import {
    App, command, Component, Link, mountSite, props, Redirect, Router, Service, View,
    type LayoutProps, type MountedApp,
} from '../../src/app/index.js';

// ---------------------------------------------------------------------------- the site

class HomeView extends View({ inject: { router: Router }, title: 'Home' }) {
    render(): Node {
        const { router } = this.inject;
        return element('Stack', {
            props: { 'data-view': 'home' },
            children: [
                element('Heading', { children: [text('Home')] }),
                this.mount(Link, { href: router.href(ZoneView, { zone: 'example.com' }), children: [text('example.com')] }),
                this.mount(Link, { href: router.href(ZoneView, { zone: 'other.net' }), children: [text('other.net')] }),
            ],
        });
    }
}

class ZoneView extends View({
    inject: { router: Router },
    params: z.object({ zone: z.string().min(3) }),
    query: z.object({ page: z.coerce.number().int().positive().default(1) }),
    title: 'Zone',
}) {
    readonly clicks = signal(0);
    readonly bump = command({ title: 'Bump', key: 'alt+k', run: () => this.clicks.set(this.clicks() + 1) });

    render(): Node {
        return element('Stack', {
            props: { 'data-view': 'zone' },
            children: [
                element('Text', { props: { 'data-zone': '' }, children: [text(() => `${this.params.zone} clicks=${this.clicks()}`)] }),
                element('Text', { props: { 'data-page': '' }, children: [text(() => `page ${this.query().page}`)] }),
                this.mount(Link, {
                    href: this.inject.router.href(ZoneView, { zone: this.params.zone, page: 2 }),
                    children: [text('page 2')],
                }),
                element('Button', {
                    props: { 'aria-label': 'click' },
                    intents: { activate: { action: this.on(() => this.clicks.set(this.clicks() + 1)) } },
                    children: [text('Click')],
                }),
                this.mount(Link, { href: this.inject.router.href(HomeView), children: [text('home')] }),
                this.mount(Link, { href: this.inject.router.href(ZoneView, { zone: 'other.net' }), children: [text('to other.net')] }),
            ],
        });
    }
}

class Site extends App({ routes: { '/': HomeView, '/zones/:zone': ZoneView } }) {}

// ---------------------------------------------------------------------------- a layout with a guard

class Session extends Service({}) {
    readonly signedIn = signal(false);
}

let layoutsBuilt = 0;

class ConsoleLayout extends Component({ inject: { session: Session, router: Router }, props: props<LayoutProps>() }) {
    readonly clicks = signal(0);
    constructed = ++layoutsBuilt;

    render(): Node {
        return when(
            () => this.inject.session.signedIn(),
            () => element('Stack', {
                children: [
                    element('Text', { props: { 'data-layout': '' }, children: [text(() => `layout clicks=${this.clicks()}`)] }),
                    element('Button', {
                        props: { 'aria-label': 'layout click' },
                        intents: { activate: { action: this.on(() => this.clicks.set(this.clicks() + 1)) } },
                        children: [text('+')],
                    }),
                    this.props.outlet,
                ],
            }),
            () => this.mount(Redirect, { to: this.inject.router.href(SignInView) }),
        );
    }
}

class PublicView extends View({}) {
    render(): Node { return element('Stack', { props: { 'data-view': 'public' }, children: [] }); }
}

class SignInView extends View({ inject: { session: Session } }) {
    render(): Node {
        return element('Stack', {
            props: { 'data-view': 'sign-in' },
            children: [element('Button', {
                props: { 'aria-label': 'sign in' },
                intents: { activate: { action: this.on(() => this.inject.session.signedIn.set(true)) } },
                children: [text('Sign in')],
            })],
        });
    }
}

class PageA extends View({ layout: ConsoleLayout, inject: { router: Router } }) {
    render(): Node {
        return element('Stack', {
            props: { 'data-view': 'a' },
            children: [this.mount(Link, { href: this.inject.router.href(PageB), children: [text('to b')] })],
        });
    }
}

class PageB extends View({ layout: ConsoleLayout }) {
    render(): Node { return element('Stack', { props: { 'data-view': 'b' }, children: [] }); }
}

class Guarded extends App({
    routes: { '/': PublicView, '/sign-in': SignInView, '/console/a': PageA, '/console/b': PageB },
}) {}

// ---------------------------------------------------------------------------- harness

let root: HTMLElement;
let site: MountedApp | undefined;
let original = '';

beforeEach(() => {
    original = `${location.pathname}${location.search}`;
    root = document.createElement('div');
    document.body.appendChild(root);
});

afterEach(() => {
    site?.dispose();
    site = undefined;
    root.remove();
    history.replaceState(null, '', original);
});

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
const view = (): string | null => root.querySelector('[data-view]')?.getAttribute('data-view') ?? null;
const zone = (): string | null => root.querySelector('[data-zone]')?.textContent ?? null;
const link = (label: string): HTMLAnchorElement => {
    const found = [...root.querySelectorAll('a')].find((a) => a.textContent === label);
    if (found === undefined) throw new Error(`no link "${label}"`);
    return found;
};

/** `history.back()` is asynchronous: wait for the popstate it causes. */
async function goBack(): Promise<void> {
    const popped = new Promise((resolve) => addEventListener('popstate', resolve, { once: true }));
    history.back();
    await popped;
    await frame();
}

async function goForward(): Promise<void> {
    const popped = new Promise((resolve) => addEventListener('popstate', resolve, { once: true }));
    history.forward();
    await popped;
    await frame();
}

// ---------------------------------------------------------------------------- tests

describe('an App as a single-page site', () => {
    it('loads a deep link straight into the right view, params typed and parsed', async () => {
        history.pushState(null, '', '/zones/deep.example');
        site = mountSite(Site, { root });
        await frame();
        expect(view()).toBe('zone');
        expect(zone()).toBe('deep.example clicks=0');
        expect(document.title).toBe('Zone');
    });

    it('follows a clicked link without a page load, and back and forward work', async () => {
        history.pushState(null, '', '/');
        site = mountSite(Site, { root });
        await frame();
        expect(view()).toBe('home');

        const beforeClick = performance.getEntriesByType('navigation').length;
        await userEvent.click(link('example.com'));
        await frame();
        expect(location.pathname).toBe('/zones/example.com');
        expect(zone()).toBe('example.com clicks=0');
        expect(performance.getEntriesByType('navigation').length).toBe(beforeClick);

        await userEvent.click(root.querySelector('[aria-label="click"]')!);
        await frame();
        expect(zone()).toBe('example.com clicks=1');

        await goBack();
        expect(location.pathname).toBe('/');
        expect(view()).toBe('home');

        await goForward();
        expect(location.pathname).toBe('/zones/example.com');
        // A new instance: the view that was left was disposed, so its state went with it.
        expect(zone()).toBe('example.com clicks=0');
    });

    it('makes a change of params a new instance, and the old one\'s key goes with it', async () => {
        history.pushState(null, '', '/zones/example.com');
        site = mountSite(Site, { root });
        await frame();

        await userEvent.keyboard('{Alt>}k{/Alt}');
        await frame();
        expect(zone()).toBe('example.com clicks=1');

        await userEvent.click(link('to other.net'));
        await frame();
        expect(zone()).toBe('other.net clicks=0');

        // Exactly one Bump is live: the new view's. The old instance's command left with it.
        const bumps = site.runtime.commands.live().filter((l) => l.command.title === 'Bump');
        expect(bumps).toHaveLength(1);
        await userEvent.keyboard('{Alt>}k{/Alt}');
        await frame();
        expect(zone()).toBe('other.net clicks=1');
    });

    it('keeps the instance when only the query changes: state survives, `query()` follows the URL', async () => {
        history.pushState(null, '', '/zones/example.com');
        site = mountSite(Site, { root });
        await frame();
        expect(root.querySelector('[data-page]')?.textContent).toBe('page 1');

        await userEvent.click(root.querySelector('[aria-label="click"]')!);
        await frame();
        const handlers = site.handlerCount();

        await userEvent.click(link('page 2'));
        await frame();
        expect(location.search).toBe('?page=2');
        expect(root.querySelector('[data-page]')?.textContent).toBe('page 2');
        // Same instance: its clicks are still there, and nothing was re-registered.
        expect(zone()).toBe('example.com clicks=1');
        expect(site.handlerCount()).toBe(handlers);

        await goBack();
        expect(root.querySelector('[data-page]')?.textContent).toBe('page 1');
        expect(zone()).toBe('example.com clicks=1');

        // A query the view refuses is a 404, like refused params.
        site.navigate('/zones/example.com?page=zero');
        await frame();
        expect(root.querySelector('[data-not-found]')).not.toBeNull();
    });

    it('shows not-found for a URL nothing matches, and for params the view\'s schema refuses', async () => {
        // Distinctive, so it cannot coincide with a view's title left over from another test.
        const pageTitle = 'the page before the site';
        document.title = pageTitle;
        history.pushState(null, '', '/nowhere');
        site = mountSite(Site, { root });
        await frame();
        expect(root.querySelector('[data-not-found]')?.textContent).toBe('Nothing here: /nowhere');

        site.navigate('/zones/ab'); // zone must be at least 3 characters
        await frame();
        expect(root.querySelector('[data-not-found]')).not.toBeNull();
        expect(view()).toBeNull();

        site.navigate('/zones/abc');
        await frame();
        expect(root.querySelector('[data-not-found]')).toBeNull();
        expect(zone()).toBe('abc clicks=0');
        expect(document.title).toBe('Zone');

        // Leaving a titled view for a URL nothing matches puts the page's own title back, rather
        // than leaving "Zone" over a not-found page.
        site.navigate('/nowhere/at/all');
        await frame();
        expect(document.title).toBe(pageTitle);
    });

    it('keeps a layout mounted across the pages that share it, and guards them all with one Redirect', async () => {
        history.pushState(null, '', '/');
        site = mountSite(Guarded, { root });
        await frame();
        expect(view()).toBe('public');
        expect(root.querySelector('[data-layout]')).toBeNull();

        // Signed out: the guarded page redirects, replacing the history entry.
        site.navigate('/console/a');
        await frame();
        await frame();
        expect(location.pathname).toBe('/sign-in');
        expect(view()).toBe('sign-in');

        await userEvent.click(root.querySelector('[aria-label="sign in"]')!);
        const built = layoutsBuilt; // one was built, and redirected, while signed out
        site.navigate('/console/a');
        await frame();
        expect(view()).toBe('a');
        expect(layoutsBuilt).toBe(built + 1);
        await userEvent.click(root.querySelector('[aria-label="layout click"]')!);
        await frame();
        expect(root.querySelector('[data-layout]')?.textContent).toBe('layout clicks=1');

        // Page b, same layout: the layout keeps its state; only the outlet changed.
        await userEvent.click(link('to b'));
        await frame();
        expect(view()).toBe('b');
        expect(root.querySelector('[data-layout]')?.textContent).toBe('layout clicks=1');
        expect(layoutsBuilt).toBe(built + 1);

        // Out of the layout and back in: a new instance.
        site.navigate('/');
        await frame();
        expect(root.querySelector('[data-layout]')).toBeNull();
        site.navigate('/console/a');
        await frame();
        expect(root.querySelector('[data-layout]')?.textContent).toBe('layout clicks=0');
        expect(layoutsBuilt).toBe(built + 2);
    });

    it('leaves a modified click to the browser: the page does not navigate or cancel it', async () => {
        history.pushState(null, '', '/');
        site = mountSite(Site, { root });
        await frame();

        // Synthesised on purpose: a real ctrl-click opens a new tab, which is the browser's business
        // and outside this page. What is under test is only that the site did not claim the click.
        const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
        const anchor = link('example.com');
        // Stop the browser's own follow-through, after the site has had its chance to claim it.
        root.addEventListener('click', (e) => { claimed = e.defaultPrevented; e.preventDefault(); }, { once: true });
        let claimed = true;
        anchor.dispatchEvent(event);
        await frame();

        expect(claimed).toBe(false);
        expect(location.pathname).toBe('/');
        expect(anchor.getAttribute('href')).toBe('/zones/example.com');
    });
});
