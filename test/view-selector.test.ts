/**
 * @vitest-environment jsdom
 *
 * View selector tests (ctrl+alt+w).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { element, text, type Node } from '../src/index.js';
import { start } from '../src/kernel/start.js';
import { App, View } from '../src/app/index.js';

class HomeView extends View({ title: 'Home Page' }) {
    render(): Node { return element('Text', { children: [text('Home')] }); }
}

class AppsView extends View({ title: 'Applications' }) {
    render(): Node { return element('Text', { children: [text('Apps')] }); }
}

class RepoDetailView extends View({ params: z.object({ repoId: z.string() }) }) {
    render(): Node { return element('Text', { children: [text('Repo')] }); }
}

class TestApp extends App({
    routes: {
        '/': HomeView,
        '/apps': AppsView,
        '/repos/:repoId': RepoDetailView,
    },
}) {}

const clean = (): void => { document.body.replaceChildren(); };

afterEach(() => {
    clean();
});

describe('view selector (ctrl+alt+w)', () => {
    it('is mounted by start() and hidden by default', () => {
        const started = start({ application: 'test', parts: [{ id: 'app', contribution: TestApp }] });
        const host = document.querySelector('.mesh-view-selector');
        expect(host).not.toBeNull();
        expect(started.viewSelector.isOpen()).toBe(false);
        if (host instanceof HTMLElement) {
            expect(host.hidden).toBe(true);
        }
        started.dispose();
        expect(document.querySelector('.mesh-view-selector')).toBeNull();
    });

    it('toggles open and close via ctrl+alt+w and escape', () => {
        const started = start({ application: 'test', parts: [{ id: 'app', contribution: TestApp }] });
        expect(started.viewSelector.isOpen()).toBe(false);

        // Open with ctrl+alt+w
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'w',
            ctrlKey: true,
            altKey: true,
            bubbles: true,
        }));
        expect(started.viewSelector.isOpen()).toBe(true);
        const search = document.querySelector('.mesh-view-search');
        if (search instanceof HTMLInputElement) {
            expect(document.activeElement).toBe(search);
        }

        // Close with Escape
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
        }));
        expect(started.viewSelector.isOpen()).toBe(false);

        started.dispose();
    });

    it('lists all registered routes with title and pattern', () => {
        const started = start({ application: 'test', parts: [{ id: 'app', contribution: TestApp }] });
        started.viewSelector.open();

        const items = document.querySelectorAll('.mesh-view-item');
        expect(items.length).toBe(3);

        const titles = Array.from(document.querySelectorAll('.mesh-view-title')).map((el) => el.textContent);
        expect(titles).toEqual(['Home Page', 'Applications', 'RepoDetailView']);

        const patterns = Array.from(document.querySelectorAll('.mesh-view-pattern')).map((el) => el.textContent);
        expect(patterns).toEqual(['/', '/apps', '/repos/:repoId']);

        const badges = document.querySelectorAll('.mesh-view-param-badge');
        expect(badges.length).toBe(1);

        started.dispose();
    });

    it('filters routes when typing in search input', () => {
        const started = start({ application: 'test', parts: [{ id: 'app', contribution: TestApp }] });
        started.viewSelector.open();

        const search = document.querySelector('.mesh-view-search');
        if (search instanceof HTMLInputElement) {
            search.value = 'app';
            search.dispatchEvent(new Event('input', { bubbles: true }));

            const items = document.querySelectorAll('.mesh-view-item');
            expect(items.length).toBe(1);

            const title = document.querySelector('.mesh-view-title');
            expect(title?.textContent).toBe('Applications');
        }

        started.dispose();
    });

    it('navigates to non-parametric route on Enter', () => {
        const started = start({ application: 'test', parts: [{ id: 'app', contribution: TestApp }] });
        started.viewSelector.open();

        const search = document.querySelector('.mesh-view-search');
        if (search instanceof HTMLInputElement) {
            search.value = 'apps';
            search.dispatchEvent(new Event('input', { bubbles: true }));

            search.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
            }));

            expect(started.viewSelector.isOpen()).toBe(false);
            expect(started.site.route()?.pattern).toBe('/apps');
        }

        started.dispose();
    });

    it('pre-fills search on parametric route on Enter', () => {
        const started = start({ application: 'test', parts: [{ id: 'app', contribution: TestApp }] });
        started.viewSelector.open();

        const search = document.querySelector('.mesh-view-search');
        if (search instanceof HTMLInputElement) {
            search.value = 'repo';
            search.dispatchEvent(new Event('input', { bubbles: true }));

            search.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
            }));

            expect(started.viewSelector.isOpen()).toBe(true);
            expect(search.value).toBe('/repos/:repoId');
        }

        started.dispose();
    });

    it('navigates to a typed custom path on Enter', () => {
        const started = start({ application: 'test', parts: [{ id: 'app', contribution: TestApp }] });
        started.viewSelector.open();

        const search = document.querySelector('.mesh-view-search');
        if (search instanceof HTMLInputElement) {
            search.value = '/repos/my-cool-repo';

            search.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
            }));

            expect(started.viewSelector.isOpen()).toBe(false);
            expect(started.site.route()?.pattern).toBe('/repos/:repoId');
            expect(started.site.route()?.raw['repoId']).toBe('my-cool-repo');
        }

        started.dispose();
    });

    it('navigates when clicking an item', () => {
        const started = start({ application: 'test', parts: [{ id: 'app', contribution: TestApp }] });
        started.viewSelector.open();

        const items = document.querySelectorAll('.mesh-view-item');
        const appsItem = items[1];
        if (appsItem instanceof HTMLElement) {
            appsItem.click();
            expect(started.viewSelector.isOpen()).toBe(false);
            expect(started.site.route()?.pattern).toBe('/apps');
        }

        started.dispose();
    });

    it('works in windowed mode', () => {
        const started = start({
            application: 'test',
            policy: { 'window-manager/mode': 'windowed' },
            parts: [{ id: 'app', contribution: TestApp }],
        });

        expect(started.viewSelector.isOpen()).toBe(false);

        started.viewSelector.open();
        expect(started.viewSelector.isOpen()).toBe(true);

        const search = document.querySelector('.mesh-view-search');
        if (search instanceof HTMLInputElement) {
            search.value = 'apps';
            search.dispatchEvent(new Event('input', { bubbles: true }));

            search.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
            }));

            expect(started.viewSelector.isOpen()).toBe(false);
            // In windowed desktop, navigation opens a window
            if ('manager' in started.site) {
                const windows = started.site.manager.stacked();
                expect(windows.some((w) => w.view === '/apps')).toBe(true);
            }
        }

        started.dispose();
    });
});
