/**
 * @vitest-environment jsdom
 *
 * jsdom, not a browser — deliberately, and with a stated limit.
 *
 * spec/testing.md section 4 says the renderer needs a real browser. That is true of layout, focus,
 * input devices and anything measured. It is not true of what this file tests: reconciliation,
 * binding, disposal and the intent mapping, which are logic that happens to touch a DOM. Those are
 * cheap to test here and expensive to test in a browser, so they are tested here — and the browser
 * tests, when they exist, cover what jsdom cannot rather than repeating this.
 *
 * Note `tick()`. Effects are flushed on a microtask, so several writes in one turn produce one DOM
 * update rather than one each. That is the right default for a renderer — it is what stops a loop of
 * ten `set` calls causing ten layouts — and it means a test that writes and then reads synchronously
 * has to say so.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { effect, flushSync, signal } from '../src/reactivity/index.js';
import { command, each, element, empty, text, when, createHandlerTable } from '../src/description/index.js';
import type { Action } from '../src/description/index.js';
import { createRegistry, PRIMITIVES, render, type Dispatcher } from '../src/render/index.js';
import { mountView } from '../src/window/host.js';

/** Let batched effects run. See the note above. */
const tick = (): void => flushSync();

function setup() {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const seen: Action[] = [];
    const dispatch: Dispatcher = { dispatch: (action) => void seen.push(action) };

    return {
        host,
        seen,
        components: createRegistry(PRIMITIVES),
        dispatch,
        html: () => host.innerHTML.replace(/<!--.*?-->/g, ''),
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
});

describe('components become elements, and only here', () => {
    it('maps a component name to a tag', () => {
        const { host, components, dispatch, html } = setup();
        render(element('Heading', { children: [text('A blog')] }), host, { components, dispatch });
        expect(html()).toBe('<h2>A blog</h2>');
    });

    it('refuses an unknown component, and says what it knows', () => {
        const { host, components, dispatch } = setup();
        expect(() => render(element('Nope', {}), host, { components, dispatch }))
            .toThrow(/Unknown component "Nope".*Known: Badge, Button/s);
    });

    it('refuses two contributors claiming one name', () => {
        const registry = createRegistry(PRIMITIVES);
        expect(() => registry.register({ name: 'Button', create: () => document.createElement('a') }))
            .toThrow(/already registered/);
    });
});

describe('fine-grained updates: one signal, one node', () => {
    it('updates a text node without rebuilding its parent', () => {
        const { host, components, dispatch } = setup();
        const name = signal('world');

        render(
            element('Stack', { children: [element('Text', { children: [text(() => `hello ${name()}`)] })] }),
            host,
            { components, dispatch },
        );

        const span = host.querySelector('span')!;
        const textNode = span.firstChild;
        expect(span.textContent).toBe('hello world');

        name.set('deck');
        tick();

        expect(span.textContent).toBe('hello deck');
        // The identity checks are the actual claim: nothing was recreated.
        expect(host.querySelector('span')).toBe(span);
        expect(span.firstChild).toBe(textNode);
    });

    it('updates one attribute without touching the element', () => {
        const { host, components, dispatch } = setup();
        const disabled = signal(true);

        render(element('Button', { props: { disabled: () => disabled() } }), host, { components, dispatch });

        const button = host.querySelector('button')!;
        expect(button.hasAttribute('disabled')).toBe(true);

        disabled.set(false);
        tick();

        expect(button.hasAttribute('disabled')).toBe(false);
        expect(host.querySelector('button')).toBe(button);
    });

    it('batches several writes into one update', () => {
        const { host, components, dispatch } = setup();
        const count = signal(0);
        const renders = vi.fn(() => String(count()));

        render(element('Text', { children: [text(renders)] }), host, { components, dispatch });
        expect(renders).toHaveBeenCalledTimes(1);

        count.set(1);
        count.set(2);
        count.set(3);
        tick();

        expect(host.textContent).toBe('3');
        expect(renders).toHaveBeenCalledTimes(2); // the initial build, then one flush
    });

    it('lets a component claim a prop', () => {
        const { host, components, dispatch } = setup();
        render(element('Stack', { props: { gap: 8 } }), host, { components, dispatch });

        const div = host.querySelector('div') as HTMLElement;
        expect(div.style.gap).toBe('8px');
        expect(div.hasAttribute('gap')).toBe(false);
    });
});

describe('when', () => {
    it('swaps branches and introduces no wrapper element', () => {
        const { host, components, dispatch, html } = setup();
        const signedIn = signal(false);

        render(
            element('Row', {
                children: [when(() => signedIn(), () => text('in'), () => text('out'))],
            }),
            host,
            { components, dispatch },
        );

        expect(html()).toBe('<div>out</div>');

        signedIn.set(true);
        tick();
        expect(html()).toBe('<div>in</div>');

        signedIn.set(false);
        tick();
        expect(html()).toBe('<div>out</div>');
    });

    it('renders nothing with no otherwise', () => {
        const { host, components, dispatch, html } = setup();
        render(element('Row', { children: [when(false, () => text('x'))] }), host, { components, dispatch });
        expect(html()).toBe('<div></div>');
    });

    it('disposes the effects of a branch it removed', () => {
        const { host, components, dispatch } = setup();
        const show = signal(true);
        const value = signal(0);
        const reads = vi.fn(() => String(value()));

        render(element('Row', { children: [when(() => show(), () => text(reads))] }), host, { components, dispatch });
        expect(reads).toHaveBeenCalledTimes(1);

        show.set(false);
        tick();
        const callsAfterRemoval = reads.mock.calls.length;

        // The branch is gone; its effect must not still be subscribed.
        value.set(1);
        value.set(2);
        tick();
        expect(reads).toHaveBeenCalledTimes(callsAfterRemoval);
    });
});

