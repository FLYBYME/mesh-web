/**
 * One hotkey parser — roadmap A1.4 and A3.4.
 *
 * The bug this exists to make impossible is concrete and shipped: the old task switcher compared a
 * *configurable* binding against the literal `` 'ctrl+`' ``, so any other binding silently never
 * fired. mesh-api issue #7, and the single most specific thing carried out of the deleted code.
 *
 * The fix is structural rather than careful: one function turns a declaration into a normal form,
 * one turns an event into the same normal form, and comparing anything else is not a thing the
 * module makes easy.
 */

import { describe, expect, it } from 'vitest';

import {
    BROWSER_TAB_RESERVED, InvalidBinding, Kernel, bindingTable, chordOf, formatBinding,
    isGamepad, mergeManifests, normalizeBinding, parseBinding, reservedSet,
    type Application,
} from '../src/index.js';

/** A KeyboardEvent's shape, without needing a DOM to make one. */
const press = (key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) => ({
    key,
    ctrlKey: mods.ctrl ?? false,
    altKey: mods.alt ?? false,
    shiftKey: mods.shift ?? false,
    metaKey: mods.meta ?? false,
});

describe('a binding has one spelling', () => {
    it('does not care about modifier order or case', () => {
        // Two people writing the same shortcut differently must produce one entry and therefore
        // collide — rather than both appearing to work and one silently losing.
        for (const spec of ['ctrl+shift+p', 'Shift+Ctrl+P', 'SHIFT+ctrl+P', 'shift+ctrl+p']) {
            expect(normalizeBinding(spec)).toBe('ctrl+shift+p');
        }
    });

    it('accepts the spellings people actually write', () => {
        expect(normalizeBinding('cmd+k')).toBe('meta+k');
        expect(normalizeBinding('command+k')).toBe('meta+k');
        expect(normalizeBinding('option+n')).toBe('alt+n');
        expect(normalizeBinding('control+a')).toBe('ctrl+a');
        expect(normalizeBinding('Esc')).toBe('escape');
        expect(normalizeBinding('Return')).toBe('enter');
        expect(normalizeBinding('Up')).toBe('arrowup');
        expect(normalizeBinding('ctrl+Space')).toBe('ctrl+space');
    });

    it('reads a bare key and a lone plus', () => {
        expect(normalizeBinding('escape')).toBe('escape');
        expect(normalizeBinding('+')).toBe('+');
        expect(normalizeBinding('ctrl++')).toBe('ctrl++');
    });

    it('reads a gamepad button', () => {
        const binding = parseBinding('gamepad:Y');
        expect(isGamepad(binding)).toBe(true);
        expect(formatBinding(binding)).toBe('gamepad:Y');
    });

    it('refuses what is not a binding, rather than producing one that never fires', () => {
        expect(() => parseBinding('')).toThrow(InvalidBinding);
        expect(() => parseBinding('ctrl')).toThrow(/only modifiers/);
        expect(() => parseBinding('ctrl+a+b')).toThrow(/two keys/);
        expect(() => parseBinding('gamepad:')).toThrow(/no gamepad button/);
    });
});

describe('an event and a declaration meet in the same normal form', () => {
    it('matches a chord however the declaration was spelled', () => {
        const table = bindingTable([{ binding: 'Shift+Ctrl+P', command: 'palette.open' }]);

        // This is A1.4 in one assertion. The old code compared the configured binding against a
        // literal; here both sides are normalised, so the *declared* spelling cannot matter.
        expect(table.resolve(press('P', { ctrl: true, shift: true }))).toBe('palette.open');
        expect(table.resolve(press('p', { ctrl: true, shift: true }))).toBe('palette.open');
    });

    it('does not match when a modifier differs', () => {
        const table = bindingTable([{ binding: 'alt+n', command: 'blog.add' }]);

        expect(table.resolve(press('n', { alt: true }))).toBe('blog.add');
        expect(table.resolve(press('n'))).toBeUndefined();
        expect(table.resolve(press('n', { alt: true, shift: true }))).toBeUndefined();
        expect(table.resolve(press('n', { ctrl: true }))).toBeUndefined();
    });

    it('answers what a command is bound to, so a menu need not be told twice', () => {
        const table = bindingTable([
            { binding: 'alt+n', command: 'blog.add' },
            { binding: 'meta+n', command: 'blog.add' },
            { binding: 'alt+t', command: 'blog.mode' },
        ]);

        expect(table.forCommand('blog.add')).toEqual(['alt+n', 'meta+n']);
        expect(table.forCommand('nothing.bound')).toEqual([]);
    });

    it('normalises an event the same way it normalises a declaration', () => {
        expect(formatBinding(chordOf(press('Escape')))).toBe('escape');
        expect(formatBinding(chordOf(press(' ', { ctrl: true })))).toBe('ctrl+space');
        expect(formatBinding(chordOf(press('ArrowLeft', { alt: true })))).toBe('alt+arrowleft');
    });
});

