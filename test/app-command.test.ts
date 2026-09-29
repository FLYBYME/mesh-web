/**
 * `command()` from the app model (docs/app-model.md §7): the part of phase 1 that runs.
 * Kernel discovery and key binding are phase 3; this is the object on its own.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { command, CommandSchemaError } from '../src/app/index.js';

describe('command()', () => {
    const create = command({
        title: 'Create record',
        input: z.object({ name: z.string().min(1), ttl: z.number().default(300) }),
        output: z.object({ id: z.string(), ttl: z.number() }),
        run: async ({ name, ttl }) => ({ id: `rec-${name}`, ttl }),
    });

    it('runs with parsed input — schema defaults applied before run sees it', async () => {
        await expect(create.run({ name: 'www', ttl: 60 })).resolves.toEqual({ id: 'rec-www', ttl: 60 });
        // `ttl` omitted: the zod default is applied by the parse, so the input type says optional.
        await expect(create.run({ name: 'api' })).resolves.toEqual({ id: 'rec-api', ttl: 300 });
    });

    it('rejects bad input before run is called', async () => {
        let called = false;
        const guarded = command({
            title: 'Guarded',
            input: z.object({ name: z.string().min(1) }),
            run: () => { called = true; },
        });
        await expect(guarded.run({ name: '' })).rejects.toBeInstanceOf(CommandSchemaError);
        expect(called).toBe(false);
    });

    it('rejects output that does not match the output schema', async () => {
        const lying = command({
            title: 'Lying',
            output: z.object({ id: z.string() }),
            // Typed correctly, wrong at run time — the case a server response actually produces.
            run: () => JSON.parse('{"id": 7}') as { id: string },
        });
        const error = await lying.run().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CommandSchemaError);
        expect((error as CommandSchemaError).side).toBe('output');
    });

    it('says it is running while it runs, and stops even when run throws', async () => {
        let release: () => void = () => undefined;
        const slow = command({ title: 'Slow', run: () => new Promise<void>((r) => { release = r; }) });

        const pending = slow.run();
        expect(slow.running()).toBe(true);
        release();
        await pending;
        expect(slow.running()).toBe(false);

        const failing = command({ title: 'Failing', run: () => { throw new Error('boom'); } });
        await expect(failing.run()).rejects.toThrow('boom');
        expect(failing.running()).toBe(false);
    });

    it('carries its title and key for whatever lists it', () => {
        const add = command({ title: 'New record', key: 'mod+n', run: () => undefined });
        expect(add.title).toBe('New record');
        expect(add.key).toBe('mod+n');
    });
});
