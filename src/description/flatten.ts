/**
 * Flattening a description to a static tree.
 *
 * This is the test renderer, and it is also the server-side-rendering path: it resolves every
 * reactive value once and expands control flow, producing a plain tree with no functions in it.
 *
 * spec/testing.md section 3 argues for one conformance suite across both renderers. This is the
 * cheap one, and the fact that it can exist at all — a full render with no DOM, no jsdom and no
 * browser — is the property the description layer was built for.
 */

import type { DialogNode, EachNode, ElementNode, Intents, Json, Node, SurfaceNode, WhenNode } from './types.js';
import { read } from './types.js';

/** A description with every reactive value resolved. Plain data, comparable, serializable. */
export type Flat = FlatElement | FlatText;

export interface FlatElement {
    readonly kind: 'element';
    readonly component: string;
    readonly props: Readonly<Record<string, Json>>;
    readonly intents?: Intents;
    readonly key?: string | number;
    readonly children: readonly Flat[];
}

export interface FlatText {
    readonly kind: 'text';
    readonly value: string;
}

/**
 * Resolve a description once.
 *
 * Reactive values are *read*, not preserved. Calling this inside an effect tracks every signal the
 * description depends on, which is how the DOM renderer will later bind them — this function is not
 * a lesser path, it is the same traversal without the DOM writes.
 */
export function flatten(node: Node): readonly Flat[] {
    if (Array.isArray(node)) {
        return (node as readonly Node[]).flatMap(flatten);
    }

    const single = node as Exclude<Node, readonly Node[]>;

    switch (single.kind) {
        case 'empty':
            return [];

        case 'text': {
            const value = read(single.value);
            return [{ kind: 'text', value: String(value) }];
        }

        case 'element':
            return [flattenElement(single)];

        case 'when':
            return flattenWhen(single);

        case 'each':
            return flattenEach(single);

        case 'surface':
            return [flattenSurface(single)];

        case 'dialog':
            return [flattenDialog(single)];
    }
}

function flattenDialog(node: DialogNode): FlatElement {
    const isOpen = Boolean(read(node.open));
    const props: Record<string, Json> = {
        open: isOpen,
    };
    if (node.props) {
        for (const [name, value] of Object.entries(node.props)) {
            if (value === undefined || name === 'open') continue;
            props[name] = read(value);
        }
    }

    return {
        kind: 'element',
        component: 'Dialog',
        props,
        ...(node.intents ? { intents: node.intents } : {}),
        ...(node.key !== undefined ? { key: node.key } : {}),
        children: isOpen ? node.children.flatMap(flatten) : [],
    };
}

function flattenSurface(node: SurfaceNode): FlatElement {
    const props: Record<string, Json> = {
        'data-mesh-surface': 'placeholder',
    };
    if (node.props) {
        for (const [name, value] of Object.entries(node.props)) {
            if (value === undefined) continue;
            props[name] = read(value);
        }
    }

    return {
        kind: 'element',
        component: 'Surface',
        props,
        ...(node.key !== undefined ? { key: node.key } : {}),
        children: [],
    };
}

function flattenElement(node: ElementNode): FlatElement {
    const props: Record<string, Json> = {};
    for (const [name, value] of Object.entries(node.props)) {
        if (value === undefined) continue;
        props[name] = read(value);
    }

    const isClosedDialog = node.component === 'Dialog' && props.open !== true;

    return {
        kind: 'element',
        component: node.component,
        props,
        ...(node.intents ? { intents: node.intents } : {}),
        ...(node.key !== undefined ? { key: node.key } : {}),
        children: isClosedDialog ? [] : node.children.flatMap(flatten),
    };
}

function flattenWhen(node: WhenNode): readonly Flat[] {
    if (read(node.when)) return flatten(node.then());
    return node.otherwise ? flatten(node.otherwise()) : [];
}

function flattenEach(node: EachNode<unknown>): readonly Flat[] {
    const items = read(node.items);
    const seen = new Set<string | number>();
    const out: Flat[] = [];

    items.forEach((item, index) => {
        const key = node.key(item, index);

        // A duplicate key is a bug that produces wrong reordering rather than a visible error, so
        // it is caught here where it is cheap rather than in a renderer where it is not.
        if (seen.has(key)) {
            throw new Error(
                `each(): duplicate key ${JSON.stringify(key)} at index ${index}. ` +
                `Keys must be unique within one list.`,
            );
        }
        seen.add(key);

        for (const flat of flatten(node.render(() => item, () => index))) {
            out.push(flat.kind === 'element' && flat.key === undefined ? { ...flat, key } : flat);
        }
    });

    return out;
}

// ---------------------------------------------------------------------------- test helpers

/** Every element with this component name, depth first. */
export function findAll(tree: readonly Flat[], component: string): readonly FlatElement[] {
    const out: FlatElement[] = [];
    for (const node of tree) {
        if (node.kind !== 'element') continue;
        if (node.component === component) out.push(node);
        out.push(...findAll(node.children, component));
    }
    return out;
}

/** The concatenated text of a tree, which is usually what a test wants to assert on. */
export function textOf(tree: readonly Flat[]): string {
    return tree
        .map((node) => (node.kind === 'text' ? node.value : textOf(node.children)))
        .join('');
}
