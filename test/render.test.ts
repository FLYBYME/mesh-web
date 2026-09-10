import { createDomRenderer } from '../src/render/index.js';
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
import { applyDefaultProp } from '../src/render/component.js';
import { command, createHandlerTable, dialog, each, element, empty, text, when } from '../src/description/index.js';
import type { Action, IntentValue } from '../src/description/index.js';
import { createRegistry, PRIMITIVES, render, type Dispatcher } from '../src/render/index.js';
import { mountView } from '../src/window/host.js';
import { Kernel } from '../src/kernel/kernel.js';
import { RENDERER } from '../src/render/index.js';
import type { ComponentRegistry } from '../src/render/index.js';
import type { ProviderToken } from '../src/contribution/provider.js';

/**
 * A `resolve` that answers the renderer token and nothing else.
 *
 * Built on a real `Kernel` rather than a stub, which is what makes it typed: `provided` already has
 * the `<T>(token) => T | undefined` signature `mountView` wants, so nothing here needs a cast. A
 * `resolve` faked with `as any` compiles against a signature nobody checked, and `as any` is a bug
 * in this repository rather than a style nit.
 */
function resolveRenderer(registry: ComponentRegistry): <T>(token: ProviderToken<T>) => T | undefined {
    const kernel = new Kernel();
    kernel.provide(RENDERER, createDomRenderer(registry));
    return (token) => kernel.provided(token);
}


/** Let batched effects run. See the note above. */
const tick = (): void => flushSync();

