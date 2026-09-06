/**
 * @vitest-environment jsdom
 *
 * Roadmap A7.5 — the `dom` capability and Surface escape hatch.
 *
 * An escape hatch that lets a contribution opt out of isolation (spec/view-layer.md §8).
 * Accessible only via `needs('dom')`, NOT a global primitive in PRIMITIVES.
 * Calls setup(el: HTMLElement) on mount, teardown() on unmount, and survives SSR
 * via flatten() as an explicit placeholder without executing setup().
 */

import { describe, expect, it, vi } from 'vitest';
import {
    createContext,
    createRegistry,
    createServices,
    element,
    flatten,
    flushSync,
    needs,
    PRIMITIVES,
    render,
    signal,
    when,
    type Context,
} from '../src/index.js';

describe('Surface (A7.5)', () => {
    it('is NOT registered in PRIMITIVES', () => {
        const registry = createRegistry(PRIMITIVES);
        expect(registry.get('Surface')).toBeUndefined();
        expect(registry.names).not.toContain('Surface');

        const host = document.createElement('div');
        expect(() => {
            render(element('Surface'), host, {
                components: registry,
                dispatch: { dispatch() {} },
            });
        }).toThrow(/Unknown component "Surface"/);
    });

    it('is inaccessible to a contribution that did not declare needs("dom")', () => {
        const services = createServices();
        const handle = createContext(
            { id: 'app-no-dom', declaredBy: 'app-no-dom' },
            needs('state', 'log'),
            [],
            () => undefined,
            services,
        );

        expect('dom' in handle.context).toBe(false);
        handle.dispose();
    });

    it('is accessible when needs("dom") is declared', () => {
        const services = createServices();
        const DOM_NEEDS = needs('dom');
        const handle = createContext(
            { id: 'app-with-dom', declaredBy: 'app-with-dom' },
            DOM_NEEDS,
            [],
            () => undefined,
            services,
        );

        const cx = handle.context as Context<typeof DOM_NEEDS>;
        expect(cx.dom).toBeDefined();
        expect(typeof cx.dom.Surface).toBe('function');
        expect(typeof cx.dom.surface).toBe('function');

        handle.dispose();
    });

    it('flatten handles Surface for SSR without calling setup', () => {
        const services = createServices();
        const DOM_NEEDS = needs('dom');
        const handle = createContext(
            { id: 'app-ssr', declaredBy: 'app-ssr' },
            DOM_NEEDS,
            [],
            () => undefined,
            services,
        );
        const cx = handle.context as Context<typeof DOM_NEEDS>;

        const setupFn = vi.fn();
        const node = cx.dom.Surface({
            setup: setupFn,
            class: 'chart-canvas',
            style: { width: '400px' },
        });

        const flat = flatten(node);
        expect(setupFn).not.toHaveBeenCalled();

        expect(flat).toEqual([
            {
                kind: 'element',
                component: 'Surface',
                props: {
                    'data-mesh-surface': 'placeholder',
                    class: 'chart-canvas',
                    style: { width: '400px' },
                },
                children: [],
            },
        ]);

        handle.dispose();
    });

    it('calls setup(el) with HTMLElement and calls teardown on unmount', () => {
        const services = createServices();
        const DOM_NEEDS = needs('dom');
        const handle = createContext(
            { id: 'app-lifecycle', declaredBy: 'app-lifecycle' },
            DOM_NEEDS,
            [],
            () => undefined,
            services,
        );
        const cx = handle.context as Context<typeof DOM_NEEDS>;

        const teardown = vi.fn();
        let receivedEl: HTMLElement | undefined;

        const setup = vi.fn((el: HTMLElement) => {
            receivedEl = el;
            return teardown;
        });

        const node = cx.dom.Surface({
            setup,
            class: 'monaco-mount',
        });

        const host = document.createElement('div');
        const registry = createRegistry(PRIMITIVES);
        const mounted = render(node, host, {
            components: registry,
            dispatch: { dispatch() {} },
        });

        expect(setup).toHaveBeenCalledTimes(1);
        expect(receivedEl).toBeInstanceOf(HTMLElement);
        expect(receivedEl?.getAttribute('data-mesh-surface')).toBe('');
        expect(receivedEl?.className).toBe('monaco-mount');
        expect(teardown).not.toHaveBeenCalled();

        mounted.dispose();
        expect(teardown).toHaveBeenCalledTimes(1);

        handle.dispose();
    });

    it('calls teardown when unmounted by a reactive when branch flip', () => {
        const services = createServices();
        const DOM_NEEDS = needs('dom');
        const handle = createContext(
            { id: 'app-when', declaredBy: 'app-when' },
            DOM_NEEDS,
            [],
            () => undefined,
            services,
        );
        const cx = handle.context as Context<typeof DOM_NEEDS>;

        const shown = signal(true);
        const teardown = vi.fn();
        const setup = vi.fn(() => teardown);

        const node = when(
            () => shown(),
            () => cx.dom.Surface({ setup }),
        );

        const host = document.createElement('div');
        const registry = createRegistry(PRIMITIVES);
        const mounted = render(node, host, {
            components: registry,
            dispatch: { dispatch() {} },
        });

        expect(setup).toHaveBeenCalledTimes(1);
        expect(teardown).not.toHaveBeenCalled();

        shown.set(false);
        flushSync();
        expect(teardown).toHaveBeenCalledTimes(1);

        mounted.dispose();
        handle.dispose();
    });

    it('calls teardown if context is disposed before unmount', () => {
        const services = createServices();
        const DOM_NEEDS = needs('dom');
        const handle = createContext(
            { id: 'app-ctx-dispose', declaredBy: 'app-ctx-dispose' },
            DOM_NEEDS,
            [],
            () => undefined,
            services,
        );
        const cx = handle.context as Context<typeof DOM_NEEDS>;

        const teardown = vi.fn();
        const setup = vi.fn(() => teardown);

        const node = cx.dom.Surface({ setup });
        const host = document.createElement('div');
        const registry = createRegistry(PRIMITIVES);
        render(node, host, {
            components: registry,
            dispatch: { dispatch() {} },
        });

        expect(setup).toHaveBeenCalledTimes(1);
        expect(teardown).not.toHaveBeenCalled();

        handle.dispose();
        expect(teardown).toHaveBeenCalledTimes(1);
    });
});
