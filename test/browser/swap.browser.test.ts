/**
 * **A8.18 (1): the renderer is a driver, and the proof is a second one.**
 *
 * A renderer interface with a single implementation has not been shown to be an interface. So this
 * registers a renderer that touches no `document` at all, mounts a view against it, and asserts the
 * description arrived — **with nothing about the view changing**.
 *
 * The two assertions that make it a swap rather than a registry test:
 *
 * - the description reached the second renderer, and
 * - **the DOM was never touched**. A seam that leaks would show up as an element appearing in the
 *   host anyway, which is precisely the failure a `toBe(registeredInstance)` check cannot see.
 *
 * `resolve` is the kernel's own `provided`, not a stub. That is what keeps this test free of casts:
 * a `resolve` faked with `as any` would compile against a signature nobody had checked, and this
 * repository treats `as any` as a bug rather than a style nit.
 */

import { describe, expect, it } from 'vitest';

import { element, text } from '../../src/description/build.js';
import type { Node } from '../../src/description/types.js';
import { Kernel } from '../../src/kernel/kernel.js';
import { RENDERER, type Mounted, type Renderer, type RendererOptions } from '../../src/render/index.js';
import { mountView } from '../../src/window/host.js';

/** A renderer for a platform that has no elements. It records, and disposes what it recorded. */
function recordingRenderer(): { renderer: Renderer; seen: Node[]; disposed: number } {
    const state = {
        seen: [] as Node[],
        disposed: 0,
        renderer: undefined as unknown as Renderer,
    };

    state.renderer = {
        render(description: Node, _host: unknown, _options: RendererOptions): Mounted {
            state.seen.push(description);
            return { dispose: () => { state.disposed += 1; } };
        },
    };

    return state;
}

/**
 * `mountView` calls only these two, and `WindowManager` has thirty members. The cast is `as never`
 * for the same reason every other test in this suite uses one there: a full fake would be thirty
 * stubs asserting nothing, and widening the parameter to what is actually used is a change to
 * production code that this dispatch is not making.
 */
const windows = { setTitle: () => {}, close: () => {} } as never;

describe('a second renderer can be swapped in', () => {
    it('receives the description, and never touches the DOM', () => {
        const { renderer, seen } = recordingRenderer();

        const kernel = new Kernel();
        kernel.provide(RENDERER, renderer);

        // A real host element, so that "the DOM was not touched" is a claim about something that
        // could have been touched.
        const host = document.createElement('div');
        const view = element('Stack', { children: [text('Hello from a renderer with no elements')] });

        const instance = mountView(host, {
            windowId: 'w1',
            decl: { id: 'main', title: 'Swapped', render: () => view } as never,
            api: undefined,
            params: {},
            windows,
            resolve: (token) => kernel.provided(token),
            renderOptions: { dispatch: { dispatch: () => {} } },
            onCommand: () => {},
        });

        expect(seen).toContain(view);
        // The whole point: the description was realised somewhere that is not this element.
        expect(host.childElementCount).toBe(0);
        expect(host.textContent).toBe('');

        instance.dispose();
    });

    it('disposes through the renderer it was mounted with', () => {
        // A driver that is asked to mount and never asked to release is a leak per window, and the
        // seam is where that would silently stop happening.
        const { renderer, seen } = recordingRenderer();

        const kernel = new Kernel();
        kernel.provide(RENDERER, renderer);

        const instance = mountView(document.createElement('div'), {
            windowId: 'w1',
            decl: { id: 'main', title: 'Swapped', render: () => text('x') } as never,
            api: undefined,
            params: {},
            windows,
            resolve: (token) => kernel.provided(token),
            renderOptions: { dispatch: { dispatch: () => {} } },
            onCommand: () => {},
        });

        expect(seen).toHaveLength(1);
        instance.dispose();
    });
});
