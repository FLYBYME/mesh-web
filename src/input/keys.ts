/**
 * One hotkey parser, and bindings are data.
 *
 * spec/roadmap A1.4, and the single most concrete thing carried out of the deleted code. The old
 * task switcher did this:
 *
 *     if (combo === 'ctrl+`') { ...switch tasks... }
 *
 * A binding was configurable, and the code compared it against a **literal**. So any binding other
 * than that one silently never fired — no error, no warning, a hotkey that simply did nothing.
 * mesh-api issue #7.
 *
 * The fix is not "be careful". It is that there is exactly one function that turns a *declared*
 * binding into a comparable value and exactly one that turns an *event* into one, and they are the
 * same normal form — so the only way to compare is to compare two normalised chords, and writing a
 * literal in a condition is not a thing this module makes easy.
 *
 * Everything here is pure. The device adapters (A8) sit on top; nothing below this line knows what
 * a `KeyboardEvent` is except the one function that takes one.
 */

/** A parsed key binding, in normal form. */
export interface Chord {
    /** Lowercased, and never a modifier. `a`, `enter`, `escape`, `arrowleft`, `` ` ``. */
    readonly key: string;
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
    /** Command on macOS, Windows key elsewhere. */
    readonly meta: boolean;
}

/** A gamepad button, which has no modifiers and no normal form beyond its name. */
export interface GamepadBinding {
    readonly gamepad: string;
}

export type Binding = Chord | GamepadBinding;

export const isGamepad = (binding: Binding): binding is GamepadBinding =>
    typeof (binding as GamepadBinding).gamepad === 'string';

/**
 * Names that mean the same key.
 *
 * Small on purpose: every alias is a way for two declarations to look different and collide anyway,
 * so the list holds only the spellings people actually write.
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
    esc: 'escape',
    return: 'enter',
    del: 'delete',
    ins: 'insert',
    space: ' ',
    spacebar: ' ',
    up: 'arrowup',
    down: 'arrowdown',
    left: 'arrowleft',
    right: 'arrowright',
    pgup: 'pageup',
    pgdn: 'pagedown',
};

const MODIFIERS: Readonly<Record<string, keyof Omit<Chord, 'key'>>> = {
    ctrl: 'ctrl',
    control: 'ctrl',
    alt: 'alt',
    option: 'alt',
    shift: 'shift',
    meta: 'meta',
    cmd: 'meta',
    command: 'meta',
    super: 'meta',
    win: 'meta',
};

export class InvalidBinding extends Error {}

/**
 * Parse a declared binding.
 *
 * `ctrl+shift+p`, `alt+n`, `escape`, `gamepad:Y`. Order does not matter and case does not matter —
 * `Shift+Ctrl+P` and `ctrl+shift+p` are the same binding, which is the point of a normal form: two
 * people writing the same shortcut differently must collide rather than both appearing to work.
 */
export function parseBinding(spec: string): Binding {
    const text = spec.trim();
    if (text === '') throw new InvalidBinding('An empty binding.');

    if (text.toLowerCase().startsWith('gamepad:')) {
        const button = text.slice('gamepad:'.length).trim();
        if (button === '') throw new InvalidBinding(`"${spec}" names no gamepad button.`);
        return { gamepad: button };
    }

    const parts = tokenize(text);
    if (parts.length === 0) throw new InvalidBinding(`"${spec}" is not a binding.`);

    let ctrl = false, alt = false, shift = false, meta = false;
    let key: string | undefined;

    for (const part of parts) {
        const lower = part.toLowerCase();
        const modifier = MODIFIERS[lower];

        if (modifier !== undefined) {
            if (modifier === 'ctrl') ctrl = true;
            else if (modifier === 'alt') alt = true;
            else if (modifier === 'shift') shift = true;
            else meta = true;
            continue;
        }

        if (key !== undefined) {
            throw new InvalidBinding(
                `"${spec}" names two keys ("${key}" and "${lower}"). A chord is modifiers plus one key.`,
            );
        }
        key = KEY_ALIASES[lower] ?? lower;
    }

    if (key === undefined) {
        throw new InvalidBinding(`"${spec}" is only modifiers. A chord needs a key to go with them.`);
    }

    return { key, ctrl, alt, shift, meta };
}

/**
 * Split a chord into modifiers and a key.
 *
 * `+` is both the separator and a key, which `split('+')` cannot express: `ctrl++` becomes
 * `['ctrl', '', '']` and the plus is gone. Written out rather than regexed because the rule is
 * small and stating it is clearer than matching it — **a `+` in the final position, straight after
 * a separator, is the plus key.**
 */