describe('each is keyed, so a reorder moves nodes instead of rebuilding them', () => {
    const post = (slug: string, title: string) => ({ slug, title });

    const list = (posts: () => readonly { slug: string; title: string }[]) =>
        element('List', {
            children: [
                each(posts, (p) => p.slug, (p) => element('ListItem', { children: [text(() => p().title)] })),
            ],
        });

    it('renders a list', () => {
        const { host, components, dispatch, html } = setup();
        const posts = signal([post('a', 'First'), post('b', 'Second')]);

        render(list(() => posts()), host, { components, dispatch });
        expect(html()).toBe('<ul><li>First</li><li>Second</li></ul>');
    });

    it('keeps the same element across a reorder', () => {
        const { host, components, dispatch } = setup();
        const posts = signal([post('a', 'First'), post('b', 'Second')]);

        render(list(() => posts()), host, { components, dispatch });

        const before = [...host.querySelectorAll('li')];
        posts.set([post('b', 'Second'), post('a', 'First')]);
        tick();
        const after = [...host.querySelectorAll('li')];

        expect(after.map((li) => li.textContent)).toEqual(['Second', 'First']);
        // This is the whole reason keys are required: the nodes are the same objects, reordered.
        expect(after[0]).toBe(before[1]);
        expect(after[1]).toBe(before[0]);
    });

    it('adds and removes without disturbing what stayed', () => {
        const { host, components, dispatch } = setup();
        const posts = signal([post('a', 'First'), post('b', 'Second')]);

        render(list(() => posts()), host, { components, dispatch });

        const first = host.querySelector('li')!;
        posts.set([post('a', 'First'), post('c', 'Third')]);
        tick();

        const items = [...host.querySelectorAll('li')];
        expect(items.map((li) => li.textContent)).toEqual(['First', 'Third']);
        expect(items[0]).toBe(first);
    });

    it('empties', () => {
        const { host, components, dispatch, html } = setup();
        const posts = signal([post('a', 'First')]);

        render(list(() => posts()), host, { components, dispatch });

        posts.set([]);
        tick();
        expect(html()).toBe('<ul></ul>');
    });

    it('updates a row whose key stayed the same but whose contents changed', () => {
        // The case the other list tests structurally cannot reach. They add, remove and reorder,
        // where a row is either created fresh or destroyed — so a row that is *kept* while its data
        // changes is never exercised, and two real bugs hid there:
        //
        //   1. `render` received the item by value, so a reused row closed over stale data.
        //   2. Rows were built inside the reconciling effect, which disposes the effects it created
        //      before it re-runs — so every row went dead after the first list change.
        //
        // Both are invisible unless a row's content is reactive *and* its key survives.
        const { host, components, dispatch } = setup();
        const posts = signal([
            { slug: 'a', title: 'First', published: true },
            { slug: 'b', title: 'Second', published: false },
        ]);

        render(
            element('List', {
                children: [
                    each(
                        () => posts(),
                        (p) => p.slug,
                        (p) =>
                            element('ListItem', {
                                children: [
                                    text(() => p().title),
                                    when(() => !p().published, () => text(' — draft')),
                                ],
                            }),
                    ),
                ],
            }),
            host,
            { components, dispatch },
        );

        const rows = [...host.querySelectorAll('li')];
        expect(host.textContent).toBe('FirstSecond — draft');

        posts.set(posts().map((p) => (p.slug === 'b' ? { ...p, published: true, title: 'Renamed' } : p)));
        tick();

        expect(host.textContent).toBe('FirstRenamed');
        // Still the same element: updated in place, not replaced.
        expect([...host.querySelectorAll('li')][1]).toBe(rows[1]);

        // And it keeps working, which is what proves the row's effects were not disposed.
        posts.set(posts().map((p) => (p.slug === 'b' ? { ...p, published: false } : p)));
        tick();
        expect(host.textContent).toBe('FirstRenamed — draft');
    });

    it('rejects a duplicate key', () => {
        const { host, components, dispatch } = setup();
        expect(() =>
            render(
                each([{ id: 1 }, { id: 1 }], (i) => i.id, () => text('x')),
                host,
                { components, dispatch },
            ),
        ).toThrow(/duplicate key 1 at index 1/);
    });
});

