/**
 * The storage capability in a real browser, booted by the kernel's `start()`: a value written by
 * pressing a button shows on the page, and one written by *another tab* (a `StorageEvent`) does too.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import { z } from 'zod';
import {
    App, command, element, KEY_SEPARATOR, LOCAL_PREFIX, needs, Service, store, text, View,
    type Node,
} from '@flybyme/mesh-web';
import { start, type Started } from '../../src/kernel/start.js';

const TestStore = store({ name: 'test-store', hive: 'device', schema: z.string(), fallback: '' });

class Prefs extends Service({ needs: needs('storage') }) {
    readonly store = this.cx.storage.open(TestStore);
    readonly value = this.store.get('my-key');
    readonly save = command({ title: 'Save', run: async () => { await this.store.set('my-key', 'hello'); } });
}

class Main extends View({ inject: { prefs: Prefs } }) {
    render(): Node {
        const { prefs } = this.inject;
        return element('Stack', {
            children: [
                element('Text', {
                    props: { id: 'value-display' },
                    children: [text(() => { const v = prefs.value(); return v === '' ? 'empty' : (v ?? 'undefined'); })],
                }),
                element('Button', {
                    props: { 'aria-label': 'save' },
                    intents: { activate: { action: this.on(() => void prefs.save.run()) } },
                    children: [text('Save')],
                }),
            ],
        });
    }
}

class StorageApp extends App({ needs: needs('storage'), services: [Prefs], routes: { '/': Main } }) {}

const shown = (): string => document.getElementById('value-display')?.textContent ?? '';

async function until(check: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
}

describe('storage capability in a real browser', () => {
    let started: Started | undefined;
    let original = '';

    beforeEach(() => {
        original = `${location.pathname}${location.search}`;
        history.replaceState(null, '', '/');
    });

    afterEach(() => {
        started?.dispose();
        started = undefined;
        localStorage.clear();
        history.replaceState(null, '', original);
    });

    it('shows a value saved by pressing a button, and one saved by another tab', async () => {
        // The part id is the storage namespace, so the other tab's key names it.
        started = start({ application: 'storage', parts: [{ id: 'app', contribution: StorageApp }] });
        await until(() => shown() === 'empty', 'the initial value');

        await userEvent.click(document.querySelector('[aria-label="save"]')!);
        await until(() => shown() === 'hello', 'the saved value');

        const storageKey = `${LOCAL_PREFIX}app${KEY_SEPARATOR}test-store/my-key`;
        const newValue = JSON.stringify({ value: 'world', version: 'some-version', updatedAt: Date.now() });
        localStorage.setItem(storageKey, newValue);
        window.dispatchEvent(new StorageEvent('storage', { key: storageKey, newValue }));

        await until(() => shown() === 'world', 'the other tab\'s value');
    });
});
