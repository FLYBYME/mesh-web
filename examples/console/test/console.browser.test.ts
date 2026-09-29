/**
 * The reference console, clicked through in a real browser: the guard, sign-in with field errors,
 * URL-held list state, a form built from a command, confirm dialogs, keys, and a layout that
 * persists across pages. Nothing is called that a person could not do — except the API, which is
 * the fake one with its latency taken out (`replace`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import { mountSite, replace, type MountedApp } from '@flybyme/mesh-web';
import Console from '../src/app.js';
import { FakeApi } from '../src/api/fake-api.js';

class InstantApi extends FakeApi {
    override latency = 0;
}

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

function open(path: string): MountedApp {
    history.pushState(null, '', path);
    site = mountSite(Console, { root, replace: [replace(FakeApi, InstantApi)] });
    return site;
}

const $ = <E extends Element = HTMLElement>(selector: string): E | null => root.querySelector<E>(selector);
const page = (): string | null => $('[data-page]')?.getAttribute('data-page') ?? null;
const until = (fn: () => void): Promise<void> => vi.waitFor(fn, { timeout: 2000, interval: 10 });

function byLabel<E extends HTMLElement>(label: string): E {
    const found = [...root.querySelectorAll<E>('input, select, button')].find((el) =>
        el.getAttribute('aria-label') === label || (el.id !== '' && root.querySelector(`label[for="${el.id}"]`)?.textContent === label));
    if (found === undefined) throw new Error(`no control labelled "${label}"`);
    return found;
}

function button(text: string): HTMLButtonElement {
    const found = [...root.querySelectorAll('button')].find((b) => b.textContent === text);
    if (found === undefined) throw new Error(`no button "${text}"`);
    return found;
}

function link(text: string): HTMLAnchorElement {
    const found = [...root.querySelectorAll('a')].find((a) => a.textContent === text);
    if (found === undefined) throw new Error(`no link "${text}"`);
    return found;
}

const rows = (): string[] => [...root.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')?.textContent ?? '');
const problem = (field: string): string => $(`[data-problem-for="${field}"]`)?.textContent ?? '';

/** `history.back()` is asynchronous: wait for the popstate it causes. */
async function goBack(): Promise<void> {
    const popped = new Promise((resolve) => addEventListener('popstate', resolve, { once: true }));
    history.back();
    await popped;
}

async function signIn(): Promise<void> {
    await userEvent.fill(byLabel('Email'), 'ada@example.com');
    await userEvent.fill(byLabel('Password'), 'correct horse');
    await userEvent.click(button('Sign in'));
}

