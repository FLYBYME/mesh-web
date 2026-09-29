/**
 * Loading, failed, or here — the three states of anything fetched, drawn the same way everywhere.
 *
 * A function, not a component: it has no state of its own. That is the rule this folder follows —
 * a design-system piece is a component only when it remembers something (a table's sort, a
 * dialog's openness); otherwise it is a function returning nodes, and costs nothing to call.
 */

import { each, element, text, when, type Node, type Resource } from '@flybyme/mesh-web';

export function loaded<T>(resource: Resource<T>, ready: (data: () => T) => Node, label = 'Loading…'): Node {
    return [
        when(() => resource.error() !== null, () => element('Text', {
            props: { role: 'alert', class: 'ui-error' },
            children: [text(() => resource.error()?.message ?? '')],
        })),
        when(() => resource.error() === null && resource.data() === undefined, () => element('Text', {
            props: { 'aria-busy': 'true', class: 'ui-loading' },
            children: [text(label)],
        })),
        // One constant key: the content is built once, and follows refetches through `data`
        // rather than being rebuilt — so a refetch after an edit does not reset what is inside.
        each(() => { const data = resource.data(); return data === undefined ? [] : [data]; }, () => 'data', ready),
    ];
}

/** Functions for text that follows state — an empty search result names the current search. */
export function emptyState(title: string | (() => string), detail?: string | (() => string), action?: Node): Node {
    return element('Stack', {
        props: { class: 'ui-empty', 'data-empty': '' },
        children: [
            element('Heading', { props: { level: 3 }, children: [text(title)] }),
            ...(detail === undefined ? [] : [element('Text', { children: [text(detail)] })]),
            ...(action === undefined ? [] : [action]),
        ],
    });
}

export function pageHeader(title: string | (() => string), actions: readonly Node[] = []): Node {
    return element('Row', {
        props: { class: 'ui-page-header' },
        children: [
            element('Heading', { props: { level: 1 }, children: [text(title)] }),
            element('Row', { props: { class: 'ui-actions' }, children: actions }),
        ],
    });
}
