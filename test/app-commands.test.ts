/**
 * Phase 3 (docs/app-model.md §7): a command lives exactly as long as its owner. Found on the
 * instance when the runtime constructs it, live — palette entry and key — until it is disposed.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { element, type Action, type Node } from '../src/index.js';
import {
    App, Component, command, CommandSchemaError, createAppRuntime, Service, View,
    type HandlerRegistry, type KeyPress, type LiveCommand,
} from '../src/app/index.js';

const handlers: HandlerRegistry = {
    on: (): Action => ({ kind: 'handler', id: 'unused' }),
    off: () => undefined,
};

function press(chord: { key: string; alt?: boolean; ctrl?: boolean }): KeyPress & { prevented: boolean } {
    return {
        key: chord.key,
        altKey: chord.alt ?? false,
        ctrlKey: chord.ctrl ?? false,
        shiftKey: false,
        metaKey: false,
        prevented: false,
        preventDefault() { this.prevented = true; },
    };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const nothing = (): Node => element('Stack', { children: [] });
const titles = (live: readonly LiveCommand[]): string[] => live.map((l) => `${l.owner}: ${l.command.title}`);

// ---------------------------------------------------------------------------- units

const ran: string[] = [];

class Clipboard extends Service({}) {
    readonly clear = command({ title: 'Clear clipboard', run: () => { ran.push('clear'); } });
}

class Records extends View({ inject: { clipboard: Clipboard } }) {
    readonly add = command({ title: 'New record', key: 'alt+k', run: () => { ran.push('records:add'); } });
    render(): Node { return nothing(); }
}

class Editor extends Component({}) {
    readonly add = command({ title: 'New field', key: 'alt+k', run: () => { ran.push('editor:add'); } });
    render(): Node { return nothing(); }
}

class Site extends App({ services: [Clipboard], routes: { '/records': Records } }) {
    readonly help = command({ title: 'Help', key: 'alt+h', run: () => { ran.push('help'); } });
}

// ---------------------------------------------------------------------------- tests

describe('commands live as long as their owners', () => {
    it('lists a service\'s and the app\'s commands for the life of the page', () => {
        const runtime = createAppRuntime(Site, {});
        expect(titles(runtime.commands.live())).toEqual(['Clipboard: Clear clipboard', 'Site: Help']);
        runtime.dispose();
        expect(runtime.commands.live()).toEqual([]);
    });

    it('makes a view\'s command live while it is mounted, and its key with it', () => {
        ran.length = 0;
        const runtime = createAppRuntime(Site, {});
        const node = runtime.view(Records, {}, handlers);

        expect(runtime.commands.handle(press({ key: 'k', alt: true }))).toBe(false);

        const unit = node.instantiate();
        expect(titles(runtime.commands.live())).toContain('Records: New record');
        const pressed = press({ key: 'k', alt: true });
        expect(runtime.commands.handle(pressed)).toBe(true);
        expect(pressed.prevented).toBe(true);
        expect(ran).toEqual(['records:add']);

        unit.dispose();
        expect(titles(runtime.commands.live())).not.toContain('Records: New record');
        expect(runtime.commands.handle(press({ key: 'k', alt: true }))).toBe(false);
        expect(ran).toEqual(['records:add']);
        runtime.dispose();
    });

    it('lets the newest owner of a key win, and hands the key back when it goes', () => {
        ran.length = 0;
        const runtime = createAppRuntime(Site, {});
        const records = runtime.view(Records, {}, handlers).instantiate();
        const editor = runtime.component(Editor, {}, handlers).instantiate();

        runtime.commands.handle(press({ key: 'k', alt: true }));
        editor.dispose();
        runtime.commands.handle(press({ key: 'k', alt: true }));
        expect(ran).toEqual(['editor:add', 'records:add']);

        records.dispose();
        runtime.dispose();
    });

    it('refuses a browser-reserved chord when the owner mounts, and leaves nothing half-registered', () => {
        class Greedy extends Component({}) {
            readonly add = command({ title: 'New window', key: 'ctrl+n', run: () => undefined });
            readonly ok = command({ title: 'Fine', key: 'alt+f', run: () => undefined });
            render(): Node { return nothing(); }
        }
        const runtime = createAppRuntime(Site, {});
        const before = runtime.commands.live().length;
        expect(() => runtime.component(Greedy, {}, handlers).instantiate()).toThrow(/ctrl\+n, which the browser already answers/);
        expect(runtime.commands.live()).toHaveLength(before);
        runtime.dispose();
    });

    it('refuses a chord the kernel\'s window commands already answer', () => {
        // alt+n minimises the window. Before this refusal existed, a component bound to it ran its
        // command *and* minimised — the phase 3 browser test found it by losing every later click.
        class Clash extends Component({}) {
            readonly add = command({ title: 'New', key: 'alt+n', run: () => undefined });
            render(): Node { return nothing(); }
        }
        const runtime = createAppRuntime(Site, {});
        expect(() => runtime.component(Clash, {}, handlers).instantiate())
            .toThrow(/alt\+n, which the kernel's window\.minimize already answers/);
        runtime.dispose();
    });

    it('runs a keyed command that takes input with {}, so its schema\'s defaults decide', async () => {
        const got: unknown[] = [];
        class Defaults extends Component({}) {
            readonly go = command({
                title: 'Go',
                key: 'alt+g',
                input: z.object({ page: z.number().default(1) }),
                run: (input) => { got.push(input); },
            });
            render(): Node { return nothing(); }
        }
        const runtime = createAppRuntime(Site, {});
        const unit = runtime.component(Defaults, {}, handlers).instantiate();
        runtime.commands.handle(press({ key: 'g', alt: true }));
        await settle();
        expect(got).toEqual([{ page: 1 }]);
        unit.dispose();
        runtime.dispose();
    });

    it('reports a keyed command that fails — never an unhandled rejection', async () => {
        const errors: unknown[] = [];
        class Strict extends Component({}) {
            readonly go = command({
                title: 'Needs a name',
                key: 'alt+s',
                input: z.object({ name: z.string() }),
                run: () => undefined,
            });
            readonly boom = command({ title: 'Boom', key: 'alt+b', run: () => { throw new Error('boom'); } });
            render(): Node { return nothing(); }
        }
        const runtime = createAppRuntime(Site, {}, { commands: { onError: (e) => errors.push(e) } });
        const unit = runtime.component(Strict, {}, handlers).instantiate();

        runtime.commands.handle(press({ key: 's', alt: true }));
        runtime.commands.handle(press({ key: 'b', alt: true }));
        await settle();

        expect(errors[0]).toBeInstanceOf(CommandSchemaError);
        expect(errors[1]).toEqual(new Error('boom'));
        unit.dispose();
        runtime.dispose();
    });
});
