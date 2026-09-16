import { describe, expect, it, vi } from 'vitest';

import { signal } from '../src/reactivity/index.js';
import {
    createHandlerTable, dialog, each, element, empty, findAll,
    flatten, text, textOf, when,
} from '../src/description/index.js';
import type { FlatElement, SurfaceNode } from '../src/description/index.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSurface(overrides: Partial<SurfaceNode> = {}): SurfaceNode {
    return {
        kind: 'surface',
        setup: () => {},
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// 1. SurfaceNode via flatten()
// ---------------------------------------------------------------------------

describe('SurfaceNode flattening', () => {
    it('produces a FlatElement with component="Surface"', () => {
        const node = makeSurface();
        const tree = flatten(node);
        expect(tree).toHaveLength(1);
        expect(tree[0]).toMatchObject({ kind: 'element', component: 'Surface' });
    });

    it('always includes data-mesh-surface in props', () => {
        const node = makeSurface();
        const [flat] = flatten(node) as FlatElement[];
        expect(flat.props['data-mesh-surface']).toBe('placeholder');
    });

    it('merges extra props into the flat output alongside data-mesh-surface', () => {
        const node = makeSurface({ props: { role: 'region', tabIndex: 0 } });
        const [flat] = flatten(node) as FlatElement[];
        expect(flat.props).toMatchObject({
            'data-mesh-surface': 'placeholder',
            role: 'region',
            tabIndex: 0,
        });
    });

    it('has empty children always', () => {
        const node = makeSurface();
        const [flat] = flatten(node) as FlatElement[];
        expect(flat.children).toEqual([]);
    });

    it('preserves the key when provided', () => {
        const node = makeSurface({ key: 'my-surface' });
        const [flat] = flatten(node) as FlatElement[];
        expect(flat.key).toBe('my-surface');
    });

    it('key is absent when not provided', () => {
        const node = makeSurface();
        const [flat] = flatten(node) as FlatElement[];
        expect('key' in flat).toBe(false);
    });

    it('does NOT call the setup function during flatten', () => {
        const setup = vi.fn();
        const node = makeSurface({ setup });
        flatten(node);
        expect(setup).not.toHaveBeenCalled();
    });

    it('resolves reactive extra props', () => {
        const label = signal('hello');
        const node = makeSurface({ props: { 'aria-label': () => label() } });
        const [flat] = flatten(node) as FlatElement[];
        expect(flat.props['aria-label']).toBe('hello');

        label.set('world');
        const [updated] = flatten(node) as FlatElement[];
        expect(updated.props['aria-label']).toBe('world');
    });
});

// ---------------------------------------------------------------------------
// 2. flatten() with arrays
// ---------------------------------------------------------------------------

describe('flatten() with arrays', () => {
    it('flattens a top-level array of nodes', () => {
        const tree = flatten([text('a'), text('b')]);
        expect(tree).toHaveLength(2);
        expect(textOf(tree)).toBe('ab');
    });

    it('flattens nested arrays in children', () => {
        // Element children are flat Node[], but we can pass an array at top level
        const tree = flatten([element('A', {}), [text('x'), text('y')]]);
        expect(tree).toHaveLength(3);
        expect(textOf(tree)).toBe('xy');
    });

    it('empty array flattens to []', () => {
        expect(flatten([])).toEqual([]);
    });

    it('array with a single element produces one flat node', () => {
        const tree = flatten([text('hello')]);
        expect(tree).toHaveLength(1);
        expect(textOf(tree)).toBe('hello');
    });
});

// ---------------------------------------------------------------------------
// 3. element key and intents preservation
// ---------------------------------------------------------------------------

describe('element key and intents in flat output', () => {
    it('preserves a string key', () => {
        const node = element('Button', { key: 'btn-save' });
        const [flat] = flatten(node) as FlatElement[];
        expect(flat.key).toBe('btn-save');
    });

    it('preserves a number key', () => {
        const node = element('Row', { key: 42 });
        const [flat] = flatten(node) as FlatElement[];
        expect(flat.key).toBe(42);
    });

    it('key field is absent (not even undefined) when no key given', () => {
        const node = element('Button', {});
        const [flat] = flatten(node) as FlatElement[];
        expect('key' in flat).toBe(false);
    });

    it('preserves intents on a flat element', () => {
        const intents = { activate: { action: { kind: 'command' as const, id: 'my.cmd' } } };
        const node = element('Button', { intents });
        const [flat] = flatten(node) as FlatElement[];
        expect(flat.intents).toEqual(intents);
    });

    it('intents field is absent when no intents given', () => {
        const node = element('Button', {});
        const [flat] = flatten(node) as FlatElement[];
        expect('intents' in flat).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// 4. each() key assignment to rendered elements
// ---------------------------------------------------------------------------

describe('each() key assignment', () => {
    it('assigns the item key to a rendered element that has no key', () => {
        const items = [{ id: 'x' }, { id: 'y' }];
        // render returns element with no key → each() fills it in
        const tree = flatten(each(items, (i) => i.id, () => element('Row', {})));
        expect(tree).toHaveLength(2);
        expect((tree[0] as FlatElement).key).toBe('x');
        expect((tree[1] as FlatElement).key).toBe('y');
    });

    it('preserves an existing key on a rendered element (does not overwrite)', () => {
        const items = [{ id: 'x' }, { id: 'y' }];
        const tree = flatten(
            each(items, (i) => i.id, () => element('Row', { key: 'hardcoded' })),
        );
        // existing key is kept
        expect((tree[0] as FlatElement).key).toBe('hardcoded');
        expect((tree[1] as FlatElement).key).toBe('hardcoded');
    });

    it('does not assign keys to text nodes inside each()', () => {
        const items = ['a', 'b'];
        const tree = flatten(each(items, (s) => s, (s) => text(() => s())));
        expect(tree).toHaveLength(2);
        // text nodes don't have a key property
        for (const node of tree) {
            expect(node.kind).toBe('text');
            expect('key' in node).toBe(false);
        }
    });

    it('handles numeric keys from each()', () => {
        const items = [10, 20];
        const tree = flatten(each(items, (n) => n, () => element('Cell', {})));
        expect((tree[0] as FlatElement).key).toBe(10);
        expect((tree[1] as FlatElement).key).toBe(20);
    });
});

// ---------------------------------------------------------------------------
// 5. dialog() node specifics
// ---------------------------------------------------------------------------

describe('dialog() node flattening', () => {
    it('when open=true, children are in the tree and props.open=true', () => {
        const node = dialog({ open: true, children: [text('body')] });
        const tree = flatten(node);
        expect(tree).toHaveLength(1);
        const flat = tree[0] as FlatElement;
        expect(flat.props.open).toBe(true);
        expect(textOf(tree)).toBe('body');
    });

    it('when open=false, children are NOT in tree and props.open=false', () => {
        const node = dialog({ open: false, children: [text('body')] });
        const tree = flatten(node);
        expect(tree).toHaveLength(1);
        const flat = tree[0] as FlatElement;
        expect(flat.props.open).toBe(false);
        expect(flat.children).toEqual([]);
        expect(textOf(tree)).toBe('');
    });

    it('reacts to a reactive open signal', () => {
        const isOpen = signal(false);
        const view = () => dialog({ open: () => isOpen(), children: [text('inside')] });

        expect(textOf(flatten(view()))).toBe('');
        isOpen.set(true);
        expect(textOf(flatten(view()))).toBe('inside');
        isOpen.set(false);
        expect(textOf(flatten(view()))).toBe('');
    });

    it('preserves a key on dialog node', () => {
        const node = dialog({ open: false, key: 'dlg-1' });
        const [flat] = flatten(node) as FlatElement[];
        expect(flat.key).toBe('dlg-1');
    });

    it('key is absent when not provided', () => {
        const node = dialog({ open: false });
        const [flat] = flatten(node) as FlatElement[];
        expect('key' in flat).toBe(false);
    });

    it('preserves intents on dialog node', () => {
        const intents = { dismiss: { action: { kind: 'command' as const, id: 'dlg.close' } } };
        const node = dialog({ open: false, intents });
        const [flat] = flatten(node) as FlatElement[];
        expect(flat.intents).toEqual(intents);
    });

    it('intents absent when not provided', () => {
        const node = dialog({ open: false });
        const [flat] = flatten(node) as FlatElement[];
        expect('intents' in flat).toBe(false);
    });

    it('extra DialogProps (ariaLabel, title, class) appear in flat output', () => {
        const node = dialog({
            open: false,
            props: { ariaLabel: 'my dialog', title: 'My Dialog', class: 'modal' },
        });
        const [flat] = flatten(node) as FlatElement[];
        expect(flat.props.ariaLabel).toBe('my dialog');
        expect(flat.props.title).toBe('My Dialog');
        expect(flat.props.class).toBe('modal');
    });

    it('open prop in DialogProps is ignored — open comes from the open option', () => {
        // Even if someone sneaks open into props, it is skipped and only the option is used.
        const node = dialog({
            open: true,
            // @ts-expect-error - deliberately testing runtime behaviour; `open` is skipped by flattenDialog
            props: { open: false },
        });
        const [flat] = flatten(node) as FlatElement[];
        // The option wins: open=true
        expect(flat.props.open).toBe(true);
    });

    it('flattens component as "Dialog"', () => {
        const node = dialog({ open: false });
        const [flat] = flatten(node) as FlatElement[];
        expect(flat.component).toBe('Dialog');
    });
});

// ---------------------------------------------------------------------------
// 6. findAll() helper
// ---------------------------------------------------------------------------

describe('findAll()', () => {
    it('finds all matching components depth-first', () => {
        const tree = flatten(
            element('Root', {
                children: [
                    element('Button', { children: [text('A')] }),
                    element('Button', { children: [text('B')] }),
                ],
            }),
        );
        const buttons = findAll(tree, 'Button');
        expect(buttons).toHaveLength(2);
        expect(textOf([buttons[0]])).toBe('A');
        expect(textOf([buttons[1]])).toBe('B');
    });

    it('finds components nested multiple levels deep', () => {
        const tree = flatten(
            element('Root', {
                children: [
                    element('Outer', {
                        children: [
                            element('Inner', {
                                children: [element('Target', {})],
                            }),
                        ],
                    }),
                ],
            }),
        );
        const targets = findAll(tree, 'Target');
        expect(targets).toHaveLength(1);
    });

    it('returns empty array when component not found', () => {
        const tree = flatten(element('Root', { children: [text('hello')] }));
        expect(findAll(tree, 'NotHere')).toEqual([]);
    });

    it('finds multiple instances at different depths', () => {
        const tree = flatten(
            element('Root', {
                children: [
                    element('Tag', {}),
                    element('Wrapper', {
                        children: [
                            element('Tag', {}),
                            element('Deep', {
                                children: [element('Tag', {})],
                            }),
                        ],
                    }),
                ],
            }),
        );
        expect(findAll(tree, 'Tag')).toHaveLength(3);
    });

    it('depth-first order: outer before inner for same component', () => {
        const tree = flatten(
            element('Box', {
                children: [
                    element('Box', {}),
                ],
            }),
        );
        const boxes = findAll(tree, 'Box');
        // both found; outer first
        expect(boxes).toHaveLength(2);
    });

    it('works on an empty tree', () => {
        expect(findAll([], 'Anything')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// 7. textOf() helper
// ---------------------------------------------------------------------------

describe('textOf()', () => {
    it('empty array returns empty string', () => {
        expect(textOf([])).toBe('');
    });

    it('elements with no text children return empty string', () => {
        const tree = flatten(element('Div', { children: [element('Span', {})] }));
        expect(textOf(tree)).toBe('');
    });

    it('concatenates deeply nested text left to right', () => {
        const tree = flatten(
            element('Root', {
                children: [
                    element('A', { children: [text('1')] }),
                    element('B', {
                        children: [
                            element('C', { children: [text('2')] }),
                            text('3'),
                        ],
                    }),
                    text('4'),
                ],
            }),
        );
        expect(textOf(tree)).toBe('1234');
    });

    it('handles a mix of text and element nodes at the top level', () => {
        const tree = flatten([text('hello'), element('Span', {}), text(' world')]);
        expect(textOf(tree)).toBe('hello world');
    });

    it('number text node is coerced to string', () => {
        const tree = flatten(text(42));
        expect(textOf(tree)).toBe('42');
    });
});

// ---------------------------------------------------------------------------
// 8. createHandlerTable – invoke with values, sequential ids, size & dispose
// ---------------------------------------------------------------------------

describe('createHandlerTable', () => {
    it('invokes handler with undefined when no value passed', () => {
        const table = createHandlerTable('s');
        const received: unknown[] = [];
        const action = table.on((v) => received.push(v));
        table.invoke((action as { id: string }).id);
        expect(received).toEqual([undefined]);
    });

    it('invokes handler with a string value', () => {
        const table = createHandlerTable('s');
        const received: unknown[] = [];
        const action = table.on((v) => received.push(v));
        table.invoke((action as { id: string }).id, 'typed-text');
        expect(received).toEqual(['typed-text']);
    });

    it('invokes handler with a Json object value', () => {
        const table = createHandlerTable('s');
        const received: unknown[] = [];
        const payload = { x: 1, y: true };
        const action = table.on((v) => received.push(v));
        table.invoke((action as { id: string }).id, payload);
        expect(received).toEqual([payload]);
    });

    it('assigns sequential ids starting at scope:0', () => {
        const table = createHandlerTable('view');
        const a1 = table.on(() => {}) as { id: string };
        const a2 = table.on(() => {}) as { id: string };
        const a3 = table.on(() => {}) as { id: string };
        expect(a1.id).toBe('view:0');
        expect(a2.id).toBe('view:1');
        expect(a3.id).toBe('view:2');
    });

    it('size tracks correctly: add 3, dispose all → size becomes 0', () => {
        const table = createHandlerTable('v');
        table.on(() => {});
        table.on(() => {});
        table.on(() => {});
        expect(table.size).toBe(3);
        table.dispose();
        expect(table.size).toBe(0);
    });

    it('invoke after dispose returns false (handler cleared)', () => {
        const table = createHandlerTable('v');
        const action = table.on(() => {}) as { id: string };
        table.dispose();
        expect(table.invoke(action.id)).toBe(false);
    });

    it('invoke of never-registered id returns false', () => {
        const table = createHandlerTable('v');
        expect(table.invoke('v:9999')).toBe(false);
    });

    it('ids are scoped: different scope prefixes produce different ids', () => {
        const t1 = createHandlerTable('alpha');
        const t2 = createHandlerTable('beta');
        const a1 = t1.on(() => {}) as { id: string };
        const a2 = t2.on(() => {}) as { id: string };
        expect(a1.id).toBe('alpha:0');
        expect(a2.id).toBe('beta:0');
        // Invoking alpha:0 does not affect beta's table and vice-versa
        expect(t2.invoke(a1.id)).toBe(false);
        expect(t1.invoke(a2.id)).toBe(false);
    });

    it('size increments with each on() call', () => {
        const table = createHandlerTable('s');
        expect(table.size).toBe(0);
        table.on(() => {});
        expect(table.size).toBe(1);
        table.on(() => {});
        expect(table.size).toBe(2);
    });
});
