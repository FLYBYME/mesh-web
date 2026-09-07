/**
 * @vitest-environment jsdom
 *
 * The confirmation capability — the reader `destructive` never had.
 *
 * Two things are under test and only one of them is the dialog. The other is the property that
 * makes the capability worth having: **the asker cannot answer its own question.** A confirmation
 * whose caller holds the resolver is decoration that reads like a safety property, which is worse
 * than not having one.
 */

import { describe, expect, it, vi } from 'vitest';

import { Kernel, createServices, needs, provider } from '../src/index.js';
import type { Application, Context, ProviderToken } from '../src/index.js';
import { domConfirm } from '../src/kernel/confirm.js';

const NEEDS = needs('confirmation');

interface Asker {
    ask(message: string): Promise<boolean>;
    askDestructive(): Promise<boolean>;
}

const ASKER: ProviderToken<Asker> = provider<Asker>('asker');

class AskingApp implements Application<typeof NEEDS, readonly [], typeof ASKER> {
    readonly needs = NEEDS;
    readonly provides = ASKER;

    async start(cx: Context<typeof NEEDS, readonly []>): Promise<Asker> {
        return {
            ask: (message) => cx.confirmation.ask(message),
            askDestructive: () => cx.confirmation.ask({
                message: 'Delete every release?',
                destructive: true,
            }),
        };
    }
}

const kernelWith = async (confirm: Parameters<typeof createServices>[1] extends undefined
    ? never
    : NonNullable<Parameters<typeof createServices>[1]>['confirm']): Promise<Asker> => {
    const services = createServices(undefined, { confirm });
    const kernel = new Kernel({ services });
    kernel.boot([{ id: 'asker', contribution: new AskingApp() as never }]);
    await kernel.start('asker');
    const asker = kernel.provided(ASKER);
    if (asker === undefined) throw new Error('expected asker to be provided');
    return asker;
};

describe('asking a person', () => {
    it('returns what the page answered', async () => {
        const asker = await kernelWith(async () => true);
        expect(await asker.ask('proceed?')).toBe(true);
    });

    it('stamps who is asking, from the kernel and not from the caller', async () => {
        const seen: unknown[] = [];
        const asker = await kernelWith(async (request) => { seen.push(request); return true; });

        await asker.ask('proceed?');

        // `requester` is the contribution's own id. A part cannot claim to be another part, which
        // is the same rule `notifications` and `commands` follow.
        expect(seen[0]).toMatchObject({ message: 'proceed?', requester: 'asker' });
    });

    it('carries the destructive hint through to the page', async () => {
        const seen: { destructive?: boolean }[] = [];
        const asker = await kernelWith(async (request) => { seen.push(request); return false; });

        await asker.askDestructive();
        expect(seen[0]?.destructive).toBe(true);
    });

    /**
     * The default, and it is deliberately not "yes". A kernel with no page cannot ask anybody
     * anything — most of this repository's tests, and every prerender. Answering `true` there
     * would make an unattended run behave as though somebody had agreed.
     */
    it('refuses by default, because a question nobody was asked was not agreed to', async () => {
        const services = createServices(undefined, {});
        const kernel = new Kernel({ services });
        kernel.boot([{ id: 'asker', contribution: new AskingApp() as never }]);
        await kernel.start('asker');

        const asker = kernel.provided(ASKER);
        if (asker === undefined) throw new Error('expected asker to be provided');
        expect(await asker.ask('proceed?')).toBe(false);
    });

    it('treats a prompter that throws as a refusal', async () => {
        const asker = await kernelWith(async () => { throw new Error('the dialog was torn down'); });
        expect(await asker.ask('proceed?')).toBe(false);
    });

    it('treats anything that is not exactly true as a refusal', async () => {
        const asker = await kernelWith(async () => 'yes' as unknown as boolean);
        expect(await asker.ask('proceed?')).toBe(false);
    });
});

describe('the dialog the page draws', () => {
    it('resolves true when the confirm button is pressed', async () => {
        const answer = domConfirm(document)({ message: 'proceed?', requester: 'catalog' });
        await vi.waitFor(() => expect(document.querySelector('.mesh-confirm')).not.toBeNull());

        document.querySelector<HTMLButtonElement>('.mesh-confirm-ok')!.click();
        expect(await answer).toBe(true);
        expect(document.querySelector('.mesh-confirm')).toBeNull();
    });

    it('resolves false when cancelled, and removes itself either way', async () => {
        const answer = domConfirm(document)({ message: 'proceed?', requester: 'catalog' });
        await vi.waitFor(() => expect(document.querySelector('.mesh-confirm')).not.toBeNull());

        document.querySelector<HTMLButtonElement>('.mesh-confirm-cancel')!.click();
        expect(await answer).toBe(false);
        expect(document.querySelector('.mesh-confirm')).toBeNull();
    });

    it('shows who is asking', async () => {
        const answer = domConfirm(document)({ message: 'proceed?', requester: 'catalog' });
        await vi.waitFor(() => expect(document.querySelector('.mesh-confirm')).not.toBeNull());

        expect(document.querySelector('.mesh-confirm-source')?.textContent).toBe('asked by catalog');
        document.querySelector<HTMLButtonElement>('.mesh-confirm-cancel')!.click();
        await answer;
    });

    it('refuses when there is no document to draw on', async () => {
        expect(await domConfirm(undefined)({ message: 'proceed?', requester: 'catalog' })).toBe(false);
    });
});
