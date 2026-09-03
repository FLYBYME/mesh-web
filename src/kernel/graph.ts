/**
 * The provider graph: what activates before what.
 *
 * spec/extension.md section 5. Order Extensions by their `consumes` against others' `provides`,
 * then activate in that order.
 *
 * Three rules, and the first two are where most of the value is:
 *
 *   A cycle is a boot failure, reported naming both ends. Not broken by lazy proxies — a cycle
 *   between two Extensions is a design error, and hiding it produces a system whose behaviour
 *   depends on load order.
 *
 *   An unresolved `consumes` fails that Extension, not boot, and cascades to its own consumers as
 *   one error naming the root.
 *
 *   Order among independent Extensions is undefined, and deliberately so: anything depending on it
 *   has an undeclared dependency and should declare it.
 */

import type { Declarations } from '../contribution/contract.js';

export interface GraphNode {
    readonly id: string;
    readonly declarations: Declarations;
}

export interface Ordered {
    /** Activation order. Independent nodes keep input order, which keeps tests readable. */
    readonly order: readonly string[];
    /** id → why it cannot activate. Its consumers are failed too, naming the same root. */
    readonly unresolvable: ReadonlyMap<string, string>;
}

export function resolveOrder(nodes: readonly GraphNode[]): Ordered {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const providerOf = new Map<string, string>();

    for (const node of nodes) {
        const token = node.declarations.provides;
        if (token === undefined) continue;

        const existing = providerOf.get(token.id);
        if (existing !== undefined) {
            throw new Error(
                `Provider "${token.id}" is offered by both ${existing} and ${node.id}. ` +
                `Two contributors providing one token is a conflict to resolve at load time.`,
            );
        }
        providerOf.set(token.id, node.id);
    }

    const unresolvable = new Map<string, string>();
    const order: string[] = [];
    const state = new Map<string, 'visiting' | 'done'>();
    const path: string[] = [];

    const visit = (id: string): boolean => {
        if (state.get(id) === 'done') return !unresolvable.has(id);

        if (state.get(id) === 'visiting') {
            const from = path.indexOf(id);
            const cycle = [...path.slice(from), id].join(' → ');
            throw new Error(
                `Provider cycle: ${cycle}. A cycle between contributions is a design error, and ` +
                `breaking it with a lazy proxy would make behaviour depend on load order.`,
            );
        }

        state.set(id, 'visiting');
        path.push(id);

        const node = byId.get(id)!;
        for (const token of node.declarations.consumes ?? []) {
            const providerId = providerOf.get(token.id);

            if (providerId === undefined) {
                unresolvable.set(id, `no contribution provides "${token.id}"`);
                continue;
            }

            if (!visit(providerId)) {
                unresolvable.set(
                    id,
                    `depends on ${providerId}, which failed: ${unresolvable.get(providerId)}`,
                );
            }
        }

        path.pop();
        state.set(id, 'done');
        order.push(id);
        return !unresolvable.has(id);
    };

    for (const node of nodes) visit(node.id);

    return { order, unresolvable };
}
