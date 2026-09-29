/**
 * A command is one object: title, key, schemas and implementation, defined as a field on whatever
 * owns it (docs/app-model.md §7). There is no `implement` and no id to keep in step — the object is
 * the command.
 *
 * Finding a mounted unit's commands and binding their keys is the kernel's job (phase 3). What is
 * here already works on its own: input is validated before `run`, output after, and `running` is a
 * signal a button can read.
 */

import { signal } from '../reactivity/index.js';
import type { ReadonlySignal } from '../reactivity/index.js';
import type { Infer, InferInput, SchemaLike } from './types.js';

export interface CommandInfo {
    readonly title: string;
    /** A binding like `mod+n`. Live while the command's owner is. */
    readonly key?: string;
    readonly description?: string;
}

/** `I` is what a caller passes (the schema's input side); `run`'s own parameter is the parsed output. */
export interface Command<I, O> extends CommandInfo {
    readonly input?: SchemaLike<unknown>;
    readonly output?: SchemaLike<O>;
    readonly running: ReadonlySignal<boolean>;
    run(...args: [I] extends [void] ? [] : [input: I]): Promise<O>;
}

/** Thrown when input or output does not match the command's schema. The message is the schema's. */
export class CommandSchemaError extends Error {
    constructor(
        readonly command: string,
        readonly side: 'input' | 'output',
        message: string,
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
        if (!result.success) throw new CommandSchemaError(spec.title, side, result.error.message);
        return result.data;
    };

    return {
        title: spec.title,
        ...(spec.key !== undefined ? { key: spec.key } : {}),
        ...(spec.description !== undefined ? { description: spec.description } : {}),
        ...(spec.input !== undefined ? { input: spec.input } : {}),
        ...(spec.output !== undefined ? { output: spec.output } : {}),
        running,
        async run(...args: unknown[]): Promise<unknown> {
            const input = check('input', spec.input, args[0]);
            running.set(true);
            try {
                return check('output', spec.output, await spec.run(input));
            } finally {
                running.set(false);
            }
        },
    };
}
