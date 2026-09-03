/**
 * The renderer: description in, DOM out.
 *
 * This is the one place in the package where a DOM exists at all, and it belongs to the kernel
 * (spec/kernel.md section 2) — an Extension that could substitute it could read every other
 * contributor's view and forge events into it.
 *
 * spec/view-layer.md section 4 decides the strategy, and it is worth restating because it is not
 * what most frameworks do: **there is no virtual DOM and no diffing.** A signal is bound to the node
 * it affects at construction, so an update writes one text node or one attribute. Re-running a view
 * and comparing two trees is exactly the work this design exists to avoid.
 */

import { effect } from '../reactivity/effect.js';
import { createScope } from '../reactivity/scope.js';
import type { ReactiveScope } from '../reactivity/types.js';
import type { Action, EachNode, ElementNode, Intents, Json, Node, Reactive } from '../description/types.js';
import { isDynamic, read } from '../description/types.js';
import { applyDefaultProp, type ComponentRegistry } from './component.js';

/**
 * Where an action goes.
 *
 * The renderer does not know what a command is or where a handler lives — it turns a device event
 * into an intent and hands the intent's action to this. The kernel supplies it.
 */
export interface Dispatcher {
    dispatch(action: Action): void;
}

export interface RenderOptions {
    readonly components: ComponentRegistry;
    readonly dispatch: Dispatcher;
}

export interface Mounted {
    /** Stops every effect and removes every node this render created. */
    dispose(): void;
}

/**
 * Render a description into a host element.
 *
 * The host is supplied by the caller — the window manager, in a real system. Nothing below this
 * point ever sees it, and nothing above this file ever sees an element at all.
 */
export function render(description: Node, host: Element, options: RenderOptions): Mounted {
    const scope = createScope();
    let nodes: readonly ChildNode[] = [];

    scope.run(() => {
        nodes = build(description, options, scope);
        for (const node of nodes) host.appendChild(node);
    });

    return {
        dispose(): void {
            scope.dispose();
            for (const node of nodes) node.remove();
            nodes = [];
        },
    };
}

// ---------------------------------------------------------------------------- building

function build(node: Node, options: RenderOptions, scope: ReactiveScope): readonly ChildNode[] {
    if (Array.isArray(node)) {
        return (node as readonly Node[]).flatMap((child) => build(child, options, scope));
    }

    const single = node as Exclude<Node, readonly Node[]>;

    switch (single.kind) {
        case 'empty':
            return [];

        case 'text':
            return [buildText(single.value)];

        case 'element':
            return [buildElement(single, options, scope)];

        case 'when':
            return buildWhen(single.when, single.then, single.otherwise, options);

        case 'each':
            return buildEach(single, options);
    }
}

function buildText(value: Reactive<string | number>): Text {
    const node = document.createTextNode('');

    if (isDynamic(value)) {
        // One effect, one text node. This is the whole of "fine-grained".
        effect(() => {
            node.data = String(read(value));
        });
    } else {
        node.data = String(value);
    }

    return node;
}

function buildElement(node: ElementNode, options: RenderOptions, scope: ReactiveScope): Element {
    const definition = options.components.get(node.component);
    if (definition === undefined) {
        throw new Error(
            `Unknown component "${node.component}". ` +
            `Known: ${options.components.names.join(', ') || '(none registered)'}.`,
        );
    }

    const el = definition.create();

    for (const [name, value] of Object.entries(node.props)) {
        if (value === undefined) continue;

        const set = (v: Json): void => {
            if (definition.apply?.(el, name, v) === true) return;
            applyDefaultProp(el, name, v);
        };

        if (isDynamic(value)) {
            effect(() => set(read(value)));
        } else {
            set(value);
        }
    }

    if (node.intents !== undefined) {
        bindIntents(el, node.intents, options.dispatch);
    }

    const slot = definition.slot ? definition.slot(el) : el;
    for (const child of node.children) {
        for (const built of build(child, options, scope)) slot.appendChild(built);
    }

    return el;
}

/**
 * A branch, anchored between two comment markers.
 *
 * Markers rather than a wrapper element, because a wrapper would show up in the DOM and change
 * layout — a `when` inside a flex row must not introduce a box.
 */
