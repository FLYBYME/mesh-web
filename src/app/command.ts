/**
 * A command is one object: title, key, schemas and implementation, defined as a field on whatever
 * owns it (docs/app-model.md §7). There is no `implement` and no id to keep in step — the object is
 * the command.
 *
 * On its own a command validates input before `run` and output after, and `running` is a signal a
 * button can read. The runtime finds a unit's commands when it constructs the unit — any own field
 * holding one — and makes them live, keys included, until the unit is disposed (`registry.ts`).
 */

import { normalizeBinding } from '../input/keys.js';
import { signal } from '../reactivity/index.js';
import type { ReadonlySignal } from '../reactivity/index.js';
import type { Infer, InferInput, SchemaIssue, SchemaLike } from './types.js';

/** Marks an object made by `command()`, so the runtime can find commands among a unit's fields. */
export const COMMAND = Symbol('mesh.command');

export interface CommandInfo {
    readonly title: string;
    /**
     * A binding like `alt+n` — live while the command's owner is. Checked when the command is made:
     * a binding that cannot parse throws here rather than never firing. (There is no `mod`; and a
     * browser-reserved chord like `ctrl+n` is refused when the owner mounts.)
     */
    readonly key?: string;
    readonly description?: string;
}

/** `I` is what a caller passes (the schema's input side); `run`'s own parameter is the parsed output. */
export interface Command<I, O> extends CommandInfo {
    readonly [COMMAND]: true;
    readonly input?: SchemaLike<unknown>;
    readonly output?: SchemaLike<O>;
    readonly running: ReadonlySignal<boolean>;
    run(...args: [I] extends [void] ? [] : [input: I]): Promise<O>;
    /**
     * Run with input from outside the type system — a form's strings, a palette, a URL. The input
     * schema is the only check, and it is the same check `run` makes: `run` is for code that has an
     * `I`; this is for code that has only what a person typed. A refusal is a `CommandSchemaError`
     * whose `issues` say which field.
     */
    submit(raw: unknown): Promise<O>;
}

/** A command with its types erased — what the registry holds. */
export type AnyCommand = Command<unknown, unknown>;

export function isCommand(value: unknown): value is AnyCommand {
    return typeof value === 'object' && value !== null && COMMAND in value;
}

/** Thrown when input or output does not match the command's schema. The message is the schema's. */
export class CommandSchemaError extends Error {
    constructor(
        readonly command: string,
        readonly side: 'input' | 'output',
        message: string,
        /** Per-field problems, when the schema itemises them — what a form shows beside each field. */
        readonly issues: readonly SchemaIssue[] = [],
    ) {
        super(`${command}: ${side} rejected — ${message}`);
        this.name = 'CommandSchemaError';
    }
}

/** `O` is what the command resolves to; `run` may return it directly or as a promise. */
export function command<IS extends SchemaLike<unknown>, O>(
    spec: CommandInfo & {
        readonly input: IS;
        readonly output?: SchemaLike<O>;
        run(input: Infer<IS>): O | Promise<O>;
    },
): Command<InferInput<IS>, O>;
export function command<O>(
    spec: CommandInfo & {
        readonly input?: undefined;
        readonly output?: SchemaLike<O>;
        run(): O | Promise<O>;
    },
): Command<void, O>;
export function command(
    spec: CommandInfo & {
        readonly input?: SchemaLike<unknown>;
        readonly output?: SchemaLike<unknown>;
        run(input?: unknown): unknown;
    },
): Command<unknown, unknown> {
    const running = signal(false);

    const check = (side: 'input' | 'output', schema: SchemaLike<unknown> | undefined, value: unknown): unknown => {
        if (schema === undefined) return value;
        const result = schema.safeParse(value);
        if (!result.success) throw new CommandSchemaError(spec.title, side, result.error.message, result.error.issues);
        return result.data;
    };

    const execute = async (raw: unknown): Promise<unknown> => {
        const input = check('input', spec.input, raw);
        running.set(true);
        try {
            return check('output', spec.output, await spec.run(input));
        } finally {
            running.set(false);
        }
    };

    return {
        [COMMAND]: true,
        title: spec.title,
        ...(spec.key !== undefined ? { key: normalizeBinding(spec.key) } : {}),
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        ...(spec.input !== undefined ? { input: spec.input } : {}),
        ...(spec.output !== undefined ? { output: spec.output } : {}),
        running,
        run: (...args: unknown[]) => execute(args[0]),
        submit: execute,
    };
}
