import { describe, expect, it, vi } from 'vitest';

import { signal } from '../src/reactivity/index.js';
import {
    command, createHandlerTable, each, element, empty, findAll,
    flatten, text, textOf, when,
} from '../src/description/index.js';

describe('a description is plain data', () => {
    it('has no DOM in it, and no functions once flattened', () => {
        const tree = flatten(
            element('Stack', {
                props: { gap: 8 },
                children: [
                    element('Heading', { children: [text('A blog')] }),
                    element('Text', { children: [text('Hello')] }),
                ],
            }),
        );

        // The whole point: a full render, asserted on, with no DOM anywhere.
        expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
        expect(textOf(tree)).toBe('A blogHello');
    });

    it('names components, never tags', () => {
        const tree = flatten(element('Button', { children: [text('Save')] }));
        expect(tree[0]).toMatchObject({ kind: 'element', component: 'Button' });
    });
});

describe('reactive values are read on the application side', () => {
    it('resolves a signal to its value, not to a function', () => {
        const name = signal('world');
        const view = () => element('Text', { children: [text(() => `hello ${name()}`)] });

        expect(textOf(flatten(view()))).toBe('hello world');
        name.set('deck');
        expect(textOf(flatten(view()))).toBe('hello deck');
    });

    it('resolves reactive props', () => {
        const disabled = signal(true);
        const tree = flatten(element('Button', { props: { disabled: () => disabled() } }));

        expect((tree[0] as { props: Record<string, unknown> }).props).toEqual({ disabled: true });
        disabled.set(false);
        expect(
            (flatten(element('Button', { props: { disabled: () => disabled() } }))[0] as {
                props: Record<string, unknown>;
            }).props,
        ).toEqual({ disabled: false });
    });
});

describe('control flow', () => {
    it('when picks a branch and does not evaluate the other', () => {
        const signedIn = signal(false);
        const taken = vi.fn(() => text('in'));
        const notTaken = vi.fn(() => text('out'));

        expect(textOf(flatten(when(() => signedIn(), taken, notTaken)))).toBe('out');
        expect(taken).not.toHaveBeenCalled();

        signedIn.set(true);
        expect(textOf(flatten(when(() => signedIn(), taken, notTaken)))).toBe('in');
    });

    it('when with no otherwise renders nothing', () => {
        expect(flatten(when(false, () => text('x')))).toEqual([]);
    });

    it('each expands and carries keys down', () => {
        const posts = signal([
            { slug: 'a', title: 'First' },
            { slug: 'b', title: 'Second' },
        ]);

        const tree = flatten(
            each(
                () => posts(),
                (p) => p.slug,
                // `p` is an accessor, not a value — a reused row must read its current item.
                (p) => element('Row', { children: [text(() => p().title)] }),
            ),
        );

        expect(tree).toHaveLength(2);
        expect(textOf(tree)).toBe('FirstSecond');
        expect(tree.map((n) => (n as { key?: string }).key)).toEqual(['a', 'b']);
    });

    it('rejects a duplicate key, because the symptom is silent misordering', () => {
        const dup = each(
            [{ id: 1 }, { id: 1 }],
            (item) => item.id,
            () => text('x'),
        );
        expect(() => flatten(dup)).toThrow(/duplicate key 1 at index 1/);
    });

    it('empty renders nothing', () => {
        expect(flatten(empty())).toEqual([]);
    });
});

describe('actions carry identity, not closures', () => {
    it('a command is data', () => {
        const tree = flatten(
            element('Button', {
                intents: { activate: { action: command('blog.newPost') } },
                children: [text('New')],
            }),
        );

        expect((tree[0] as { intents: unknown }).intents).toEqual({
            activate: { action: { kind: 'command', id: 'blog.newPost' } },
        });
    });

    it('a handler puts an id in the description and keeps the function aside', () => {
        const handlers = createHandlerTable('view-1');
        const saw: string[] = [];
        const action = handlers.on(() => saw.push('called'));

        const tree = flatten(element('Button', { intents: { activate: { action } } }));
        const intents = (tree[0] as { intents: { activate: { action: { kind: string; id: string } } } }).intents;

        expect(intents.activate.action.kind).toBe('handler');
        expect(typeof intents.activate.action.id).toBe('string');
        expect(JSON.stringify(tree)).toContain('"kind":"handler"');

        expect(handlers.invoke(intents.activate.action.id)).toBe(true);
        expect(saw).toEqual(['called']);
    });

    it('preventDefault is static data, because it cannot be decided asynchronously', () => {
        const tree = flatten(
            element('Form', {
                intents: { commit: { action: command('blog.save'), preventDefault: true } },
            }),
        );
        expect((tree[0] as { intents: { commit: { preventDefault: boolean } } }).intents.commit.preventDefault)
            .toBe(true);
    });

    it('an unknown handler id is a stale event, not a crash', () => {
        const handlers = createHandlerTable('view-1');
        expect(handlers.invoke('view-1:999')).toBe(false);
    });

    it('the handler table empties on dispose', () => {
        const handlers = createHandlerTable('view-1');
        for (let i = 0; i < 1000; i++) handlers.on(() => {});
        expect(handlers.size).toBe(1000);

        handlers.dispose();
        expect(handlers.size).toBe(0);
    });
});

describe('a whole view renders without a browser', () => {
    it('a blog sidebar, drafts marked', () => {
        const posts = signal([
            { slug: 'a', title: 'First', published: true },
            { slug: 'b', title: 'Second', published: false },
        ]);

        const sidebar = () =>
            element('Stack', {
                children: [
                    each(
                        () => posts(),
                        (p) => p.slug,
                        (p) =>
                            element('Row', {
                                intents: { activate: { action: command('blog.open', p().slug) } },
                                children: [
                                    text(() => p().title),
                                    when(() => !p().published, () => text(' — draft')),
                                ],
                            }),
                    ),
                ],
            });

        const tree = flatten(sidebar());
        expect(textOf(tree)).toBe('FirstSecond — draft');
        expect(findAll(tree, 'Row')).toHaveLength(2);

        posts.set([...posts(), { slug: 'c', title: 'Third', published: true }]);
        expect(findAll(flatten(sidebar()), 'Row')).toHaveLength(3);
    });
});