describe('intents, not device events', () => {
    it('a click and Enter both mean activate', () => {
        const { host, components, dispatch, seen } = setup();

        render(
            element('Button', { intents: { activate: { action: command('blog.newPost') } } }),
            host,
            { components, dispatch },
        );

        const button = host.querySelector('button')!;
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

        expect(seen).toEqual([
            { kind: 'command', id: 'blog.newPost' },
            { kind: 'command', id: 'blog.newPost' },
        ]);
    });

    it('a handler action routes back to the function that stayed on the app side', () => {
        const { host, components, dispatch, seen } = setup();
        const handlers = createHandlerTable('view-1');
        const calls: string[] = [];
        const action = handlers.on(() => calls.push('toggled'));

        render(element('Button', { intents: { activate: { action } } }), host, { components, dispatch });
        host.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(seen).toHaveLength(1);
        expect(seen[0]!.kind).toBe('handler');

        // The renderer never called the function; it dispatched an id. Something else resolves it.
        expect(calls).toEqual([]);
        handlers.invoke((seen[0] as { id: string }).id);
        expect(calls).toEqual(['toggled']);
    });

    it('preventDefault is honoured from the declaration', () => {
        const { host, components, dispatch } = setup();

        render(
            element('Form', { intents: { commit: { action: command('blog.save'), preventDefault: true } } }),
            host,
            { components, dispatch },
        );

        const event = new Event('submit', { bubbles: true, cancelable: true });
        host.querySelector('form')!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });

    it('does not listen for intents that were not declared', () => {
        const { host, components, dispatch, seen } = setup();
        render(element('Button', { intents: { activate: { action: command('x') } } }), host, { components, dispatch });

        host.querySelector('button')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
        expect(seen).toHaveLength(0);
    });
});

describe('disposal', () => {
    it('removes every node and stops every effect', () => {
        const { host, components, dispatch } = setup();
        const name = signal('a');
        const reads = vi.fn(() => name());

        const mounted = render(element('Text', { children: [text(reads)] }), host, { components, dispatch });
        expect(host.childNodes.length).toBeGreaterThan(0);

        mounted.dispose();

        expect(host.innerHTML).toBe('');
        const before = reads.mock.calls.length;
        name.set('b');
        tick();
        expect(reads).toHaveBeenCalledTimes(before);
    });

    it('disposes list rows too', () => {
        const { host, components, dispatch } = setup();
        const items = signal([{ id: 'a' }]);
        const label = signal('x');
        const reads = vi.fn(() => label());

        const mounted = render(
            each(() => items(), (i) => i.id, () => element('Text', { children: [text(reads)] })),
            host,
            { components, dispatch },
        );

        mounted.dispose();
        const before = reads.mock.calls.length;
        label.set('y');
        tick();
        expect(reads).toHaveBeenCalledTimes(before);
    });
});

describe('the same description renders both ways', () => {
    it('empty renders nothing anywhere', () => {
        const { host, components, dispatch, html } = setup();
        render(element('Row', { children: [empty()] }), host, { components, dispatch });
        expect(html()).toBe('<div></div>');
    });
});

/**
 * The ownership bug a real user found, held down by a test.
 *
 * Reported as "when I click new post I only see it after I open a second window". The second window
 * was a fresh mount reading current state; the first had been disposed by the very effect that
 * created it — a shell paints its windows from an effect, so `mountView` is called from inside one,
 * and an effect disposes the scopes created during its last run before running again.
 *
 * Nothing in the 95 unit tests could see it, because every one of them mounted from the top level.
 * It only appears when something *else* re-runs.
 */
describe('a view mounted inside an effect is not owned by that effect', () => {
    it("keeps updating after the effect that mounted it re-runs", () => {
        const { host, components, dispatch } = setup();

        const posts = signal<readonly string[]>(['first']);
        const focused = signal('w1');
        const mounted: { dispose(): void }[] = [];

        // The shell: an effect that repaints on any window change and mounts the view while it does.
        effect(() => {
            focused();                       // the shell reads window state, as a shell does
            if (mounted.length > 0) return;  // mount once, like a real shell keyed by window id

            mounted.push(mountView(host, {
                windowId: 'w1',
                decl: {
                    id: 'main',
                    title: 'Posts',
                    render: () => element('List', {
                        children: [each(() => posts(), (p: string) => p, (p: () => string) =>
                            element('ListItem', { children: [text(() => p())] }))],
                    }),
                } as never,
                api: undefined,
                params: {},
                windows: { setTitle: () => {}, close: () => {} } as never,
                render: { components, dispatch },
                onCommand: () => {},
            }));
        });

        tick();
        expect(host.querySelectorAll('li')).toHaveLength(1);

        // A focus change. Enough on its own to re-run the shell's effect — and, before the fix, to
        // dispose the view it had mounted.
        focused.set('w2');
        tick();

        posts.set(['first', 'second']);
        tick();

        expect(host.querySelectorAll('li')).toHaveLength(2);
        expect(host.textContent).toBe('firstsecond');

        // And the caller is still the owner: disposing really disposes.
        mounted[0]!.dispose();
        posts.set(['first', 'second', 'third']);
        tick();
        expect(host.querySelectorAll('li')).toHaveLength(0);
    });
});