function buildWhen(
    condition: Reactive<boolean>,
    then: () => Node,
    otherwise: (() => Node) | undefined,
    options: RenderOptions,
): readonly ChildNode[] {
    const start = document.createComment('when');
    const end = document.createComment('/when');

    let branchScope: ReactiveScope | undefined;
    let branchNodes: readonly ChildNode[] = [];
    let shown: boolean | undefined;

    effect(() => {
        const next = Boolean(read(condition));
        if (next === shown) return;
        shown = next;

        branchScope?.dispose();
        for (const node of branchNodes) node.remove();
        branchNodes = [];

        const source = next ? then : otherwise;
        if (source === undefined) {
            branchScope = undefined;
            return;
        }

        const inner = createScope();
        branchScope = inner;
        inner.run(() => {
            branchNodes = build(source(), options, inner);
        });

        insertBefore(branchNodes, end);
    });

    return [start, ...branchNodes, end];
}

/**
 * A keyed list.
 *
 * Keyed reconciliation rather than rebuilding, because the point of a list is that changing it does
 * not destroy the parts that did not change — a focused input inside a row must survive a reorder,
 * and so must an open editor. `each()` requires a key for exactly this reason.
 */
function buildEach(node: EachNode<unknown>, options: RenderOptions): readonly ChildNode[] {
    const start = document.createComment('each');
    const end = document.createComment('/each');

    interface Row {
        readonly scope: ReactiveScope;
        readonly nodes: readonly ChildNode[];
        index: number;
    }

    let rows = new Map<string | number, Row>();
    let first = true;

    effect(() => {
        const items = read(node.items);
        const next = new Map<string | number, Row>();
        const ordered: Row[] = [];

        items.forEach((item, index) => {
            const key = node.key(item, index);

            if (next.has(key)) {
                throw new Error(
                    `each(): duplicate key ${JSON.stringify(key)} at index ${index}. ` +
                    `Keys must be unique within one list.`,
                );
            }

            const existing = rows.get(key);
            if (existing !== undefined) {
                existing.index = index;
                next.set(key, existing);
                ordered.push(existing);
                rows.delete(key);
                return;
            }

            const scope = createScope();
            let nodes: readonly ChildNode[] = [];
            scope.run(() => {
                nodes = build(node.render(item, () => index), options, scope);
            });

            const row: Row = { scope, nodes, index };
            next.set(key, row);
            ordered.push(row);
        });

        // Whatever is left in `rows` was not in the new list.
        for (const gone of rows.values()) {
            gone.scope.dispose();
            for (const n of gone.nodes) n.remove();
        }

        rows = next;

        if (first) {
            first = false;
            return; // the initial nodes are returned below and inserted by the caller
        }

        // Place every row in order before the end marker. Nodes already in the right place are
        // moved onto themselves, which the DOM treats as a no-op.
        for (const row of ordered) insertBefore(row.nodes, end);
    });

    const initial = [...rows.values()].flatMap((row) => row.nodes);
    return [start, ...initial, end];
}

function insertBefore(nodes: readonly ChildNode[], marker: ChildNode): void {
    const parent = marker.parentNode;
    if (parent === null) return;
    for (const node of nodes) parent.insertBefore(node, marker);
}

// ---------------------------------------------------------------------------- intents

/**
 * Device events to intents.
 *
 * spec/input.md section 2: an Application receives what was meant, never what was pressed. This is a
 * first cut covering pointer and keyboard; touch, pen and gamepad are roadmap A8 and will land here
 * without changing anything above this line, which is the property worth having.
 */
function bindIntents(el: Element, intents: Intents, dispatch: Dispatcher): void {
    const fire = (name: keyof Intents, event: Event): void => {
        const binding = intents[name];
        if (binding === undefined) return;

        // Declared statically, because it cannot be decided asynchronously — across an isolation
        // boundary the default has already happened by the time a handler runs.
        if (binding.preventDefault) event.preventDefault();
        if (binding.stopPropagation) event.stopPropagation();

        dispatch.dispatch(binding.action);
    };

    if (intents.activate) {
        el.addEventListener('click', (e) => fire('activate', e));
        el.addEventListener('keydown', (e) => {
            const key = (e as KeyboardEvent).key;
            if (key === 'Enter' || key === ' ') fire('activate', e);
        });
    }

    if (intents.context) {
        el.addEventListener('contextmenu', (e) => fire('context', e));
    }

    if (intents.commit) {
        el.addEventListener('submit', (e) => fire('commit', e));
    }

    if (intents.dismiss) {
        el.addEventListener('keydown', (e) => {
            if ((e as KeyboardEvent).key === 'Escape') fire('dismiss', e);
        });
    }

    if (intents.change) {
        el.addEventListener('change', (e) => fire('change', e));
    }
}
