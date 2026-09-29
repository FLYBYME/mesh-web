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
 * The sort is this instance's own state: a component, because it remembers something. The rows are
 * the caller's — the table never fetches, filters or pages.
 */

import {
    Component, each, element, props, signal, text, type Node,
} from '@flybyme/mesh-web';

export interface Column<Row> {
    readonly header: string;
    readonly cell: (row: () => Row) => Node;
    /** Makes the column sortable. */
    readonly compare?: (a: Row, b: Row) => number;
    readonly align?: 'start' | 'end';
}

export interface DataTableProps<Row> {
    /** The table's accessible name. */
    readonly label: string;
    readonly rows: () => readonly Row[];
    readonly key: (row: Row) => string;
    readonly columns: readonly Column<Row>[];
}

export function dataTable<Row>() {
    return class DataTable extends Component({ props: props<DataTableProps<Row>>() }) {
        readonly sortBy = signal<{ readonly column: number; readonly direction: 1 | -1 } | undefined>(undefined);

        readonly sorted = (): readonly Row[] => {
            const rows = this.props.rows();
            const sort = this.sortBy();
            const compare = sort === undefined ? undefined : this.props.columns[sort.column]?.compare;
            if (sort === undefined || compare === undefined) return rows;
            return [...rows].sort((a, b) => compare(a, b) * sort.direction);
        };

        render(): Node {
            const { columns, key, label } = this.props;
            return element('Table', {
                props: { class: 'ui-table', 'aria-label': label },
                children: [
                    element('TableHead', {
                        children: [element('TableRow', { children: columns.map((column, i) => this.#header(column, i)) })],
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
        #header(column: Column<Row>, index: number): Node {
            if (column.compare === undefined) {
                return element('TableHeaderCell', { props: { scope: 'col' }, children: [text(column.header)] });
            }
            const direction = (): 1 | -1 | undefined => {
                const sort = this.sortBy();
                return sort?.column === index ? sort.direction : undefined;
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
                            action: this.on(() => this.sortBy.set({ column: index, direction: direction() === 1 ? -1 : 1 })),
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