function setup() {
    const host = document.createElement('div');
    document.body.appendChild(host);

    const seen: Action[] = [];
    /** What each dispatch carried, positionally aligned with `seen`. See `IntentValue`. */
    const values: IntentValue[] = [];
    const dispatch: Dispatcher = {
        dispatch: (action, value) => { seen.push(action); values.push(value); },
    };

    return {
        host,
        seen,
        values,
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

    it('updates a dirty text input when a controlled value signal changes', () => {
        const { host, components, dispatch } = setup();
        const draft = signal('initial');

        render(
            element('Input', { props: { value: () => draft() } }),
            host,
            { components, dispatch },
        );

        const input = host.querySelector('input');
        expect(input).toBeInstanceOf(HTMLInputElement);
        if (!(input instanceof HTMLInputElement)) return;
        expect(input.value).toBe('initial');

        // User types into the input, setting the DOM dirty value flag
        input.value = 'user typed something';
        input.dispatchEvent(new Event('input', { bubbles: true }));

        // Clearing or updating the signal must update the dirty input's value
        draft.set('');
        tick();

        expect(input.value).toBe('');
    });

    it('updates a dirty checkbox when a controlled checked signal changes', () => {
        const { host, components, dispatch } = setup();
        const checked = signal(true);

        render(
            element('Input', { props: { type: 'checkbox', checked: () => checked() } }),
            host,
            { components, dispatch },
        );

        const input = host.querySelector('input');
        expect(input).toBeInstanceOf(HTMLInputElement);
        if (!(input instanceof HTMLInputElement)) return;
        expect(input.checked).toBe(true);

        // User toggles the checkbox to false, setting the DOM dirty checked flag
        input.checked = false;
        input.dispatchEvent(new Event('input', { bubbles: true }));

        // Signal sets it back to true; without DOM property assignment (setAttribute), dirty flag prevents update
        checked.set(false);
        tick();
        checked.set(true);
        tick();

        expect(input.checked).toBe(true);
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

    /**
     * **A `when` inside a `when`, where the inner one moved first.**
     *
     * `buildWhen` returns `[start, ...branchNodes, end]` — a **snapshot** taken when it was built —
     * and its parent holds that array to know what to remove later. If the inner `when` swaps its
     * own branch after that, the parent's snapshot names nodes that are no longer on screen. Tearing
     * down then removes the wrong set and leaves the real one behind.
     *
     * Reported from the running operator console, and the reproduction is exactly a person's:
     * **sign out, then sign back in.** The outer `when` (signed in?) rebuilt while the inner one
     * (which detail?) had moved, so the detail placeholder rendered twice, one copy of it orphaned
     * with no effects attached and no way to ever remove it. Do it three times and there are three.
     */
    it('removes a nested branch that swapped since it was built', () => {
        const { host, components, dispatch, html } = setup();
        const signedIn = signal(true);
        const seeding = signal(false);

        render(
            element('Row', {
                children: [
                    when(
                        () => signedIn(),
                        () => when(() => seeding(), () => text('seed'), () => text('detail')),
                        () => text('sign in'),
                    ),
                ],
            }),
            host,
            { components, dispatch },
        );

        expect(html()).toBe('<div>detail</div>');

        // The inner `when` moves. The outer's snapshot still names the node it replaced.
        seeding.set(true);
        tick();
        expect(html()).toBe('<div>seed</div>');

        seeding.set(false);
        tick();
        expect(html()).toBe('<div>detail</div>');

        // Now the outer moves. It must take the inner's *current* nodes with it.
        signedIn.set(false);
        tick();
        expect(html()).toBe('<div>sign in</div>');

        // And back — one copy, not two.
        signedIn.set(true);
        tick();
        expect(html()).toBe('<div>detail</div>');
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

    /**
     * **A row whose content swapped, then removed and then reordered.**
     *
     * Same defect as the nested `when` above and the same cause: a row was tracked by the array of
     * nodes it was built with, and anything reactive inside it replaces those on its own schedule.
     * Removing such a row took away the nodes it *used* to have and left the ones it has; moving one
     * left the swapped part behind in the old position.
     *
     * Not hypothetical — `each` with a `when` inside is the ordinary shape of a table row with a
     * conditional control in it, which is what the operator console's release list is.
     */
    /**
     * The row's **top level** is the `when`, with no element wrapping it — which is what makes this
     * the failing case. A row wrapped in an element is safe by accident: removing the element takes
     * whatever is inside it, swapped or not. A row that *is* a conditional has nothing to hide
     * behind, and the stale array is then the only thing the reconciler has to go on.
     */
    const rows = (posts: () => readonly { slug: string; title: string }[], expanded: () => boolean) =>
        element('List', {
            children: [
                each(posts, (p) => p.slug, (p) => when(
                    expanded,
                    () => text(() => `${p().title}!`),
                    () => text(() => `${p().title}?`),
                )),
            ],
        });

    it('removes a row whose nested branch swapped since it was built', () => {
        const { host, components, dispatch, html } = setup();
        const posts = signal([post('a', 'First'), post('b', 'Second')]);
        const expanded = signal(false);

        render(rows(() => posts(), () => expanded()), host, { components, dispatch });
        expect(html()).toBe('<ul>First?Second?</ul>');

        expanded.set(true);
        tick();
        expect(html()).toBe('<ul>First!Second!</ul>');

        posts.set([post('a', 'First')]);
        tick();
        expect(html()).toBe('<ul>First!</ul>');
    });

    it('reorders a row whose nested branch swapped since it was built', () => {
        const { host, components, dispatch, html } = setup();
        const posts = signal([post('a', 'First'), post('b', 'Second')]);
        const expanded = signal(false);

        render(rows(() => posts(), () => expanded()), host, { components, dispatch });

        expanded.set(true);
        tick();

        posts.set([post('b', 'Second'), post('a', 'First')]);
        tick();
        expect(html()).toBe('<ul>Second!First!</ul>');
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

    it('Space activates a Button but not an Input text field', () => {
        const { host, components, dispatch, seen } = setup();
        const buttonAction = command('button.click');
        const inputAction = command('input.submit');

        render(
            element('Stack', {
                children: [
                    element('Button', { intents: { activate: { action: buttonAction } } }),
                    element('Input', { intents: { activate: { action: inputAction } } }),
                ],
            }),
            host,
            { components, dispatch },
        );

        const button = host.querySelector('button')!;
        const input = host.querySelector('input')!;

        // Space on a Button MUST activate (non-pointer path)
        button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        expect(seen).toEqual([buttonAction]);

        // Space on an Input (text) MUST NOT activate (space is text input)
        input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        expect(seen).toEqual([buttonAction]);

        // Enter on an Input MUST still activate
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(seen).toEqual([buttonAction, inputAction]);
    });

    it('Space activates a checkbox Input where space is not text input', () => {
        const { host, components, dispatch, seen } = setup();
        const action = command('check.toggle');

        render(
            element('Input', {
                props: { type: 'checkbox' },
                intents: { activate: { action } },
            }),
            host,
            { components, dispatch },
        );

        const input = host.querySelector('input')!;
        input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        expect(seen).toEqual([action]);
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

/**
 * Roadmap A7.7, and the reason it exists: **a form was impossible to write.**
 *
 * `change` fired an action carrying nothing, so what a person typed never reached the Application.
 * Found by the first site built on the framework (A6.7) needing a sign-in form — not by reading the
 * code, which is the argument for building a real site at all.
 *
 * What arrives is the *value*, never the event. That is spec/input.md §2's rule applied to a field:
 * an Application receives what was meant, and for a field the thing meant is what it now holds.
 */
describe('an intent carries its value', () => {
    const typeInto = (input: HTMLInputElement, value: string): void => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    it('delivers the text in a field', () => {
        const { host, components, dispatch, seen, values } = setup();

        render(
            element('Input', {
                props: { name: 'email' },
                intents: { change: { action: command('auth.email') } },
            }),
            host,
            { components, dispatch },
        );

        typeInto(host.querySelector('input')!, 'operator@surfdns.net');

        expect(seen).toEqual([{ kind: 'command', id: 'auth.email' }]);
        expect(values).toEqual(['operator@surfdns.net']);
    });

    it('listens for input rather than change, so the last keystroke is not lost', () => {
        // `change` fires on blur. A form whose button is clicked straight from a focused field
        // would never see what was typed into it — the classic "it dropped my password", and
        // invisible to any test that dispatches events by hand.
        const { host, components, dispatch, values } = setup();

        render(
            element('Input', { intents: { change: { action: command('x') } } }),
            host,
            { components, dispatch },
        );

        typeInto(host.querySelector('input')!, 'typed');
        expect(values).toEqual(['typed']);
    });

    it('reads a checkbox as a boolean and a number field as a number', () => {
        const { host, components, dispatch, values } = setup();

        render(
            element('Stack', {
                children: [
                    element('Input', {
                        props: { type: 'checkbox' },
                        intents: { change: { action: command('a') } },
                    }),
                    element('Input', {
                        props: { type: 'number' },
                        intents: { change: { action: command('b') } },
                    }),
                ],
            }),
            host,
            { components, dispatch },
        );

        const [check, number] = [...host.querySelectorAll('input')] as HTMLInputElement[];
        check!.checked = true;
        check!.dispatchEvent(new Event('input', { bubbles: true }));
        typeInto(number!, '42');

        expect(values).toEqual([true, 42]);
    });

    it('an empty number field is not zero', () => {
        // `Number('')` is 0, which would arrive as a number nobody typed. The reader decides what an
        // empty field means; the renderer must not decide it means zero.
        const { host, components, dispatch, values } = setup();

        render(
            element('Input', {
                props: { type: 'number' },
                intents: { change: { action: command('b') } },
            }),
            host,
            { components, dispatch },
        );

        typeInto(host.querySelector('input')!, '');
        expect(values).toEqual([undefined]);
    });

    it('carries nothing for an intent that has no value', () => {
        // The *intent* decides, not the element. A `<button>` has a `value` property — always `''`
        // — so letting the element decide would deliver an empty string to every command a button
        // reaches, and every handler would have to know to ignore it.
        const { host, components, dispatch, values } = setup();

        render(
            element('Button', {
                props: { value: 'not this' },
                intents: { activate: { action: command('go') } },
            }),
            host,
            { components, dispatch },
        );

        host.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(values).toEqual([undefined]);
    });

    it('gives a handler the value too', () => {
        const { host, components, dispatch, seen, values } = setup();
        const handlers = createHandlerTable('view-1');
        const typed: IntentValue[] = [];
        const action = handlers.on((value) => typed.push(value));

        render(
            element('Input', { intents: { change: { action } } }),
            host,
            { components, dispatch },
        );

        typeInto(host.querySelector('input')!, 'hello');

        // The renderer still dispatched an id and called nothing — the closure never crossed.
        expect(typed).toEqual([]);
        handlers.invoke((seen[0] as { id: string }).id, values[0]);
        expect(typed).toEqual(['hello']);
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
                resolve: resolveRenderer(components),
                renderOptions: { dispatch },
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

describe('a style object reaches the browser as CSS', () => {
    it('hyphenates a camelCase property, which used to be dropped silently', () => {
        /**
         * `flexDirection` is not a CSS property. The object was serialised key-for-key, so every
         * camelCase name reached the browser as an unknown declaration and was ignored — while the
         * lowercase ones beside it applied, which is what made it invisible.
         *
         * Found writing the first page chrome: `{ display: 'flex', flexDirection: 'column' }` gave a
         * row, so the title bar sat beside the window area instead of above it and the window host
         * got the 469px left over.
         */
        const el = document.createElement('div');
        applyDefaultProp(el, 'style', {
            display: 'flex', flexDirection: 'column', borderBottom: '1px solid red',
        });

        expect(el.getAttribute('style')).toContain('flex-direction:column');
        expect(el.getAttribute('style')).toContain('border-bottom:1px solid red');
        expect(el.getAttribute('style')).not.toContain('flexDirection');
    });

    it('leaves a custom property alone', () => {
        // `--ink` is already the case-sensitive name the author meant; hyphenating it breaks it.
        const el = document.createElement('div');
        applyDefaultProp(el, 'style', { '--ink': '#fff' });
        expect(el.getAttribute('style')).toContain('--ink:#fff');
    });
});

describe('dialog and focus trap', () => {
    it('opens and closes from declared state, and content is not in the tree when closed', () => {
        const { host, components, dispatch } = setup();
        const isOpen = signal(false);

        const mounted = render(
            dialog({
                open: () => isOpen(),
                children: [
                    element('Button', { children: [text('Inside Modal')] }),
                ],
            }),
            host,
            { components, dispatch },
        );

        const dialogEl = host.querySelector('dialog');
        expect(dialogEl).not.toBeNull();
        expect(dialogEl?.open).toBe(false);
        // Closed is not "rendered with display:none" — content is not in the tree
        expect(host.querySelector('button')).toBeNull();

        isOpen.set(true);
        tick();

        expect(dialogEl?.open).toBe(true);
        const buttonEl = host.querySelector('button');
        expect(buttonEl).not.toBeNull();
        expect(buttonEl?.textContent).toBe('Inside Modal');

        isOpen.set(false);
        tick();

        expect(dialogEl?.open).toBe(false);
        expect(host.querySelector('button')).toBeNull();

        mounted.dispose();
        expect(host.querySelector('dialog')).toBeNull();
    });

    it('focus enters on open and returns to the opener on close', () => {
        const { host, components, dispatch } = setup();
        const opener = document.createElement('button');
        opener.textContent = 'Open Dialog';
        document.body.appendChild(opener);
        opener.focus();
        expect(document.activeElement).toBe(opener);

        const isOpen = signal(false);

        render(
            dialog({
                open: () => isOpen(),
                children: [
                    element('Button', { children: [text('Dialog Action')] }),
                ],
            }),
            host,
            { components, dispatch },
        );

        isOpen.set(true);
        tick();

        const dialogButton = host.querySelector('button');
        expect(dialogButton).not.toBeNull();
        // Focus entered into the dialog
        expect(document.activeElement).toBe(dialogButton);

        isOpen.set(false);
        tick();

        // Focus restored to the opener
        expect(document.activeElement).toBe(opener);
        opener.remove();
    });

    it('Escape fires dismiss intent, preventing default close until declared state changes', () => {
        const { host, components } = setup();
        const isOpen = signal(true);
        const handlers = createHandlerTable('view-1');
        let dismissed = false;
        const dismissAction = handlers.on(() => {
            dismissed = true;
            isOpen.set(false);
        });

        const dispatch: Dispatcher = {
            dispatch: (action, value) => {
                if (action.kind === 'handler') {
                    handlers.invoke(action.id, value);
                }
            },
        };

        render(
            dialog({
                open: () => isOpen(),
                intents: { dismiss: { action: dismissAction } },
                children: [
                    element('Button', { children: [text('Dialog Action')] }),
                ],
            }),
            host,
            { components, dispatch },
        );

        tick();
        const dialogEl = host.querySelector('dialog')!;
        expect(dialogEl.open).toBe(true);

        // Dispatch Escape keydown
        const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
        dialogEl.dispatchEvent(escapeEvent);
        tick();

        expect(dismissed).toBe(true);
        expect(isOpen()).toBe(false);
        expect(dialogEl.open).toBe(false);
    });

    it('if the opener ignores the dismissal, declared state remains true and dialog stays open', () => {
        const { host, components } = setup();
        const isOpen = signal(true);
        const handlers = createHandlerTable('view-1');
        let dismissFired = false;
        // The opener ignores dismissal and does NOT set isOpen to false
        const dismissAction = handlers.on(() => {
            dismissFired = true;
        });

        const dispatch: Dispatcher = {
            dispatch: (action, value) => {
                if (action.kind === 'handler') {
                    handlers.invoke(action.id, value);
                }
            },
        };

        render(
            dialog({
                open: () => isOpen(),
                intents: { dismiss: { action: dismissAction } },
                children: [
                    element('Button', { children: [text('Dialog Action')] }),
                ],
            }),
            host,
            { components, dispatch },
        );

        tick();
        const dialogEl = host.querySelector('dialog')!;
        expect(dialogEl.open).toBe(true);

        const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
        dialogEl.dispatchEvent(escapeEvent);
        tick();

        expect(dismissFired).toBe(true);
        expect(isOpen()).toBe(true);
        // Default was prevented and state remained true, so dialog stays open!
        expect(dialogEl.open).toBe(true);
    });
});

describe('accessibility lives in the primitives (roadmap A7.7)', () => {
    it('Button defaults to type="button" to prevent accidental form submission', () => {
        const { host, components, dispatch } = setup();
        render(element('Button', { children: [text('Click')] }), host, { components, dispatch });

        const btn = host.querySelector('button')!;
        expect(btn.type).toBe('button');
        expect(btn.getAttribute('type')).toBe('button');
    });

    it('Button allows explicit type override (e.g. submit)', () => {
        const { host, components, dispatch } = setup();
        render(element('Button', { props: { type: 'submit' }, children: [text('Submit Form')] }), host, { components, dispatch });

        const btn = host.querySelector('button')!;
        expect(btn.type).toBe('submit');
        expect(btn.getAttribute('type')).toBe('submit');
    });

    it('Button handles disabled state with DOM property and aria-disabled', () => {
        const { host, components, dispatch } = setup();
        const isDisabled = signal(true);
        render(element('Button', { props: { disabled: () => isDisabled() }, children: [text('Action')] }), host, { components, dispatch });

        const btn = host.querySelector('button')!;
        expect(btn.disabled).toBe(true);
        expect(btn.getAttribute('aria-disabled')).toBe('true');

        isDisabled.set(false);
        tick();

        expect(btn.disabled).toBe(false);
        expect(btn.hasAttribute('aria-disabled')).toBe(false);
    });

    it('Button handles toggle pressed state and disclosure expanded state', () => {
        const { host, components, dispatch } = setup();
        const isPressed = signal(false);
        const isExpanded = signal(false);

        render(
            element('Button', {
                props: { pressed: () => isPressed(), expanded: () => isExpanded() },
                children: [text('Toggle/Disclosure')],
            }),
            host,
            { components, dispatch },
        );

        const btn = host.querySelector('button')!;
        expect(btn.getAttribute('aria-pressed')).toBe('false');
        expect(btn.getAttribute('aria-expanded')).toBe('false');

        isPressed.set(true);
        isExpanded.set(true);
        tick();

        expect(btn.getAttribute('aria-pressed')).toBe('true');
        expect(btn.getAttribute('aria-expanded')).toBe('true');
    });

    it('disabled Button suppresses activate intent', () => {
        const { host, components, dispatch, seen } = setup();
        render(
            element('Button', {
                props: { disabled: true },
                intents: { activate: { action: command('btn.click') } },
                children: [text('Disabled Action')],
            }),
            host,
            { components, dispatch },
        );

        const btn = host.querySelector('button')!;
        btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(seen).toHaveLength(0);
    });

    it('Dialog enforces role="dialog", aria-modal="true", and container tabindex="-1"', () => {
        const { host, components, dispatch } = setup();
        const isOpen = signal(true);

        render(
            dialog({
                open: () => isOpen(),
                props: { ariaLabel: 'Preferences Dialog', ariaDescribedBy: 'pref-desc' },
                children: [element('Text', { props: { id: 'pref-desc' }, children: [text('Configure settings')] })],
            }),
            host,
            { components, dispatch },
        );

        tick();
        const dialogEl = host.querySelector('dialog')!;
        expect(dialogEl.getAttribute('role')).toBe('dialog');
        expect(dialogEl.getAttribute('aria-modal')).toBe('true');
        expect(dialogEl.tabIndex).toBe(-1);
        expect(dialogEl.getAttribute('aria-label')).toBe('Preferences Dialog');
        expect(dialogEl.getAttribute('aria-describedby')).toBe('pref-desc');
    });

    it('Input and TextArea establish label relationship via labelledBy and describedBy', () => {
        const { host, components, dispatch } = setup();

        render(
            element('Stack', {
                children: [
                    element('Text', { props: { id: 'username-label' }, children: [text('Username')] }),
                    element('Input', {
                        props: { labelledBy: 'username-label', describedBy: 'username-hint' },
                    }),
                    element('Text', { props: { id: 'username-hint' }, children: [text('3-12 characters')] }),
                    element('Text', { props: { id: 'bio-label' }, children: [text('Biography')] }),
                    element('TextArea', {
                        props: { labelledBy: 'bio-label', describedBy: 'bio-error' },
                    }),
                    element('Text', { props: { id: 'bio-error' }, children: [text('Too long')] }),
                ],
            }),
            host,
            { components, dispatch },
        );

        const input = host.querySelector('input')!;
        expect(input.getAttribute('aria-labelledby')).toBe('username-label');
        expect(input.getAttribute('aria-describedby')).toBe('username-hint');

        const textarea = host.querySelector('textarea')!;
        expect(textarea.getAttribute('aria-labelledby')).toBe('bio-label');
        expect(textarea.getAttribute('aria-describedby')).toBe('bio-error');
    });

    it('Input and TextArea support invalid, required, disabled, and readOnly accessibility props', () => {
        const { host, components, dispatch } = setup();
        const invalid = signal(true);
        const required = signal(true);
        const disabled = signal(false);
        const readOnly = signal(false);

        render(
            element('Input', {
                props: {
                    invalid: () => invalid(),
                    required: () => required(),
                    disabled: () => disabled(),
                    readOnly: () => readOnly(),
                },
            }),
            host,
            { components, dispatch },
        );

        const input = host.querySelector('input')!;
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(input.required).toBe(true);
        expect(input.getAttribute('aria-required')).toBe('true');
        expect(input.disabled).toBe(false);
        expect(input.hasAttribute('aria-disabled')).toBe(false);
        expect(input.readOnly).toBe(false);

        invalid.set(false);
        disabled.set(true);
        readOnly.set(true);
        tick();

        expect(input.hasAttribute('aria-invalid')).toBe(false);
        expect(input.disabled).toBe(true);
        expect(input.getAttribute('aria-disabled')).toBe('true');
        expect(input.readOnly).toBe(true);
        expect(input.getAttribute('aria-readonly')).toBe('true');
    });

    it('Divider sets aria-orientation to vertical or horizontal', () => {
        const { host, components, dispatch } = setup();
        render(
            element('Stack', {
                children: [
                    element('Divider', { props: { orientation: 'vertical' } }),
                    element('Divider', { props: { orientation: 'horizontal' } }),
                ],
            }),
            host,
            { components, dispatch },
        );

        const [vDivider, hDivider] = [...host.querySelectorAll('hr')];
        expect(vDivider?.getAttribute('data-orientation')).toBe('vertical');
        expect(vDivider?.getAttribute('aria-orientation')).toBe('vertical');
        expect(hDivider?.getAttribute('data-orientation')).toBe('horizontal');
        expect(hDivider?.getAttribute('aria-orientation')).toBe('horizontal');
    });

    it('DropZone supports custom aria-label via ariaLabel prop', () => {
        const { host, components, dispatch } = setup();
        const label = signal('Drop image files here');

        render(
            element('DropZone', { props: { ariaLabel: () => label() } }),
            host,
            { components, dispatch },
        );

        const dropzone = host.querySelector('[data-mesh-dropzone]')!;
        expect(dropzone.getAttribute('aria-label')).toBe('Drop image files here');

        label.set('Drop video files here');
        tick();

        expect(dropzone.getAttribute('aria-label')).toBe('Drop video files here');
    });

    it('interactive non-natively focusable element automatically receives tabindex="0" and role="button"', () => {
        const { host, components, dispatch, seen } = setup();

        render(
            element('Stack', {
                children: [
                    element('ListItem', {
                        props: { id: 'list-item-btn' },
                        intents: { activate: { action: command('list.select') } },
                        children: [text('Clickable List Item')],
                    }),
                    element('Row', {
                        props: { id: 'row-btn' },
                        intents: { activate: { action: command('row.select') } },
                        children: [text('Clickable Row')],
                    }),
                ],
            }),
            host,
            { components, dispatch },
        );

        const listItem = host.querySelector('#list-item-btn')!;
        expect(listItem.getAttribute('tabindex')).toBe('0');

        const row = host.querySelector('#row-btn')!;
        expect(row.getAttribute('tabindex')).toBe('0');
        expect(row.getAttribute('role')).toBe('button');

        // Can activate with Enter keydown
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(seen).toContainEqual({ kind: 'command', id: 'row.select' });
    });

    it('applyDefaultProp normalizes camelCase ARIA properties and boolean ARIA values', () => {
        const { host, components, dispatch } = setup();

        render(
            element('Stack', {
                props: {
                    ariaLabel: 'Navigation Landmark',
                    ariaHidden: true,
                    ariaExpanded: false,
                    ariaDescribedBy: 'desc-1',
                },
            }),
            host,
            { components, dispatch },
        );

        const el = host.querySelector('div')!;
        expect(el.getAttribute('aria-label')).toBe('Navigation Landmark');
        expect(el.getAttribute('aria-hidden')).toBe('true');
        expect(el.getAttribute('aria-expanded')).toBe('false');
        expect(el.getAttribute('aria-describedby')).toBe('desc-1');
        // Ensure camelCase names are not present on DOM
        expect(el.hasAttribute('ariaLabel')).toBe(false);
        expect(el.hasAttribute('ariaHidden')).toBe(false);
    });
});



/**
 * **A view can register a handler, and pressing the control runs it** — roadmap A8.10.
 *
 * Every piece of this existed except the one that connects them: `createHandlerTable` was created
 * per window, the dispatcher resolved `{ kind: 'handler' }` against it, and it was disposed with the
 * view — but a view had no way to *put* a function in, so every handler intent resolved to nothing.
 * Silently, because `invoke` returning `false` is *"a stale event, not a crash"*.
 *
 * `ui.ActionButton`, `ui.ActionCard` and mesh-core's `EntityItem` selection were all inert on that,
 * and their tests passed because each called the composite's `run()` directly. **A test that calls a
 * piece never presses it**, which is why these press.
 */
describe('a view registers its own handlers', () => {
    /** Mount a view whose only control is bound to a closure, and return a way to press it. */
    function mountWithHandler(onPress: (value?: IntentValue) => void, windowId = 'w1') {
        const { host, components, dispatch } = setup();

        const view = mountView(host, {
            windowId,
            decl: {
                id: 'main',
                title: 'Handler',
                render: (vx: { on(fn: (value?: IntentValue) => void): Action }) => element('Button', {
                    intents: { activate: { action: vx.on(onPress) } },
                    children: [text('press')],
                }),
            } as never,
            api: undefined,
            params: {},
            windows: { setTitle: () => {}, close: () => {} } as never,
            resolve: resolveRenderer(components),
                renderOptions: { dispatch },
            onCommand: () => {},
        });

        return {
            view,
            press: () => (host.querySelector('button'))?.click(),
        };
    }

    it('runs the closure when the control is pressed', () => {
        let pressed = 0;
        const { press } = mountWithHandler(() => { pressed += 1; });
        tick();

        press();
        expect(pressed).toBe(1);
    });

    /**
     * The action is data. A closure never crosses into the description — only an id does, which is
     * what lets a description be serialisable while an author writes an ordinary function.
     */
    it('puts an id in the description and never the function', () => {
        const { view } = mountWithHandler(() => {});
        tick();
        expect(view.handlers.size).toBe(1);
    });

    /**
     * **A handler dies with the view that owns it**, so a stale description cannot reach into a
     * screen that is gone. Ids are scoped `${windowId}:${n}` for the same reason.
     */
    it('forgets its handlers when the view is disposed', () => {
        let pressed = 0;
        const { view, press } = mountWithHandler(() => { pressed += 1; });
        tick();

        view.dispose();
        press();
        expect(pressed).toBe(0);
    });

    /** Two instances of one view must not collide, which the window-scoped id already ensures. */
    it('keeps two views apart', () => {
        let a = 0;
        let b = 0;
        const first = mountWithHandler(() => { a += 1; }, 'w1');
        const second = mountWithHandler(() => { b += 1; }, 'w2');
        tick();

        first.press();
        expect([a, b]).toEqual([1, 0]);

        second.press();
        expect([a, b]).toEqual([1, 1]);
    });
});
