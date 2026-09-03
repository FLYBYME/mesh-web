/**
 * The description: what a view returns instead of DOM.
 *
 * spec/view-layer.md is the argument. The short version: a view is a pure function from application
 * state to a description, it holds no logic, and it produces no DOM. This file is the "no DOM" half
 * — there is deliberately no `HTMLElement`, `Node` or `Event` anywhere in it, and none may be added.
 *
 * Everything here is plain data. A description can be asserted on in a test, rendered to HTML on a
 * server, or posted across a worker boundary, because none of those depend on it being anything
 * other than an object.
 */

import type { Signal } from '../reactivity/types.js';

// ---------------------------------------------------------------------------- reactive values

/**
 * A value in a description that may change.
 *
 * Either a plain value, or a zero-argument function reading signals. The function is *not*
 * serialized — it is evaluated on the Application's own side and its result is what crosses
 * (spec/view-layer.md section 4). That is why a closure here is not a boundary problem.
 */
export type Reactive<T> = T | (() => T);

/** Resolve a `Reactive<T>` once. Callers inside an effect get tracked reads for free. */
export function read<T>(value: Reactive<T>): T {
    return typeof value === 'function' ? (value as () => T)() : value;
}

/** True when a reactive value is dynamic, and therefore needs binding rather than copying. */
export function isDynamic<T>(value: Reactive<T>): value is () => T {
    return typeof value === 'function';
}

// ---------------------------------------------------------------------------- handlers

/**
 * A reference to something that happens, as data.
 *
 * spec/view-layer.md section 5: events travel renderer to Application, so they need identity that
 * survives a boundary. Two kinds, and the rule for choosing is "would anyone ever want to bind a
 * key to it?" — yes means a command, no means a handler.
 */
export type Action =
    /** A declared command, by id. In the palette, bindable, scriptable. */
    | { readonly kind: 'command'; readonly id: string; readonly args?: readonly Json[] }
    /** Incidental interaction. The framework assigns the id; the function stays on the app side. */
    | { readonly kind: 'handler'; readonly id: HandlerId };

/** Opaque. Assigned by the framework, never written by an author. */
export type HandlerId = string & { readonly __handler?: never };

/** Anything that may cross a boundary. */
export type Json =
    | string | number | boolean | null
    | readonly Json[]
    | { readonly [key: string]: Json };

// ---------------------------------------------------------------------------- intents

/**
 * What an Application receives. Never `click`, never `keydown`, never `buttondown`.
 *
 * spec/input.md section 2. `context` is a right-click, a long-press, the Menu key, or a Deck's back
 * button, and nothing downstream knows which.
 */
export type IntentName =
    | 'activate'
    | 'context'
    | 'navigate'
    | 'commit'
    | 'dismiss'
    | 'scroll'
    | 'zoom'
    | 'change';

/**
 * Whether the default platform behaviour is suppressed.
 *
 * Declared statically, because it cannot be decided asynchronously — across an isolation boundary
 * the default has already happened by the time a handler runs (spec/input.md section 5). So the
 * renderer knows before it dispatches.
 */
export interface IntentBinding {
    readonly action: Action;
    readonly preventDefault?: boolean;
    readonly stopPropagation?: boolean;
}

export type Intents = { readonly [K in IntentName]?: IntentBinding };

// ---------------------------------------------------------------------------- nodes

/**
 * A node in a description.
 *
 * Never a tag. `component` names something in the vocabulary — `Stack`, `Text`, `Button` — and the
 * renderer decides what element that becomes, if any. spec/view-layer.md section 3: if nobody writes
 * `div`, nobody writes `HTMLElement` either.
 */
export interface ElementNode {
    readonly kind: 'element';
    readonly component: string;
    readonly props: Props;
    readonly intents?: Intents;
    /** Stable identity across updates. Required inside a list. */
    readonly key?: string | number;
    readonly children: readonly Node[];
}

export interface TextNode {
    readonly kind: 'text';
    readonly value: Reactive<string | number>;
}

/** Renders `then` while `when` holds, `otherwise` when it does not. */
export interface WhenNode {
    readonly kind: 'when';
    readonly when: Reactive<boolean>;
    readonly then: () => Node;
    readonly otherwise?: () => Node;
}

/**
 * One subtree per item, keyed, so a list update does not rebuild the list.
 *
 * `key` and `render` are declared as **methods, not properties**, and that is load-bearing rather
 * than stylistic: method parameters are compared bivariantly, which is what makes `EachNode<Post>`
 * assignable to the erased `EachNode<unknown>` in `Node` below. As properties they are compared
 * strictly and every concrete list fails to be a `Node`.
 */
export interface EachNode<T = unknown> {
    readonly kind: 'each';
    readonly items: Reactive<readonly T[]>;
    key(item: T, index: number): string | number;
    render(item: T, index: () => number): Node;
}

/** Nothing. The result of a `when` with no `otherwise`, and of an empty list. */
export interface EmptyNode {
    readonly kind: 'empty';
}

export type Node = ElementNode | TextNode | WhenNode | EachNode<unknown> | EmptyNode | readonly Node[];

// ---------------------------------------------------------------------------- props

/**
 * Props are exact, per component. There is no index signature.
 *
 * spec/type-safety.md section 4 bans `[attr: string]: unknown` here: with one, every prop typo is
 * legal and nothing is checked. A component declares its props and that declaration is the contract.
 */
export type Props = { readonly [name: string]: Reactive<Json> | undefined };
