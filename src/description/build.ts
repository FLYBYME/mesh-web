/**
 * Building a description.
 *
 * These are what an Application actually calls. Note what is absent: there is no `h()`, and no way
 * to name a tag. spec/view-layer.md section 3 — the vocabulary is components, and returning a
 * description while writing `h('div')` would be the same problem with extra steps.
 */

import type {
    Action, DialogNode, DialogProps, EachNode, ElementNode, EmptyNode, Intents, IntentValue, Json,
    Node, Props, Reactive, TextNode, WhenNode,
} from './types.js';

const EMPTY: EmptyNode = { kind: 'empty' };

/** Nothing. */
export function empty(): EmptyNode {
    return EMPTY;
}

export interface ElementOptions {
    readonly props?: Props;
    readonly intents?: Intents;
    readonly key?: string | number;
    readonly children?: readonly Node[];
}

/**
 * One node of the description.
 *
 * `component` is a name from the vocabulary. It is a string here rather than a typed union because
 * the vocabulary is extensible — an Extension contributes components (spec/view-layer.md section 3)
 * — and the typed wrappers a component library exports are what give an author completion. This is
 * the untyped floor those are built on, not the surface authors use.
 */
export function element(component: string, options: ElementOptions = {}): ElementNode {
    return {
        kind: 'element',
        component,
        props: options.props ?? {},
        ...(options.intents ? { intents: options.intents } : {}),
        ...(options.key !== undefined ? { key: options.key } : {}),
        children: options.children ?? [],
    };
}

/** A string or number, possibly reactive. */
export function text(value: Reactive<string | number>): TextNode {
    return { kind: 'text', value };
}

/** Conditional. `then` and `otherwise` are thunks so an unrendered branch costs nothing. */
export function when(
    condition: Reactive<boolean>,
    then: () => Node,
    otherwise?: () => Node,
): WhenNode {
    return {
        kind: 'when',
        when: condition,
        then,
        ...(otherwise ? { otherwise } : {}),
    };
}

/**
 * A list.
 *
 * `key` is required, not optional. A keyed list is the difference between a reorder moving nodes and
 * a reorder rebuilding them, and making it optional means it is omitted exactly where it matters
 * most — a long list that changes.
 */
export function each<T>(
    items: Reactive<readonly T[]>,
    key: (item: T, index: number) => string | number,
    render: (item: () => T, index: () => number) => Node,
): EachNode<T> {
    return { kind: 'each', items, key, render };
}

export interface DialogOptions {
    readonly open: Reactive<boolean>;
    readonly props?: DialogProps;
    readonly intents?: Intents;
    readonly key?: string | number;
    readonly children?: readonly Node[];
}

/**
 * A modal dialog surface.
 *
 * Reconciled by the renderer to `<dialog>` and `showModal()` / `close()`.
 * Focus is trapped while open and restored to the opener on close.
 * When closed, contents are not in the tree.
 */
export function dialog(options: DialogOptions): DialogNode {
    return {
        kind: 'dialog',
        open: options.open,
        ...(options.props ? { props: options.props } : {}),
        ...(options.intents ? { intents: options.intents } : {}),
        ...(options.key !== undefined ? { key: options.key } : {}),
        children: options.children ?? [],
    };
}


// ---------------------------------------------------------------------------- actions

/** Invoke a declared command. In the palette, bindable to a key, callable from outside. */
export function command(id: string, ...args: readonly Json[]): Action {
    return args.length > 0 ? { kind: 'command', id, args } : { kind: 'command', id };
}

/**
 * Register an incidental handler and get back a reference to it.
 *
 * The function stays on the Application's side; only the id is in the description. That is what
 * lets a description cross a boundary while an author still writes an ordinary closure
 * (spec/view-layer.md section 5).
 */
export interface HandlerTable {
    /**
     * Register a function, returning the action that refers to it.
     *
     * The function receives whatever the intent carried — the text in a field for a `change`,
     * `undefined` for an `activate`. A handler that ignores it is written `() => …` and is
     * unaffected, which is why this is a parameter rather than a second kind of handler.
     */
    on(fn: (value?: IntentValue) => void): Action;
    /** Invoke by id. Returns false when the id is unknown — a stale event, not a crash. */
    invoke(id: string, value?: IntentValue): boolean;
    /** Free everything. Called when the view instance goes away. */
    dispose(): void;
    readonly size: number;
}

/**
 * Per view instance, and freed with it.
 *
 * spec/view-layer.md section 5 flags this as the bookkeeping most likely to be wrong the first time,
 * which is why `size` is exposed: a test can open and close a view a thousand times and assert the
 * table is empty.
 */
export function createHandlerTable(scopeId: string): HandlerTable {
    const handlers = new Map<string, (value?: IntentValue) => void>();
    let next = 0;

    return {
        on(fn: (value?: IntentValue) => void): Action {
            const id = `${scopeId}:${next++}`;
            handlers.set(id, fn);
            return { kind: 'handler', id };
        },
        invoke(id: string, value?: IntentValue): boolean {
            const fn = handlers.get(id);
            if (fn === undefined) return false;
            fn(value);
            return true;
        },
        dispose(): void {
            handlers.clear();
        },
        get size(): number {
            return handlers.size;
        },
    };
}
