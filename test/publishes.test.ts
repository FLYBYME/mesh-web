/**
 * **A part's published surface matches what it declared.**
 *
 * The manifest is read before anything runs, so a declaration is what a site, a review, a generated
 * client and a tool caller all learn a part's surface from. That makes the two failure directions
 * different in kind rather than symmetric:
 *
 * - **Declared, not bound** is an advertisement for something that is not there. It fails at the
 *   first call — possibly weeks later, possibly in front of somebody — rather than at load.
 * - **Bound, not declared** is a surface nobody can discover, review, or grant against. It works,
 *   which is why it survives.
 *
 * Both are refused at start, which is the only moment both halves are known.
 */

import { describe, expect, it } from 'vitest';

import { Kernel } from '../src/kernel/kernel.js';
import { needs } from '../src/contribution/capabilities.js';
import { provider, type ProviderToken } from '../src/contribution/provider.js';
import { AVAILABLE, checkBindings, schema, type ApiDecl, type PartApi } from '../src/contribution/api.js';
import type { Application, Context } from '../src/contribution/contract.js';
import { KEEPS_NOTHING } from '../src/contribution/contract.js';

const NEEDS = needs();
const THING: ProviderToken<PartApi> = provider<PartApi>('test/thing');

/** One command, declared. The tests below vary only what `start()` binds against it. */
const renameDecl: ApiDecl = {
    commands: [{
        action: 'rename',
        description: 'Gives the thing a different name.',
        input: schema<{ name: string }>(),
        output: schema<void>(),
        available: () => AVAILABLE,
    }],
};

const boundRename = (): PartApi => ({
    commands: {
        rename: {
            action: 'rename',
            description: 'Gives the thing a different name.',
            input: schema<never>(),
            output: schema<never>(),
            available: () => AVAILABLE,
            run: async () => undefined as never,
        },
    },
    components: {},
    state: {},
});

const load = (id: string, contribution: object): { id: string; contribution: never } =>
    ({ id, contribution: contribution as never });

describe('what a part declared is what it bound', () => {
    it('accepts a part whose bindings match its manifest', () => {
        expect(() => checkBindings(renameDecl, boundRename(), 'ok')).not.toThrow();
    });

    it('refuses a declared command with no implementation, and names it', () => {
        const empty: PartApi = { commands: {}, components: {}, state: {} };

        expect(() => checkBindings(renameDecl, empty, 'thing'))
            .toThrow(/command "rename" is declared and not bound/);
    });

    it('refuses a bound command nobody declared, and names it', () => {
        expect(() => checkBindings({}, boundRename(), 'thing'))
            .toThrow(/command "rename" is bound and not declared/);
    });

    it('reports every mismatch at once, rather than the first', () => {
        // A part with three problems should learn all three. Fixing one at a time, restarting each
        // time, is how a five-minute correction becomes an afternoon.
        const declared: ApiDecl = {
            commands: [
                { action: 'a', description: 'A.', input: schema<void>(), output: schema<void>(), available: () => AVAILABLE },
                { action: 'b', description: 'B.', input: schema<void>(), output: schema<void>(), available: () => AVAILABLE },
            ],
            state: [{ name: 'rows', description: 'The rows.', schema: schema<readonly string[]>() }],
        };

        let message = '';
        try {
            checkBindings(declared, { commands: {}, components: {}, state: {} }, 'thing');
        } catch (error) {
            message = (error as Error).message;
        }

        expect(message).toContain('command "a" is declared and not bound');
        expect(message).toContain('command "b" is declared and not bound');
        expect(message).toContain('state "rows" is declared and not bound');
    });

    it('asks nothing of a part that publishes nothing', () => {
        // The ordinary case. A part with no `publishes` is not made to prove a negative.
        expect(() => checkBindings({}, undefined, 'quiet')).not.toThrow();
    });
});

describe('the kernel enforces it at start', () => {
    it('leaves a part failed when it declares a command it does not bind', async () => {
        class Liar implements Application<typeof NEEDS> {
            readonly needs = NEEDS;
            readonly publishes = renameDecl;
            async start(_cx: Context<typeof NEEDS>): Promise<typeof KEEPS_NOTHING> {
                // Declares `rename` in its manifest and binds nothing.
                return KEEPS_NOTHING;
            }
        }

        const kernel = new Kernel();
        kernel.boot([load('liar', new Liar())]);
        await kernel.start('liar').catch(() => undefined);

        const process = kernel.processes.find((p) => p.applicationId === 'liar');

        // `failed` is a resting state, not a disappearance — the part is still there to be looked
        // at, which is the whole point of not throwing it away on error.
        expect(process?.state).toBe('failed');
    });

    it('starts a part whose bindings match', async () => {
        // `provides` and not only `publishes`: the token is how a consumer reaches the API, so a
        // part that publishes without one has described a surface nobody can hold. Worth a check of
        // its own — noted rather than built here, because it is a different rule.
        class Honest implements Application<typeof NEEDS, readonly [], typeof THING> {
            readonly needs = NEEDS;
            readonly provides = THING;
            readonly publishes = renameDecl;
            async start(_cx: Context<typeof NEEDS>): Promise<{ api: PartApi } & typeof KEEPS_NOTHING> {
                return { ...KEEPS_NOTHING, api: boundRename() };
            }
        }

        const kernel = new Kernel();
        kernel.boot([load('honest', new Honest())]);
        await kernel.start('honest');

        const process = kernel.processes.find((p) => p.applicationId === 'honest');
        expect(process?.state).toBe('running');
    });
});
