/**
 * What `kernel.css` does to a page — structure only — and what it no longer does (v0.20.1).
 *
 * The kernel used to paint every site dark, style every `button`/`ul`/heading on the page, and pin
 * a single-page site to the viewport with `overflow: hidden`, so nothing below the fold could be
 * scrolled to. These assert the page a visitor gets, in a real browser with real layout.
 */

import { afterEach, describe, expect, it } from 'vitest';
import '../../src/kernel.css';
import { App, element, text, View, type Node } from '../../src/index.js';
import { start, type Started } from '../../src/kernel/start.js';

class Tall extends View({}) {
    render(): Node {
        return element('Stack', {
            children: [
                element('List', { props: { 'data-list': '' }, children: [element('ListItem', { children: [text('bulleted')] })] }),
                element('Button', { props: { 'data-button': '' }, children: [text('press')] }),
                // Three screens of content: a site that cannot scroll hides two of them.
                element('Stack', { props: { style: { height: '3000px' } }, children: [text('the bottom')] }),
            ],
        });
    }
}

class TallSite extends App({ routes: { '/': Tall } }) {}

let started: Started | undefined;
let original = '';
let themeLink: HTMLLinkElement | undefined;

afterEach(() => {
    started?.dispose();
    started = undefined;
    themeLink?.remove();
    themeLink = undefined;
    window.scrollTo(0, 0);
    history.replaceState(null, '', original);
});

function boot(policy?: Record<string, unknown>): Started {
    original = `${location.pathname}${location.search}`;
    history.replaceState(null, '', '/');
    started = start({ application: 'css', parts: [{ id: 'tall', contribution: TallSite }], ...(policy === undefined ? {} : { policy }) });
    return started;
}

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
const root = (): HTMLElement => document.getElementById('mesh-web-root')!;

describe('kernel.css on a single-page site', () => {
    it('lets the page scroll past the fold', async () => {
        boot();
        await frame();

        expect(getComputedStyle(root()).overflow).not.toBe('hidden');
        expect(document.documentElement.scrollHeight).toBeGreaterThan(window.innerHeight * 2);

        window.scrollTo(0, 1500);
        await frame();
        expect(window.scrollY).toBeGreaterThan(1000);
    });

    it('does not paint the page or style the site\'s own elements', async () => {
        boot();
        await frame();

        // Not the old dark palette: an unthemed page is the browser's own.
        expect(getComputedStyle(document.body).backgroundColor).not.toBe('rgb(13, 17, 23)');
        // A list keeps its bullets; a button is the browser's button.
        expect(getComputedStyle(document.querySelector('[data-list]')!).listStyleType).not.toBe('none');
        expect(getComputedStyle(document.querySelector('[data-button]')!).backgroundColor).not.toBe('rgb(22, 27, 34)');
    });
});

describe('kernel.css on a desktop', () => {
    it('pins the page to the viewport, as the window manager needs', async () => {
        boot({ 'window-manager/mode': 'windowed' });
        await frame();

        expect(root().getAttribute('data-mesh-window-mode')).toBe('windowed');
        expect(getComputedStyle(root()).overflow).toBe('hidden');
        expect(getComputedStyle(document.body).marginTop).toBe('0px');
    });
});

describe('themes/dark.css', () => {
    it('gives back the old look when a site asks for it', async () => {
        boot();
        themeLink = document.createElement('link');
        themeLink.rel = 'stylesheet';
        themeLink.href = new URL('../../src/themes/dark.css', import.meta.url).href;
        const loaded = new Promise((resolve, reject) => { themeLink!.onload = resolve; themeLink!.onerror = reject; });
        document.head.appendChild(themeLink);
        await loaded;
        await frame();

        expect(getComputedStyle(document.body).backgroundColor).toBe('rgb(13, 17, 23)');
        expect(getComputedStyle(document.querySelector('[data-list]')!).listStyleType).toBe('none');
    });
});
