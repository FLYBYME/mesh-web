/**
 * `CommandList` and the `step` intent, on a real page with real keys.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import { element, signal, text, when, type Node } from '../../src/index.js';
import { App, command, CommandList, Component, mountSite, Service, View, type MountedApp } from '../../src/app/index.js';

const position = signal(0);
const showExtra = signal(false);

class Pages extends Service({}) {
    readonly reload = command({ title: 'Reload pages', key: 'alt+r', run: () => undefined });
}

class Extra extends Component({}) {
    readonly inspect = command({ title: 'Inspect', run: () => undefined });

    render(): Node {
        return element('Text', { children: [text('extra')] });
    }
}

class CommandsView extends View({ inject: { list: CommandList, pages: Pages } }) {
    readonly stepped = this.on((value) => {
        if (typeof value === 'number') position.set(position.peek() + value);
    });

    render(): Node {
        return element('Stack', {
            children: [
                element('Input', {
                    props: { 'aria-label': 'Filter', 'data-input': '' },
                    intents: { step: { action: this.stepped, preventDefault: true } },
                }),
                element('Text', {
                    props: { 'data-titles': '' },
                    children: [text(() => this.inject.list.live().map((entry) => entry.command.title).join(','))],
                }),
                when(() => showExtra(), () => this.mount(Extra)),
            ],
        });
    }
}

class CommandsApp extends App({ routes: { '/': CommandsView } }) {}

let site: MountedApp | undefined;
let root: HTMLElement | undefined;
const original = `${location.pathname}${location.search}`;

function open(): HTMLElement {
    position.set(0);
    showExtra.set(false);
    history.pushState(null, '', '/');
    root = document.createElement('div');
    document.body.appendChild(root);
    site = mountSite(CommandsApp, { root });

    return root;
}

afterEach(() => {
    site?.dispose();
    root?.remove();
    history.replaceState(null, '', original);
});

function find(from: HTMLElement, selector: string): HTMLElement {
    const found = from.querySelector<HTMLElement>(selector);
    if (found === null) throw new Error(`nothing matches ${selector}`);

    return found;
}

describe('CommandList', () => {
    it('lists live commands, and a command goes when its owner does', async () => {
        const page = open();
        await vi.waitFor(() => expect(find(page, '[data-titles]').textContent).toContain('Reload pages'));
        expect(find(page, '[data-titles]').textContent).not.toContain('Inspect');

        showExtra.set(true);
        await vi.waitFor(() => expect(find(page, '[data-titles]').textContent).toContain('Inspect'));

        showExtra.set(false);
        await vi.waitFor(() => expect(find(page, '[data-titles]').textContent).not.toContain('Inspect'));
    });
});

describe('the step intent', () => {
    it('hears up and down from a text field, and leaves typing alone', async () => {
        const page = open();
        await vi.waitFor(() => find(page, '[data-input]'));
        const input = find(page, '[data-input]');

        await userEvent.click(input);
        await userEvent.keyboard('ab{ArrowDown}{ArrowDown}{ArrowUp}c');

        await vi.waitFor(() => expect(position()).toBe(1));
        expect(root?.querySelector<HTMLInputElement>('[data-input]')?.value).toBe('abc');
    });
});
