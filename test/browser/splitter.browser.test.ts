/**
 * The Splitter, dragged with a real mouse and pressed with real keys.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import { element, signal, type Node } from '../../src/index.js';
import { App, Component, mountSite, View, type MountedApp } from '../../src/app/index.js';

const size = signal(200);

class Panes extends Component({}) {
    readonly resized = this.on((value) => {
        if (typeof value === 'number') size.set(value);
    });

    render(): Node {
        return element('Row', {
            props: { style: { display: 'flex', width: '800px', height: '200px', position: 'relative' } },
            children: [
                element('Stack', { props: { 'data-pane': 'left', style: () => ({ width: `${size()}px`, flex: 'none' }) } }),
                element('Splitter', {
                    props: { 'aria-label': 'Resize', value: () => size(), min: 100, max: 500, style: { width: '10px', background: 'gray' } },
                    intents: { resize: { action: this.resized } },
                }),
                element('Stack', { props: { 'data-pane': 'right', style: { flex: '1' } } }),
                element('Stack', { props: { 'data-target': 'far', style: { position: 'absolute', left: '700px', top: '0', width: '10px', height: '10px' } } }),
                element('Stack', { props: { 'data-target': 'near', style: { position: 'absolute', left: '20px', top: '0', width: '10px', height: '10px' } } }),
                element('Stack', { props: { 'data-target': 'mid', style: { position: 'absolute', left: '305px', top: '0', width: '10px', height: '10px' } } }),
            ],
        });
    }
}

class PanesView extends View({}) {
    render(): Node {
        return this.mount(Panes);
    }
}

class PanesApp extends App({ routes: { '/': PanesView } }) {}

let site: MountedApp | undefined;
let root: HTMLElement | undefined;
const original = `${location.pathname}${location.search}`;

function open(): HTMLElement {
    size.set(200);
    history.pushState(null, '', '/');
    root = document.createElement('div');
    document.body.appendChild(root);
    site = mountSite(PanesApp, { root });

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

describe('Splitter', () => {
    it('says what it is to assistive technology', async () => {
        const page = open();
        await vi.waitFor(() => find(page, '[data-mesh-splitter]'));
        const splitter = find(page, '[data-mesh-splitter]');

        expect(splitter.getAttribute('role')).toBe('separator');
        expect(splitter.getAttribute('aria-valuenow')).toBe('200');
        expect(splitter.getAttribute('aria-valuemin')).toBe('100');
        expect(splitter.getAttribute('aria-valuemax')).toBe('500');
    });

    it('follows a real drag', async () => {
        const page = open();
        await vi.waitFor(() => find(page, '[data-mesh-splitter]'));
        const splitter = find(page, '[data-mesh-splitter]');

        await userEvent.dragAndDrop(splitter, find(page, '[data-target="mid"]'));

        await vi.waitFor(() => expect(size()).toBeGreaterThan(290));
        expect(size()).toBeLessThan(320);
        expect(find(page, '[data-pane="left"]').getBoundingClientRect().width).toBe(size());
        expect(splitter.hasAttribute('data-mesh-dragging')).toBe(false);
    });

    it('stops at max and at min', async () => {
        const page = open();
        await vi.waitFor(() => find(page, '[data-mesh-splitter]'));
        const splitter = find(page, '[data-mesh-splitter]');

        await userEvent.dragAndDrop(splitter, find(page, '[data-target="far"]'));
        await vi.waitFor(() => expect(size()).toBe(500));

        await userEvent.dragAndDrop(splitter, find(page, '[data-target="near"]'));
        await vi.waitFor(() => expect(size()).toBe(100));
    });

    it('moves by arrow keys, further with shift, and jumps with home and end', async () => {
        const page = open();
        await vi.waitFor(() => find(page, '[data-mesh-splitter]'));
        find(page, '[data-mesh-splitter]').focus();

        await userEvent.keyboard('{ArrowRight}');
        await vi.waitFor(() => expect(size()).toBe(210));

        await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
        await vi.waitFor(() => expect(size()).toBe(190));

        await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
        await vi.waitFor(() => expect(size()).toBe(240));

        await userEvent.keyboard('{End}');
        await vi.waitFor(() => expect(size()).toBe(500));

        await userEvent.keyboard('{Home}');
        await vi.waitFor(() => expect(size()).toBe(100));
    });
});
