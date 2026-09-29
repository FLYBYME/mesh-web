/**
 * Phase 5b (docs/app-model.md): an App's routes as windows. Same App, same views as the single-page
 * site; navigating opens or focuses a window, and a key reaches only the window in front.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import { z } from 'zod';
import '../../src/kernel.css';
import { App, command, element, Link, mountDesktop, Router, signal, text, View, type MountedDesktop, type Node } from '../../src/index.js';

class HomeView extends View({ inject: { router: Router }, title: 'Home' }) {
    render(): Node {
        const { router } = this.inject;
        return element('Stack', {
            props: { 'data-home': '' },
            children: [
                this.mount(Link, { href: router.href(NoteView, { id: 'one' }), children: [text('open one')] }),
                this.mount(Link, { href: router.href(NoteView, { id: 'two' }), children: [text('open two')] }),
            ],
        });
    }
}

class NoteView extends View({ params: z.object({ id: z.string() }), title: 'Note' }) {
    readonly count = signal(0);
    readonly bump = command({ title: 'Bump', key: 'alt+k', run: () => this.count.set(this.count() + 1) });
    render(): Node {
        return element('Text', { props: { 'data-note': this.params.id }, children: [text(() => `${this.params.id}=${this.count()}`)] });
    }
}

class Notes extends App({ routes: { '/': HomeView, '/notes/:id': NoteView } }) {}

let root: HTMLElement;
let desk: MountedDesktop | undefined;
let original = '';

beforeEach(() => {
    original = `${location.pathname}${location.search}`;
    history.replaceState(null, '', '/');
    root = document.createElement('div');
    root.style.cssText = 'position:relative;width:1000px;height:700px';
    document.body.appendChild(root);
});

afterEach(() => {
    desk?.dispose();
    desk = undefined;
    root.remove();
    history.replaceState(null, '', original);
});

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
const note = (id: string): string | null => root.querySelector(`[data-note="${id}"]`)?.textContent ?? null;
const link = (label: string): HTMLAnchorElement => {
    const a = [...root.querySelectorAll('a')].find((x) => x.textContent === label);
    if (a === undefined) throw new Error(`no link "${label}"`);
    return a;
};
const windowFor = (id: string): string => {
    const found = desk?.manager.stacked().find((r) => r.params['id'] === id);
    if (found === undefined) throw new Error(`no window for note ${id}`);
    return found.id;
};

describe('an App as a desktop', () => {
    it('opens a window per route, and focuses the one already showing a route instead of opening another', async () => {
        desk = mountDesktop(Notes, { root });
        await frame();
        expect(desk.manager.stacked()).toHaveLength(1);
        expect(root.querySelector('[data-home]')).not.toBeNull();

        await userEvent.click(link('open one'));
        await frame();
        expect(desk.manager.stacked()).toHaveLength(2);
        expect(desk.route()?.raw).toEqual({ id: 'one' });
        expect(location.pathname).toBe('/notes/one');

        desk.manager.focus(desk.manager.stacked()[0]!.id); // back to Home
        await frame();
        await userEvent.click(link('open two'));
        await frame();
        expect(desk.manager.stacked()).toHaveLength(3);

        desk.navigate('/notes/one');
        await frame();
        expect(desk.manager.stacked()).toHaveLength(3);
        expect(desk.manager.focused()).toBe(windowFor('one'));
    });

    it('sends a key to the window in front and to no other', async () => {
        history.replaceState(null, '', '/notes/one');
        desk = mountDesktop(Notes, { root });
        desk.navigate('/notes/two');
        await frame();
        expect(desk.manager.focused()).toBe(windowFor('two'));

        await userEvent.keyboard('{Alt>}k{/Alt}');
        await frame();
        expect(note('two')).toBe('two=1');
        expect(note('one')).toBe('one=0');

        desk.manager.focus(windowFor('one'));
        await frame();
        await userEvent.keyboard('{Alt>}k{/Alt}');
        await userEvent.keyboard('{Alt>}k{/Alt}');
        await frame();
        expect(note('one')).toBe('one=2');
        expect(note('two')).toBe('two=1');
    });

    it('takes a window\'s commands with it when it closes', async () => {
        history.replaceState(null, '', '/notes/one');
        desk = mountDesktop(Notes, { root });
        desk.navigate('/notes/two');
        await frame();

        const bumps = (): number => desk!.runtime.commands.live().filter((l) => l.command.title === 'Bump').length;
        expect(bumps()).toBe(2);

        desk.manager.close(windowFor('two'));
        await frame();
        expect(bumps()).toBe(1);
        expect(note('two')).toBeNull();

        // Reopening it is a new instance.
        desk.navigate('/notes/two');
        await frame();
        expect(note('two')).toBe('two=0');
    });
});
