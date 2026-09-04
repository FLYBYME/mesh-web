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
import { signal } from '../reactivity/signal.js';
import { createScope } from '../reactivity/scope.js';
import type { ReactiveScope, Signal } from '../reactivity/types.js';
import type {
    Action, EachNode, ElementNode, Intents, IntentValue, Json, Node, Reactive,
} from '../description/types.js';
import { isDynamic, read } from '../description/types.js';
import { applyDefaultProp, type ComponentRegistry } from './component.js';

/**
 * Where an action goes.
 *
 * The renderer does not know what a command is or where a handler lives — it turns a device event
 * into an intent and hands the intent's action to this. The kernel supplies it.
 */
export interface Dispatcher {
    /**
     * `value` is present only for an intent that has one — `change` on a field. See `IntentValue`.
     *
     * Optional rather than a second method, so every existing dispatcher keeps working and a
     * dispatcher that does not care about values simply ignores the parameter.
     */
    dispatch(action: Action, value?: IntentValue): void;
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
            return buildWhen(single.when, single.then, single.otherwise, options, scope);

        case 'each':
            return buildEach(single, options, scope);
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
 *
 * **`owner` matters and is not decoration.** An effect disposes the effects created during its last
 * run before running again. Content built *inside* the reconciling effect is therefore torn down the
 * first time that effect re-fires — the nodes stay on screen and stop updating, which looks like a
 * reactivity bug and is an ownership bug. Building under `owner` gives the content the lifetime of
 * the surrounding render instead.
 */
function buildWhen(
    condition: Reactive<boolean>,
    then: () => Node,
    otherwise: (() => Node) | undefined,
    options: RenderOptions,
    owner: ReactiveScope,
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

        owner.run(() => {
            const inner = createScope();
            branchScope = inner;
            inner.run(() => {
                branchNodes = build(source(), options, inner);
            });
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
function buildEach(
    node: EachNode<unknown>,
    options: RenderOptions,
    owner: ReactiveScope,
): readonly ChildNode[] {
    const start = document.createComment('each');
    const end = document.createComment('/each');

    interface Row {
        readonly scope: ReactiveScope;
        readonly nodes: readonly ChildNode[];
        /**
         * The row's current item and position, held as signals.
         *
         * This is what makes reuse correct rather than merely fast. A row whose key is unchanged is
         * kept, and its contents may still have changed — so the row reads its item through an
         * accessor and the reconciler writes the new one here. Passing the item by value would give
         * every reused row a closure over stale data.
         */
        readonly item: Signal<unknown>;
        readonly index: Signal<number>;
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
                existing.item.set(item);
                existing.index.set(index);
                next.set(key, existing);
                ordered.push(existing);
                rows.delete(key);
                return;
            }

            let nodes: readonly ChildNode[] = [];
            let row: Row | undefined;

            // Built under `owner`, not under this effect — see buildWhen. A row created inside the
            // reconciling effect is disposed the next time the list changes, which leaves its nodes
            // on screen and dead.
            owner.run(() => {
                const scope = createScope();
                scope.run(() => {
                    const itemSignal = signal<unknown>(item);
                    const indexSignal = signal(index);
                    row = { scope, nodes: [], item: itemSignal, index: indexSignal };
                    nodes = build(
                        node.render(() => itemSignal(), () => indexSignal()),
                        options,
                        scope,
                    );
                });
            });

            const created: Row = { ...row!, nodes };
            next.set(key, created);
            ordered.push(created);
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

        // **The intent decides whether there is a value, not the element.** `change` means *this is
        // now the value*; `activate` means *act*, and carries nothing even from a control that has
        // a `value` property — a `<button>` has one, always `''`, and letting the element decide
        // would deliver that empty string to every command a button reaches.
        //
        // The value, never the event: a string, a boolean or a number, with nothing on it that
        // could reach the DOM, which is the property that lets a description cross a boundary.
        dispatch.dispatch(binding.action, name === 'change' ? valueOf(el) : undefined);
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
        // `input`, not `change`. `change` on a text field fires on blur, so a form whose button is
        // clicked directly from a focused field never sees the last thing typed — the classic
        // "it dropped my password" bug, and invisible in any test that dispatches events by hand.
        el.addEventListener('input', (e) => fire('change', e));
    }
}

/**
 * What a control holds, as a value rather than as an element.
 *
 * Only reached for `change`, which is the intent that means *this is now the value* — see `fire`.
 *
 * Three shapes and no more, because these are the three a browser control actually produces:
 * a checkbox is a `boolean`, a `number` or `range` input is a `number`, and everything else is the
 * string in it. Anything unrecognised answers `undefined` — a `change` bound to a `div` has no value,
 * and inventing one would be worse than saying so.
 *
 * `instanceof` is deliberately not used: this must work under jsdom and in a browser, where the two
 * `HTMLInputElement` constructors are different objects. Duck-typing on the properties is what
 * survives both, and it is checking for exactly what it reads.
 */
function valueOf(el: Element): IntentValue {
    const control = el as Partial<HTMLInputElement>;
    if (typeof control.value !== 'string') return undefined;

    if (control.type === 'checkbox' || control.type === 'radio') return control.checked === true;
    if (control.type === 'number' || control.type === 'range') {
        // An empty number field is not zero. `''` parses to NaN, which would arrive as a number the
        // user never typed, so it stays `undefined` and the reader decides what an empty field means.
        return control.value === '' ? undefined : Number(control.value);
    }

    return control.value;
}