function tokenize(text: string): string[] {
    if (text === '+') return ['+'];

    const parts: string[] = [];
    let current = '';

    for (let i = 0; i < text.length; i++) {
        const char = text[i]!;

        if (char === '+') {
            if (current === '' && parts.length > 0 && i === text.length - 1) {
                parts.push('+');
                return parts;
            }
            if (current.trim() !== '') parts.push(current.trim());
            current = '';
            continue;
        }

        current += char;
    }

    if (current.trim() !== '') parts.push(current.trim());
    return parts;
}

/**
 * A keyboard event, in the same normal form.
 *
 * The counterpart to `parseBinding`, and the reason the comparison is safe: both sides arrive here,
 * so there is nothing to get subtly different.
 *
 * `event.key` rather than `event.code`, deliberately — a binding is a *character* the user meant,
 * so `alt+n` is alt and the N key on any layout rather than whatever sits where QWERTY keeps N.
 */
export function chordOf(event: {
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
}): Chord {
    return {
        key: KEY_ALIASES[event.key.toLowerCase()] ?? event.key.toLowerCase(),
        ctrl: event.ctrlKey,
        alt: event.altKey,
        shift: event.shiftKey,
        meta: event.metaKey,
    };
}

/**
 * A chord's canonical spelling — the key a binding table is keyed by.
 *
 * Modifiers always in this order, so `shift+ctrl+p` and `ctrl+shift+p` produce one string and
 * therefore one entry.
 */
export function formatBinding(binding: Binding): string {
    if (isGamepad(binding)) return `gamepad:${binding.gamepad}`;

    const parts: string[] = [];
    if (binding.ctrl) parts.push('ctrl');
    if (binding.alt) parts.push('alt');
    if (binding.shift) parts.push('shift');
    if (binding.meta) parts.push('meta');
    parts.push(binding.key === ' ' ? 'space' : binding.key);
    return parts.join('+');
}

/** Normalise a declared binding to its canonical spelling in one step. */
export const normalizeBinding = (spec: string): string => formatBinding(parseBinding(spec));

// ---------------------------------------------------------------------------- reserved

/**
 * Bindings a page cannot have, because the browser takes them first.
 *
 * spec/input.md §7.1. `preventDefault()` on these is ignored — they are handled before the page sees
 * the event — so a binding on one *fires the command and also does the browser's thing*, which is
 * worse than not firing at all because it looks like it worked.
 *
 * **A property of the host, not a constant of the framework.** A page in a tab loses far more than
 * the same framework in an Electron shell or a kiosk, which is why this is a value a host adapter
 * supplies rather than a list baked into the kernel.
 */
export const BROWSER_TAB_RESERVED: readonly string[] = [
    'ctrl+n', 'ctrl+t', 'ctrl+w', 'ctrl+shift+n', 'ctrl+shift+t', 'ctrl+shift+w',
    'ctrl+q', 'meta+n', 'meta+t', 'meta+w', 'meta+q',
    'f5', 'ctrl+r', 'meta+r',
];

/** Nothing is reserved. For an Electron shell or a kiosk that owns the whole keyboard. */
export const NOTHING_RESERVED: readonly string[] = [];

export function reservedSet(bindings: readonly string[] = BROWSER_TAB_RESERVED): ReadonlySet<string> {
    return new Set(bindings.map((b) => normalizeBinding(b)));
}

// ---------------------------------------------------------------------------- resolution

export interface BindingTable {
    /** The command bound to this event, if any. */
    resolve(event: Parameters<typeof chordOf>[0]): string | undefined;
    /** What a command is bound to, for a menu item or a tooltip. */
    forCommand(command: string): readonly string[];
    readonly size: number;
}

/**
 * Build a lookup from declared bindings.
 *
 * Both directions, because both are needed and computing one from the other at a call site is how
 * they drift: `resolve` for a keypress, `forCommand` so a menu can show `⌘K` beside the item without
 * anybody writing it twice.
 */
export function bindingTable(entries: readonly { binding: string; command: string }[]): BindingTable {
    const byBinding = new Map<string, string>();
    const byCommand = new Map<string, string[]>();

    for (const entry of entries) {
        const normal = normalizeBinding(entry.binding);
        byBinding.set(normal, entry.command);

        const list = byCommand.get(entry.command) ?? [];
        list.push(normal);
        byCommand.set(entry.command, list);
    }

    return {
        resolve: (event) => byBinding.get(formatBinding(chordOf(event))),
        forCommand: (command) => byCommand.get(command) ?? [],
        get size() { return byBinding.size; },
    };
}
