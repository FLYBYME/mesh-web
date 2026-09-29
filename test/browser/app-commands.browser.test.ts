/**
 * Phase 3 in a real browser: a component's keyed command works while the component is on screen
 * and not after, with the keys arriving through CDP — the way a person's would — rather than a
 * synthesised `KeyboardEvent`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import '../../src/kernel.css';
import {
    element, needs, signal, text, when,
    type Application, type Context, type Node, type ViewContext,
} from '../../src/index.js';
import { App, command, Component, createAppRuntime, View, type AppRuntime } from '../../src/app/index.js';
import { cleanup, mountPart, type MountedSite } from '../../src/testing/index.js';

// ---------------------------------------------------------------------------- the app model side

class Tally extends Component({}) {
    readonly count = signal(0);
    readonly bump = command({ title: 'Bump', key: 'alt+k', run: () => this.count.set(this.count() + 1) });

    render(): Node {
        return element('Text', { props: { 'data-tally': '' }, children: [text(() => `tally ${this.count()}`)] });
    }
}

class Page extends View({}) {
    readonly shown = signal(true);
    render(): Node {
        return element('Stack', {
            children: [
                element('Input', { props: { 'aria-label': 'notes' } }),
                element('Button', {
                    props: { 'aria-label': 'toggle tally' },
                    intents: { activate: { action: this.on(() => this.shown.set(!this.shown())) } },
                    children: [text('Toggle')],
                }),
                when(() => this.shown(), () => this.mount(Tally)),
            ],
        });
    }
}

class KeysApp extends App({ routes: { '/': Page } }) {}

// ---------------------------------------------------------------------------- the bridge

interface BridgeState { readonly runtime: AppRuntime }
const NEEDS = needs('windows');

class Bridge implements Application<typeof NEEDS, readonly [], undefined, never, BridgeState> {
    readonly needs = NEEDS;
    readonly views = [{
        id: 'main',
        title: 'Keys',
        render: (vx: ViewContext<Record<string, never>, BridgeState>) =>
            vx.internal.runtime.view(Page, {}, { on: vx.on, off: vx.off }),
    }];

    async start(cx: Context<typeof NEEDS, readonly []>): Promise<{ internal: BridgeState }> {
        const runtime = createAppRuntime(KeysApp, cx);
        current = runtime;
        cx.onDispose(runtime.commands.attach(document));
        cx.onDispose(() => runtime.dispose());
        cx.windows.open({ view: 'main' });
        return { internal: { runtime } };
    }
}

// ---------------------------------------------------------------------------- the test

let site: MountedSite | undefined;
let current: AppRuntime | undefined;
afterEach(() => { cleanup(); site = undefined; current = undefined; });

const liveTitles = (): string[] => (current?.commands.live() ?? []).map((l) => l.command.title);

/**
 * Whether the next keydown reached any live command. The registry calls `preventDefault` when one
 * runs; a bubbling listener added after it sees that.
 */
function pressedNowhere(): () => boolean {
    let prevented = false;
    const listener = (event: KeyboardEvent): void => { if (event.key === 'k') prevented ||= event.defaultPrevented; };
    document.addEventListener('keydown', listener);
    return () => {
        document.removeEventListener('keydown', listener);
        return prevented;
    };
}

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
const tally = (): string | null => site?.root.querySelector('[data-tally]')?.textContent ?? null;

function find(label: string): HTMLElement {
    const el = site?.root.querySelector(`[aria-label="${label}"]`);
    if (!(el instanceof HTMLElement)) throw new Error(`nothing labelled "${label}"`);
    return el;
}

describe('keyed commands in a real browser', () => {
    it('work while their owner is on screen, and not after', async () => {
        site = await mountPart({ id: 'keys', contribution: Bridge });
        await frame();
        expect(tally()).toBe('tally 0');

        await userEvent.keyboard('{Alt>}k{/Alt}');
        await userEvent.keyboard('{Alt>}k{/Alt}');
        await frame();
        expect(tally()).toBe('tally 2');

        await userEvent.click(find('toggle tally'));
        await frame();
        expect(tally()).toBeNull();

        // The owner is gone, so its command is gone with it. Checked on the registry, because a press
        // reaching a disposed Tally would change nothing anyone can see.
        expect(liveTitles()).not.toContain('Bump');
        const seen = pressedNowhere();
        await userEvent.keyboard('{Alt>}k{/Alt}');
        expect(seen()).toBe(false);

        // Bringing a Tally back shows a fresh one, not the old count moved on — and its key is back.
        await userEvent.click(find('toggle tally'));
        await frame();
        expect(tally()).toBe('tally 0');
        expect(liveTitles()).toContain('Bump');
    });

    it('never takes a plain keystroke from a text field, but a modifier chord still works there', async () => {
        site = await mountPart({ id: 'keys', contribution: Bridge });
        await frame();

        await userEvent.click(find('notes'));
        await userEvent.keyboard('n');
        await frame();
        expect((find('notes') as HTMLInputElement).value).toBe('n');
        expect(tally()).toBe('tally 0');

        await userEvent.keyboard('{Alt>}k{/Alt}');
        await frame();
        expect(tally()).toBe('tally 1');
    });
});
