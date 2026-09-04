/**
 * The `chrome` capability — roadmap A6.3, spec/extension.md §8.
 *
 * A6.3 is the load-bearing test of the whole design: *if the IDE shell cannot be written as an
 * ordinary Extension over the window manager, the capability split is wrong, and it is much better
 * to learn that from writing the workbench than from the first outside author.* This is where that
 * was learned. `windows` gives a contribution `open()` and `own()`, so a workbench could see its own
 * windows and nobody else's — and tabs for every window is the entire job.
 *
 * Everything below runs against the **real** `WindowManager` through the real `windowSink`, because
 * the claim being tested is about where mechanics live, and a recording sink has no geometry to be
 * right or wrong about.
 */

import { describe, expect, it } from 'vitest';

import { createContext, createServices, type KernelServices } from '../src/kernel/broker.js';
import { needs } from '../src/contribution/capabilities.js';
import type { Chrome, Windows } from '../src/contribution/capabilities.js';
import { WindowManager } from '../src/window/manager.js';
import { windowSink } from '../src/window/sink.js';
import type { ViewDecl } from '../src/contribution/contract.js';

// ---------------------------------------------------------------------------- a desktop

const view = (id: string, over: Partial<ViewDecl<never, never>> = {}): ViewDecl<never, never> => ({
    id,
    title: id,
    instances: 'one',
    render: () => ({ kind: 'text', value: id } as never),
    ...over,
} as ViewDecl<never, never>);

const VIEWS: Record<string, ViewDecl<never, never>> = {
    'blog:editor': view('editor'),
    'blog:preview': view('preview'),
    'mail:inbox': view('inbox'),
    // A view that says it may not be closed. Chrome renders no close affordance for it, and the
    // point of the test below is that saying so is not what stops chrome closing it.
    'system:status': view('status', { closable: false }),
};

function desktop(): { services: KernelServices; manager: WindowManager } {
    const manager = new WindowManager({ width: 1280, height: 800 });
    const services = createServices(
        windowSink(manager, (owner, viewId) => VIEWS[`${owner}:${viewId}`]),
    );
    return { services, manager };
}

const CHROME_NEEDS = needs('chrome');
const APP_NEEDS = needs('windows');

const contextFor = (
    services: KernelServices,
    id: string,
    declared: readonly ('chrome' | 'windows')[],
): Record<string, unknown> => createContext(
    { id, declaredBy: id },
    declared,
    [],
    () => undefined,
    services,
).context as unknown as Record<string, unknown>;

const chromeOf = (services: KernelServices): Chrome =>
    contextFor(services, 'workbench', CHROME_NEEDS)['chrome'] as Chrome;

const windowsOf = (services: KernelServices, owner: string): Windows =>
    contextFor(services, owner, APP_NEEDS)['windows'] as Windows;

// ---------------------------------------------------------------------------- the finding

describe('what an Application can see, and what chrome can', () => {
    it('shows an Application only its own windows', () => {
        const { services } = desktop();

        windowsOf(services, 'blog').open({ view: 'editor' });
        windowsOf(services, 'mail').open({ view: 'inbox' });

        expect(windowsOf(services, 'blog').own()).toHaveLength(1);
        expect(windowsOf(services, 'mail').own()).toHaveLength(1);
    });

    it('shows chrome every window, whoever opened it', () => {
        const { services } = desktop();

        windowsOf(services, 'blog').open({ view: 'editor' });
        windowsOf(services, 'blog').open({ view: 'preview' });
        windowsOf(services, 'mail').open({ view: 'inbox' });

        const windows = chromeOf(services).windows();

        expect(windows).toHaveLength(3);
        // The owner travels with the window, because a tab has to say whose it is. This is the whole
        // reason `chrome` cannot be `windows` with a wider filter: it is not the same question.
        expect(windows.map((w) => w.owner).sort()).toEqual(['blog', 'blog', 'mail']);
        expect(windows.map((w) => w.title).sort()).toEqual(['editor', 'inbox', 'preview']);
    });

    it('gives an Application no way to reach chrome', () => {
        const { services } = desktop();

        // Absent, not present-and-throwing. The compile error is the real defence; this is the
        // run-time half of the same statement.
        expect(contextFor(services, 'blog', APP_NEEDS)['chrome']).toBeUndefined();
    });
});

describe('chrome asks; the kernel decides', () => {
    it('reports a drag and lets the manager clamp it', () => {
        const { services, manager } = desktop();
        const id = windowsOf(services, 'blog').open({ view: 'editor' }).id;
        const chrome = chromeOf(services);

        // Far past the left edge. Chrome does not know the viewport and must not: it reports what
        // the pointer did, and the kernel is what stops a window leaving the screen.
        chrome.move(id, -100_000, -100_000);

        const after = manager.get(id)!;
        expect(after.rect.x).toBeGreaterThan(-100_000);
        expect(after.rect.y).toBeGreaterThan(-100_000);
    });

    it('will not resize a window below the minimum its view declared', () => {
        const { services, manager } = desktop();
        const id = windowsOf(services, 'blog').open({ view: 'editor' }).id;
        const before = manager.get(id)!.minSize;

        chromeOf(services).resize(id, 'se', -100_000, -100_000);

        const after = manager.get(id)!.rect;
        expect(after.width).toBeGreaterThanOrEqual(before.width);
        expect(after.height).toBeGreaterThanOrEqual(before.height);
    });

    it('focuses and raises through the kernel', () => {
        const { services } = desktop();
        const first = windowsOf(services, 'blog').open({ view: 'editor' }).id;
        const second = windowsOf(services, 'mail').open({ view: 'inbox' }).id;
        const chrome = chromeOf(services);

        expect(chrome.focused()).toBe(second);

        chrome.focus(first);

        expect(chrome.focused()).toBe(first);
        // Bottom to top, so chrome can paint in order and the focused window is last.
        expect(chrome.windows().at(-1)?.id).toBe(first);
    });

    it('switches mode without touching any window', () => {
        const { services } = desktop();
        windowsOf(services, 'blog').open({ view: 'editor' });
        const chrome = chromeOf(services);

        expect(chrome.mode()).toBe('windowed');
        chrome.setMode('tiled');

        expect(chrome.mode()).toBe('tiled');
        // A2.3's claim, from chrome's side: switching mode is a reposition, so the window is the
        // same window and there is nothing to remount.
        expect(chrome.windows()).toHaveLength(1);
    });
});

describe('what chrome may not overrule', () => {
    it('carries closable so chrome can render the right affordance', () => {
        const { services } = desktop();
        windowsOf(services, 'system').open({ view: 'status' });

        expect(chromeOf(services).windows()[0]?.closable).toBe(false);
    });

    it('refuses to close a window the view declared unclosable', () => {
        const { services } = desktop();
        const id = windowsOf(services, 'system').open({ view: 'status' }).id;

        chromeOf(services).close(id);

        // Not merely undrawn. A chrome that could close it by asking would make `closable` a
        // decoration, and the whole point of the mechanics being kernel is that a broken or hostile
        // chrome cannot do what the Application forbade.
        expect(chromeOf(services).windows().map((w) => w.id)).toContain(id);
    });
});
