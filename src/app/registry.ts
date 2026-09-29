/**
 * The live command registry (docs/app-model.md §7, phase 3).
 *
 * A command lives exactly as long as the unit that owns it. The runtime calls `add` when it
 * constructs a unit and the returned function when it disposes one; between those, the unit's
 * commands are listed in `live` (what a palette shows) and their keys resolve.
 *
 * **Two live commands on one key: the most recently added wins,** and the earlier one is back the
 * moment the later one's owner goes. That is right for a single-page site, where the newest thing on
 * screen is the one in front. In the windowed mode, "in front" means the focused window, which the
 * runtime cannot see yet — phase 4 (the router) is where windows arrive and that rule gets refined.
 */

import { BROWSER_TAB_RESERVED, chordOf, formatBinding, KERNEL_WINDOW_BINDINGS, normalizeBinding } from '../input/keys.js';
import { signal, type ReadonlySignal } from '../reactivity/index.js';
import { isCommand, type AnyCommand } from './command.js';

export interface LiveCommand {
    /** The class that owns it, for a palette and for errors. */
    readonly owner: string;
    readonly command: AnyCommand;
    /**
     * The window it lives in, for a view or component mounted in one. Absent for a service's or the
     * app's, which belong to the page and answer whichever window is in front.
     */
    readonly scope?: string;
}

/** What a key listener hands over. A `KeyboardEvent` is one; so is a test's plain object. */
export interface KeyPress {
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
    readonly target?: unknown;
    preventDefault(): void;
}

export interface CommandRegistryOptions {
    /**
     * Chords the host keeps for itself. Defaults to what a browser tab loses (`BROWSER_TAB_RESERVED`).
     * The kernel's own window bindings (`KERNEL_WINDOW_BINDINGS`) are refused whatever this says —
     * they are always listening.
     */
    readonly reserved?: readonly string[];
    /** A keyed command that failed. Never left as an unhandled rejection. Defaults to `console.error`. */
    readonly onError?: (error: unknown, command: LiveCommand) => void;
    /**
     * Which window is in front, on a desktop. When given, a key reaches only the commands of that
     * window and the page's own (services, the app) — never a window behind it. Absent on a
     * single-page site, where the newest owner of a key is the one in front.
     */
    readonly inFront?: () => string | undefined;
}

export interface CommandRegistry {
    /** Every live command, oldest first. A palette reads this. */
    readonly live: ReadonlySignal<readonly LiveCommand[]>;
    /** Make an instance's commands live, in a window if `scope` names one. Returns the function that makes them not. */
    add(owner: string, instance: object, scope?: string): () => void;
    /** The command a key press would run, if any. */
    resolve(press: KeyPress): LiveCommand | undefined;
    /** Run the command bound to this key press. Returns whether one was bound. */
    handle(press: KeyPress): boolean;
    /** Listen for key presses on a document. Returns the function that stops listening. */
    attach(target: Pick<Document, 'addEventListener' | 'removeEventListener'>): () => void;
}

export function createCommandRegistry(options: CommandRegistryOptions = {}): CommandRegistry {
    /** chord → who already answers it. */
    const taken = new Map<string, string>();
    for (const chord of options.reserved ?? BROWSER_TAB_RESERVED) taken.set(normalizeBinding(chord), 'the browser');
    for (const { binding, command } of KERNEL_WINDOW_BINDINGS) taken.set(normalizeBinding(binding), `the kernel's ${command}`);
    const onError = options.onError ?? ((error: unknown, entry: LiveCommand) => {
        console.error(`${entry.owner}: "${entry.command.title}" failed`, error);
    });
    const live = signal<readonly LiveCommand[]>([]);

    const resolve = (press: KeyPress): LiveCommand | undefined => {
        const chord = formatBinding(chordOf(press));
        const front = options.inFront?.();
        const entries = live();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (entry?.command.key !== chord) continue;
            // On a desktop, a window behind the focused one does not hear keys.
            if (options.inFront !== undefined && entry.scope !== undefined && entry.scope !== front) continue;
            return entry;
        }
        return undefined;
    };

    const handle = (press: KeyPress): boolean => {
        // A binding must never eat what somebody is typing — except a chord with a modifier, which is
        // not text by definition. The same rule as the kernel's own key listener (kernel/start.ts).
        if (isTextField(press.target) && !press.ctrlKey && !press.metaKey && !press.altKey) return false;

        const entry = resolve(press);
        if (entry === undefined) return false;

        press.preventDefault();
        // A keyed command with an input schema is run with `{}`: its schema's defaults decide whether
        // that is enough, and if it is not, the schema's refusal is what gets reported.
        const input = entry.command.input === undefined ? undefined : {};
        entry.command.run(input).catch((error: unknown) => onError(error, entry));
        return true;
    };

    return {
        live,
        add(owner, instance, scope) {
            const commands = Object.values(instance).filter(isCommand);
            if (commands.length === 0) return () => undefined;

            for (const command of commands) {
                const holder = command.key === undefined ? undefined : taken.get(command.key);
                if (holder !== undefined) {
                    throw new Error(
                        `${owner}: "${command.title}" is bound to ${command.key}, which ${holder} already answers — ` +
                        `pressing it would run both. Pick another chord.`,
                    );
                }
            }

            const added = commands.map((command): LiveCommand => (scope === undefined ? { owner, command } : { owner, command, scope }));
            live.set([...live(), ...added]);
            return () => {
                live.set(live().filter((entry) => !added.includes(entry)));
            };
        },
        resolve,
        handle,
        attach(target) {
            const listener = (event: KeyboardEvent): void => { handle(event); };
            target.addEventListener('keydown', listener);
            return () => { target.removeEventListener('keydown', listener); };
        },
    };
}

function isTextField(target: unknown): boolean {
    if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
    return target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName);
}
