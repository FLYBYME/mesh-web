/**
 * @vitest-environment jsdom
 *
 * `start(composition)` — the kernel's entry point, the function mesh-serve's generated boot module
 * calls. The assertions are about what a *site* gets for free: a root it did not have to contain, a
 * notification surface, the API read from the document — and, since phase 5c, one clear rule about
 * what boots (an App) and what does not (the legacy parts), said out loud.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { element, text, type Node } from '../src/index.js';
import { start } from '../src/kernel/start.js';
import { App, View } from '../src/app/index.js';

class Home extends View({ title: 'Home' }) {
    render(): Node { return element('Text', { props: { 'data-home': '' }, children: [text('home')] }); }
}

class Site extends App({ routes: { '/': Home } }) {}

/** A legacy-style part: a class that is not an App. */
class LegacyExtension {
    activate(): void { /* the part model's shape; never called now */ }
}

const clean = (): void => { document.body.replaceChildren(); };

afterEach(() => {
    clean();
    delete document.documentElement.dataset['api'];
});

describe('the page it builds', () => {
    it('creates its own root, so a page need not contain an element for a part to find', () => {
        const started = start({ application: 'test', parts: [{ id: 'site', contribution: Site }] });
        const root = document.getElementById('mesh-web-root');
        expect(root).not.toBeNull();
        expect(root?.querySelector('[data-home]')).not.toBeNull();
        started.dispose();
        // It made the root, so it takes it away; a root it was given stays (next test).
        expect(document.getElementById('mesh-web-root')).toBeNull();
    });

    it('uses a root it was given', () => {
        const root = document.createElement('main');
        document.body.append(root);
        const started = start({ application: 'test', root, parts: [{ id: 'site', contribution: Site }] });
        expect(root.querySelector('[data-home]')).not.toBeNull();
        expect(document.getElementById('mesh-web-root')).toBeNull();
        started.dispose();
        expect(root.isConnected).toBe(true);
    });

    it('mounts a notification surface the kernel owns, and takes it away on dispose', () => {
        // A capability with no surface is a silent failure: cx.notifications.warn would be recorded
        // correctly and displayed nowhere.
        const started = start({ application: 'test', parts: [{ id: 'site', contribution: Site }] });
        expect(document.querySelector('.mesh-notifications')).not.toBeNull();
        started.dispose();
        expect(document.querySelector('.mesh-notifications')).toBeNull();
    });

    it('reads the api from the document rather than being told twice', () => {
        document.documentElement.dataset['api'] = 'https://api.example';
        const started = start({ application: 'test', parts: [{ id: 'site', contribution: Site }] });
        expect(started.services.credentials.origin).toBe('https://api.example');
        started.dispose();
    });

    it('prefers an api the composition states', () => {
        document.documentElement.dataset['api'] = 'https://from-document.example';
        const started = start({ application: 'test', api: 'https://stated.example', parts: [{ id: 'site', contribution: Site }] });
        expect(started.services.credentials.origin).toBe('https://stated.example');
        started.dispose();
    });
});

describe('what boots', () => {
    it('refuses a composition with no App, and names the legacy parts it will not boot', () => {
        expect(() => start({ application: 'old-site', parts: [{ id: 'auth', contribution: LegacyExtension }] }))
            .toThrow(/old-site: no part is an App.*auth is from the legacy part model/);
        expect(() => start({ application: 'empty', parts: [] })).toThrow(/empty: no part is an App, so there is nothing to boot\./);
    });

    it('boots the App and says — in the log, not silently — which legacy parts it did not', () => {
        const started = start({
            application: 'mixed',
            parts: [{ id: 'auth', contribution: LegacyExtension }, { id: 'site', contribution: Site }],
        });
        expect(document.querySelector('[data-home]')).not.toBeNull();
        const warnings = started.services.logs.filter((r) => r.level === 'warn').map((r) => r.message);
        expect(warnings).toContain('Not booted — legacy parts: auth. Only an App boots.');
        started.dispose();
    });

    it('accepts the legacy `open` field a boot script may still send, and ignores it', () => {
        const started = start({
            application: 'test',
            open: [{ application: 'site', views: ['main'] }],
            parts: [{ id: 'site', contribution: Site }],
        });
        expect(document.querySelector('[data-home]')).not.toBeNull();
        started.dispose();
    });
});
