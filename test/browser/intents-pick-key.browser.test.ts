/**
 * `pick`, `key` and `context`'s position, with a real mouse and real keys.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import { element, signal, text, type Json, type Node } from '../../src/index.js';
import { App, mountSite, View, type MountedApp } from '../../src/app/index.js';

const heard = signal<readonly { readonly name: string; readonly value: Json | undefined }[]>([]);

const add = (name: string, value: Json | undefined): void => {
    heard.set([...heard.peek(), { name, value }]);
};

class Target extends View({}) {
    render(): Node {
        return element('Stack', {
            props: { 'data-target': '', tabindex: 0, role: 'application', style: { width: '200px', height: '100px', position: 'fixed', left: '20px', top: '30px' } },
            intents: {
                pick: { action: this.on((value) => add('pick', value)) },
                key: { action: this.on((value) => add('key', value)) },
                context: { action: this.on((value) => add('context', value)), preventDefault: true },
            },
            children: [text('target')],
        });
    }
}

class TargetApp extends App({ routes: { '/': Target } }) {}

let site: MountedApp | undefined;
let root: HTMLElement | undefined;
const original = `${location.pathname}${location.search}`;

function mount(): HTMLElement {
    history.pushState(null, '', '/');
    heard.set([]);
    root = document.createElement('div');
    document.body.appendChild(root);
    site = mountSite(TargetApp, { root });

    const target = root.querySelector<HTMLElement>('[data-target]');
    if (target === null) throw new Error('not mounted');

    return target;
}

afterEach(() => {
    site?.dispose();
    root?.remove();
    history.replaceState(null, '', original);
});

const last = (): { readonly name: string; readonly value: Json | undefined } | undefined => heard.peek().at(-1);

describe('intents that report what was held and where', () => {
    it('pick says which modifiers were held', async () => {
        const target = mount();

        await userEvent.click(target);
        await vi.waitFor(() => expect(last()).toEqual({ name: 'pick', value: { ctrl: false, shift: false } }));

        await userEvent.keyboard('{Control>}');
        await userEvent.click(target);
        await userEvent.keyboard('{/Control}');
        await vi.waitFor(() => expect(last()).toEqual({ name: 'pick', value: { ctrl: true, shift: false } }));

        await userEvent.keyboard('{Shift>}');
        await userEvent.click(target);
        await userEvent.keyboard('{/Shift}');
        await vi.waitFor(() => expect(last()).toEqual({ name: 'pick', value: { ctrl: false, shift: true } }));
    });

    it('key hears navigation keys, and not text', async () => {
        const target = mount();

        await userEvent.click(target);
        heard.set([]);

        await userEvent.keyboard('a{ArrowDown}b{F2}{Delete}');
        await vi.waitFor(() => expect(heard.peek().map((entry) => entry.value)).toEqual([
            { key: 'ArrowDown', ctrl: false, shift: false },
            { key: 'F2', ctrl: false, shift: false },
            { key: 'Delete', ctrl: false, shift: false },
        ]));
    });

    it('context says where it was pressed', async () => {
        const target = mount();

        await userEvent.click(target, { button: 'right', position: { x: 10, y: 20 } });
        await vi.waitFor(() => expect(heard.peek().find((entry) => entry.name === 'context')?.value).toEqual({ x: 30, y: 50 }));
    });
});