describe('bindings the host takes first', () => {
    it('knows the ones a browser tab never gives up', () => {
        const reserved = reservedSet();
        expect(reserved.has('ctrl+n')).toBe(true);
        expect(reserved.has('ctrl+w')).toBe(true);
        expect(reserved.has('alt+n')).toBe(false);
    });

    it('normalises the reserved list too, so a differently-spelled binding is still caught', () => {
        // Declaring `N+Ctrl` must not sneak past a check that only knows the string `ctrl+n`.
        expect(reservedSet(['Ctrl+N']).has(normalizeBinding('n+ctrl'))).toBe(true);
    });

    it('is a property of the host, not of the framework', () => {
        // A kiosk or an Electron shell owns the whole keyboard. spec/input.md §7.1.
        expect(reservedSet([]).size).toBe(0);
        expect(BROWSER_TAB_RESERVED.length).toBeGreaterThan(0);
    });
});

describe('the manifest refuses a binding that would half-work', () => {
    const app = (id: string, keys: string): { id: string; declarations: { commands: { id: string; title: string }[]; keys: { command: string; keys: string }[] } } => ({
        id,
        declarations: {
            commands: [{ id: `${id}.act`, title: 'Act' }],
            keys: [{ command: `${id}.act`, keys }],
        },
    });

    it('reports a reserved binding as a load-time conflict, and does not bind it', () => {
        const manifest = mergeManifests([app('blog', 'ctrl+n')]);

        // The command would fire *and* the browser would open a window. That looks like it worked,
        // which is worse than not firing — so it is refused where every other conflict is.
        const conflict = manifest.conflicts.find((c) => c.kind === 'binding');
        expect(conflict?.key).toBe('ctrl+n');
        expect(conflict?.message).toMatch(/takes that binding first/);
        expect(manifest.bindings.has('ctrl+n')).toBe(false);
    });

    it('binds it when the host does not reserve it', () => {
        const manifest = mergeManifests([app('blog', 'ctrl+n')], []);

        expect(manifest.conflicts).toHaveLength(0);
        expect(manifest.bindings.get('ctrl+n')?.decl.command).toBe('blog.act');
    });

    it('collides on the normal form, not on the string', () => {
        // Two Applications, two spellings, one shortcut. Without normalising in the manifest these
        // are two entries and both authors believe they own it.
        const manifest = mergeManifests([app('a', 'ctrl+shift+p'), app('b', 'Shift+Ctrl+P')]);

        const conflict = manifest.conflicts.find((c) => c.kind === 'binding');
        expect(conflict?.claimants).toEqual(['a', 'b']);
        expect(manifest.bindings.size).toBe(1);
    });

    it('reports a binding that is not one rather than dropping it', () => {
        const manifest = mergeManifests([app('blog', 'ctrl+')]);

        // An Application that declared nonsense gets told, instead of quietly having no shortcut.
        expect(manifest.conflicts[0]?.message).toMatch(/which is not one/);
    });
});

describe('the kernel exposes what is bound', () => {
    it('resolves a keypress to a command through the manifest', async () => {
        const NEEDS = [] as const;

        class Blog implements Application<typeof NEEDS> {
            readonly needs = NEEDS;
            readonly commands = [{ id: 'blog.add', title: 'New post' }];
            readonly keys = [{ command: 'blog.add', keys: 'Alt+N' }];
            async start(): Promise<void> {}
        }

        const kernel = new Kernel();
        kernel.boot([{ id: 'blog', contribution: new Blog() as never }]);

        // Declared `Alt+N`, stored as `alt+n`, and reached from an event that says `n` — three
        // spellings, one binding, which is the whole point.
        const table = bindingTable(
            [...kernel.manifest.bindings].map(([binding, entry]) => ({ binding, command: entry.decl.command })),
        );

        expect(table.resolve(press('n', { alt: true }))).toBe('blog.add');
    });
});
