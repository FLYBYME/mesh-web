/**
 * Phase 5a (docs/app-model.md): `start()` — the entry point mesh-serve's boot script calls — boots
 * an app-model App as a site, with capabilities the kernel really built rather than a hand-passed
 * `granted`. The boot script's contract is unchanged: a list of default-exported classes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import '../../src/kernel.css';
import { call, defineApi, element, needs, signal, text, type Node } from '../../src/index.js';
import { start } from '../../src/kernel/start.js';
import { App, command, Service, View } from '../../src/app/index.js';

const siteApi = defineApi({
    id: 'site',
    exposure: 'sha256:site',
    calls: { 'part.find': call<void, readonly { readonly id: string }[]>('GET', '/parts') },
});

class Notes extends Service({ needs: needs('notifications', 'mesh'), api: siteApi }) {
    readonly saved = signal(0);
    readonly save = command({
        title: 'Save',
        run: () => {
            this.saved.set(this.saved() + 1);
            this.cx.notifications.info(`Saved ${this.saved()}`);
        },
    });
    /** The API this service's client is for — proof it is the kernel's client for the declared API. */
    get apiName(): string {
        return this.cx.mesh.api;
    }
}

class Home extends View({ inject: { notes: Notes }, title: 'Booted' }) {
    render(): Node {
        const { notes } = this.inject;
        return element('Stack', {
            children: [
                element('Text', { props: { 'data-api': '' }, children: [text(notes.apiName)] }),
                element('Button', {
                    props: { 'aria-label': 'save' },
                    intents: { activate: { action: this.on(() => void notes.save.run()) } },
                    children: [text('Save')],
                }),
            ],
        });
    }
}

class Booted extends App({ needs: needs('notifications', 'mesh'), api: siteApi, routes: { '/': Home } }) {}

let root: HTMLElement;
let original = '';
let stop: (() => void) | undefined;

beforeEach(() => {
    original = `${location.pathname}${location.search}`;
    history.replaceState(null, '', '/');
    root = document.createElement('div');
    document.body.appendChild(root);
});

afterEach(() => {
    stop?.();
    stop = undefined;
    root.remove();
    history.replaceState(null, '', original);
});

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));

describe('start() boots an App', () => {
    it('as a site, with the kernel\'s own capabilities', async () => {
        const started = start({ application: 'booted', api: 'https://api.invalid', root, parts: [{ id: 'booted', contribution: Booted }] });
        stop = () => started.dispose();
        expect(started.kind).toBe('app');
        await started.ready;
        await frame();

        // cx.mesh is the kernel's client, for the API the App declared.
        expect(root.querySelector('[data-api]')?.textContent).toBe('site');
        expect(document.title).toBe('Booted');

        // cx.notifications reaches the kernel's own notification surface, which names the part.
        await userEvent.click(root.querySelector('[aria-label="save"]')!);
        await frame();
        expect([...root.querySelectorAll('.mesh-notice')].map((n) => n.textContent)).toContain('booted: Saved 1');
    });

    it('refuses to boot an App whose service needs what the App was not granted', () => {
        class Greedy extends Service({ needs: needs('storage') }) {}
        class Uses extends View({ inject: { greedy: Greedy } }) {
            render(): Node { return element('Stack', { children: [] }); }
        }
        class Narrow extends App({ routes: { '/': Uses } }) {}

        expect(() => start({ application: 'narrow', root, parts: [{ id: 'narrow', contribution: Narrow }] }))
            .toThrow(/Greedy needs 'storage', which the app \(Narrow\) was not granted/);
    });
});
