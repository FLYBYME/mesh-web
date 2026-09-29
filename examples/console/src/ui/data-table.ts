/**
 * A table of typed rows, with sortable columns.
 *
 * **Generic, so it is a factory.** `Component({ props: props<T>() })` fixes its props when the class
 * is declared, and a class cannot be generic *and* hand its type parameter to the expression it
 * extends. So the generic part is a function that declares the class, called once per row type at
 * module level:
 *
 * ```ts
 * const DomainTable = dataTable<Domain>();
 * this.mount(DomainTable, { rows, key: (d) => d.name, columns: [...] })
 * ```
 *
 * Every column's `cell` is then checked against `Domain` — no `unknown`, no casts at the call site.
 *
 * The rows are the caller's — the table never fetches, filters or pages. Sorting is either the
 * table's own state (all rows on screen: `compare`) or the caller's (paged rows: `sortKey` plus a
 * controlled `sort`). A component, because in the first case it remembers something.
 */

import {
    Component, each, element, props, signal, text, type Node,
} from '@flybyme/mesh-web';

export interface Column<Row> {
    readonly header: string;
    readonly cell: (row: () => Row) => Node;
    /** Sortable here, in the table: right when every row is on screen. */
    readonly compare?: (a: Row, b: Row) => number;
    /** Sortable by whoever owns the rows (see `DataTableProps.sort`): right when they are paged. */
    readonly sortKey?: string;
    readonly align?: 'start' | 'end';
}

export interface Sort {
    readonly key: string;
    readonly direction: 1 | -1;
}

export interface DataTableProps<Row> {
    /** The table's accessible name. */
    readonly label: string;
    readonly rows: () => readonly Row[];
    readonly key: (row: Row) => string;
    readonly columns: readonly Column<Row>[];
    /**
     * A controlled sort. Given, the table only shows it and reports clicks; the owner sorts. A
     * paged list must: sorting one page of a server-paged list sorts the wrong rows. Absent, columns
     * with `compare` sort in the table, and the sort is this instance's state.
     */
    readonly sort?: {
        readonly current: () => Sort | undefined;
        change(next: Sort): void;
    };
}

export function dataTable<Row>() {
    return class DataTable extends Component({ props: props<DataTableProps<Row>>() }) {
        readonly localSort = signal<Sort | undefined>(undefined);

        readonly current = (): Sort | undefined => this.props.sort?.current() ?? this.localSort();

        readonly sorted = (): readonly Row[] => {
            const rows = this.props.rows();
            if (this.props.sort !== undefined) return rows;
            const sort = this.localSort();
            const compare = this.props.columns.find((c) => c.header === sort?.key)?.compare;
            if (sort === undefined || compare === undefined) return rows;
            return [...rows].sort((a, b) => compare(a, b) * sort.direction);
        };

        render(): Node {
            const { columns, key, label } = this.props;
            return element('Table', {
                props: { class: 'ui-table', 'aria-label': label },
                children: [
                    element('TableHead', {
                        children: [element('TableRow', { children: columns.map((column) => this.#header(column)) })],
                    }),
                    element('TableBody', {
                        children: [each(this.sorted, key, (row) => element('TableRow', {
                            children: columns.map((column) => element('TableCell', {
                                props: { 'data-align': column.align ?? 'start' },
                                children: [column.cell(row)],
                            })),
                        }))],
                    }),
                ],
            });
        }

        // `#`, not `private`: a class returned from a function cannot declare TS-private members.
        #header(column: Column<Row>): Node {
            const controlled = this.props.sort;
            // Controlled columns are named by `sortKey`; local ones by their header.
            const key = controlled === undefined
                ? (column.compare === undefined ? undefined : column.header)
                : column.sortKey;
            if (key === undefined) {
                return element('TableHeaderCell', { props: { scope: 'col' }, children: [text(column.header)] });
            }
            const direction = (): 1 | -1 | undefined => {
                const sort = this.current();
                return sort?.key === key ? sort.direction : undefined;
            };
            const toggle = (): void => {
                const next: Sort = { key, direction: direction() === 1 ? -1 : 1 };
                if (controlled === undefined) this.localSort.set(next);
                else controlled.change(next);
            };
            return element('TableHeaderCell', {
                props: {
                    scope: 'col',
                    'aria-sort': () => {
                        const d = direction();
                        return d === undefined ? 'none' : d === 1 ? 'ascending' : 'descending';
                    },
                },
                children: [element('Button', {
                    props: { class: 'ui-sort' },
                    intents: {
                        activate: {
                            action: this.on(toggle),
                        },
                    },
                    children: [text(() => {
                        const d = direction();
                        return `${column.header}${d === undefined ? '' : d === 1 ? ' ▲' : ' ▼'}`;
                    })],
                })],
            });
        }
    };
}