describe('the reference console', () => {
    it('guards the console, and signs in through a form built from the command, errors by field', async () => {
        open('/domains?q=reef');
        await until(() => expect(page()).toBe('sign-in'));
        // The guard carried where the visitor was going; the redirect replaced the entry.
        expect(new URLSearchParams(location.search).get('next')).toBe('/domains?q=reef');

        await userEvent.fill(byLabel('Email'), 'not an email');
        await userEvent.fill(byLabel('Password'), 'short');
        await userEvent.click(button('Sign in'));
        await until(() => expect(problem('email')).toBe('Enter an email address.'));
        expect(problem('password')).toBe('At least 8 characters.');
        expect(byLabel('Email').getAttribute('aria-invalid')).toBe('true');

        await userEvent.fill(byLabel('Email'), 'ada@example.com');
        await userEvent.fill(byLabel('Password'), 'wrong password');
        await userEvent.click(button('Sign in'));
        await until(() => expect($('.ui-form [role="alert"]')?.textContent).toBe('Wrong email or password.'));
        expect(problem('email')).toBe('');

        await userEvent.fill(byLabel('Password'), 'correct horse');
        await userEvent.click(button('Sign in'));
        await until(() => expect(page()).toBe('domains'));
        expect(location.pathname + location.search).toBe('/domains?q=reef');
        await until(() => expect(rows()).toEqual(['reef.org']));
    });

    it('keeps list state in the URL without rebuilding the list: search, page, sort, open panel', async () => {
        open('/sign-in');
        await signIn();
        await until(() => expect(rows()).toHaveLength(8));
        expect($('[data-page-of]')?.textContent).toBe('Page 1 of 3');

        // Open the add panel — this instance's own state.
        await userEvent.keyboard('{Alt>}a{/Alt}');
        await until(() => expect(byLabel('Domain')).toBeTruthy());

        // Sort is the URL's and the server's: descending across all 23, not within one page.
        expect($('th[aria-sort="ascending"]')?.textContent).toBe('Domain ▲');
        await userEvent.click(button('Domain ▲'));
        await until(() => expect(rows()[0]).toBe('undertow.net'));
        expect(new URLSearchParams(location.search).get('dir')).toBe('desc');

        await userEvent.click(link('Next →'));
        await until(() => expect($('[data-page-of]')?.textContent).toBe('Page 2 of 3'));
        await until(() => expect(rows()[0]).toBe('marina.io'));
        expect(new URLSearchParams(location.search).get('page')).toBe('2');
        // Same instance throughout: the panel is still open. The link kept the sort.
        expect(byLabel('Domain')).toBeTruthy();
        expect($('th[aria-sort="descending"]')).not.toBeNull();

        await goBack();
        await goBack();
        await until(() => expect(rows()[0]).toBe('atoll.app'));

        await userEvent.fill(byLabel('Search domains'), 'dev');
        await until(() => expect(rows()).toEqual(['cove.dev', 'harbor.dev', 'jetty.dev', 'kelp.dev', 'swell.dev']));
        expect(new URLSearchParams(location.search).get('q')).toBe('dev');

        await userEvent.fill(byLabel('Search domains'), 'zzz');
        await until(() => expect($('[data-empty] h3')?.textContent).toBe('Nothing matches “zzz”'));
    });

    it('adds a domain and a record through command forms, and removes them through confirm dialogs', async () => {
        open('/sign-in');
        await signIn();
        await until(() => expect(page()).toBe('domains'));

        await userEvent.click(button('Add domain'));
        await userEvent.fill(byLabel('Domain'), 'not a domain');
        await userEvent.click(root.querySelector<HTMLButtonElement>('.ui-panel button[type="submit"]')!);
        await until(() => expect(problem('name')).toBe('Enter a domain like example.com.'));

        await userEvent.fill(byLabel('Domain'), 'NewZone.Dev');
        await userEvent.click(root.querySelector<HTMLButtonElement>('.ui-panel button[type="submit"]')!);
        // The schema normalised the name; the form navigated with the command's typed result.
        await until(() => expect(location.pathname).toBe('/domains/newzone.dev'));
        await until(() => expect($('[data-empty] h3')?.textContent).toBe('No records'));
        expect($('h1')?.textContent).toBe('newzone.dev');

        // A rule that spans two fields, reported on the one to change.
        await userEvent.fill(byLabel('Name'), 'api');
        await userEvent.fill(byLabel('Value'), 'not-an-ip');
        await userEvent.click(button('Add record'));
        await until(() => expect(problem('value')).toBe('An A record points at an IPv4 address.'));

        await userEvent.fill(byLabel('Value'), '198.51.100.7');
        await userEvent.click(button('Add record'));
        await until(() => expect([...root.querySelectorAll('tbody td:nth-child(2)')].map((td) => td.textContent)).toContain('api'));
        // The form reset for the next record.
        expect(byLabel<HTMLInputElement>('Name').value).toBe('');

        const apiRow = [...root.querySelectorAll('tbody tr')].find((tr) => tr.children[1]?.textContent === 'api')!;
        await userEvent.click(apiRow.querySelector('button')!);
        await userEvent.click(button('Remove record'));
        await until(() => expect([...root.querySelectorAll('tbody td:nth-child(2)')].map((td) => td.textContent)).not.toContain('api'));

        await userEvent.click(button('Remove domain'));
        await userEvent.click(button('Remove'));
        await until(() => expect(page()).toBe('domains'));
        await userEvent.fill(byLabel('Search domains'), 'newzone');
        await until(() => expect($('[data-empty]')).not.toBeNull());
    });

    it('keeps the console layout across its pages, and its keys live only inside it', async () => {
        open('/sign-in');
        await signIn();
        await until(() => expect(rows()).toHaveLength(8));

        await userEvent.keyboard('{Alt>}b{/Alt}');
        await until(() => expect($('.console')?.getAttribute('data-collapsed')).toBe('true'));

        await userEvent.click(link('breakwater.io'));
        await until(() => expect(page()).toBe('domain'));
        // The view's own `title()`, not the spec's static one.
        expect(document.title).toBe('breakwater.io · Harbor DNS');
        // Different page, same layout instance: still collapsed.
        expect($('.console')?.getAttribute('data-collapsed')).toBe('true');

        await userEvent.keyboard('{Alt>}o{/Alt}');
        await until(() => expect(page()).toBe('home'));
        expect(document.title).toBe('Harbor DNS');
        expect($('.console')).toBeNull();
        // The layout left, and its alt+b with it.
        expect(site?.runtime.commands.live().map((l) => l.command.title)).not.toContain('Toggle sidebar');
    });

    it('shows a missing domain as that page\'s error, inside the console', async () => {
        open('/sign-in?next=/domains/nope.example');
        await signIn();
        await until(() => expect(page()).toBe('domain'));
        await until(() => expect($('[data-page="domain"] [role="alert"]')?.textContent).toBe('No domain nope.example.'));
        expect($('.console-nav')).not.toBeNull();
    });
});
