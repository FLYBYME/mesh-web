/**
 * A form for a command: fields in, `command.run(input)` out, errors beside the fields they are about.
 *
 * **The rules live on the command, once.** The form knows labels and control types; whether an email
 * is an email, a TTL is at least 60, or an A record's value is an IPv4 address is the command's input
 * schema, which the command enforces before anything is sent. When it refuses, its issues come back
 * with paths (`CommandSchemaError.issues`), and each goes beside its field. So a rule is written
 * once, and every form, keyboard command and API caller of that command gets it.
 *
 * Generic over the command's input, so it is a factory for the same reason `dataTable` is: the
 * field list is checked against the input's keys when the form is declared.
 *
 * A form needs the command *object*, and commands are instance fields — so a form is declared where
 * an instance is at hand: a component makes its form class once, in a field, from its injected
 * service (`pages/sign-in.view.ts`).
 */

import {
    CommandSchemaError, Component, each, element, props, signal, text, when,
    type Command, type Node,
} from '@flybyme/mesh-web';

export interface Field {
    readonly label: string;
    readonly type?: 'text' | 'email' | 'password' | 'number';
    /** Renders a select with these choices instead of an input. */
    readonly options?: readonly string[];
    readonly placeholder?: string;
    readonly autocomplete?: string;
}

/** A field per input key the person fills in. Keys the caller fixes (`fixed`) are left out. */
export type Fields<I> = { readonly [K in keyof I & string]?: Field };

export interface CommandFormProps<I, O> {
    /** Values the person does not choose — the domain a record is being added to. */
    readonly fixed?: Partial<I>;
    readonly initial?: Partial<Record<keyof I & string, string>>;
    readonly submitLabel?: string;
    readonly onDone?: (result: O) => void;
}

export function commandForm<I extends object, O>(command: Command<I, O>, fields: Fields<I>) {
    const names = Object.keys(fields);

    return class CommandForm extends Component({ props: props<CommandFormProps<I, O>>() }) {
        readonly values = signal<Readonly<Record<string, string>>>({ ...this.props.initial });
        readonly problems = signal<Readonly<Record<string, string>>>({});
        readonly problem = signal<string | undefined>(undefined);

        render(): Node {
            return element('Form', {
                props: { class: 'ui-form', 'aria-label': command.title, novalidate: true },
                intents: { commit: { action: this.on(() => void this.submit()), preventDefault: true } },
                children: [
                    ...names.map((name) => this.field(name)),
                    when(() => this.problem() !== undefined, () => element('Text', {
                        props: { role: 'alert', class: 'ui-error' },
                        children: [text(() => this.problem() ?? '')],
                    })),
                    element('Button', {
                        props: { type: 'submit', disabled: () => command.running() },
                        children: [text(() => (command.running() ? 'Working…' : this.props.submitLabel ?? command.title))],
                    }),
                ],
            });
        }

        field(name: string): Node {
            const field = fieldOf(fields, name);
            const id = `f-${command.title.replace(/\W+/g, '-')}-${name}`.toLowerCase();
            const value = (): string => this.values()[name] ?? '';
            const change = this.on((v) => this.values.set({ ...this.values(), [name]: typeof v === 'string' ? v : String(v ?? '') }));
            const described = { 'aria-invalid': () => this.problems()[name] !== undefined, 'aria-describedby': `${id}-problem` };

            const control = field.options === undefined
                ? element('Input', {
                    props: {
                        id, name, type: field.type ?? 'text', value,
                        ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
                        ...(field.autocomplete === undefined ? {} : { autocomplete: field.autocomplete }),
                        ...described,
                    },
                    intents: { change: { action: change } },
                })
                : element('Select', {
                    props: { id, name, value, ...described },
                    intents: { change: { action: change } },
                    children: [each(field.options, (o) => o, (o) => element('Option', { props: { value: o() }, children: [text(o)] }))],
                });

            return element('Stack', {
                props: { class: 'ui-field' },
                children: [
                    element('Label', { props: { for: id }, children: [text(field.label)] }),
                    control,
                    element('Text', {
                        props: { id: `${id}-problem`, class: 'ui-field-problem', 'data-problem-for': name },
                        children: [text(() => this.problems()[name] ?? '')],
                    }),
                ],
            });
        }

        async submit(): Promise<void> {
            this.problems.set({});
            this.problem.set(undefined);
            try {
                // Strings from the DOM are not an `I` until the command's schema says so: `submit`.
                const result = await command.submit({ ...this.values(), ...this.props.fixed });
                this.values.set({ ...this.props.initial });
                this.props.onDone?.(result);
            } catch (error) {
                this.report(error);
            }
        }

        report(error: unknown): void {
            if (error instanceof CommandSchemaError && error.side === 'input' && error.issues.length > 0) {
                const byField: Record<string, string> = {};
                const elsewhere: string[] = [];
                for (const issue of error.issues) {
                    const [first] = issue.path;
                    if (typeof first === 'string' && names.includes(first)) byField[first] ??= issue.message;
                    else elsewhere.push(issue.message);
                }
                this.problems.set(byField);
                if (elsewhere.length > 0) this.problem.set(elsewhere.join(' '));
                return;
            }
            this.problem.set(error instanceof Error ? error.message : String(error));
        }
    };
}

function fieldOf<I>(fields: Fields<I>, name: string): Field {
    const entry = Object.entries(fields).find(([key]) => key === name)?.[1];
    if (!isField(entry)) throw new Error(`No field "${name}".`);
    return entry;
}

function isField(value: unknown): value is Field {
    return typeof value === 'object' && value !== null && 'label' in value;
}
