/**
 * Reading and merging manifests.
 *
 * spec/kernel.md section 3, steps 3-5. Everything a contribution declares is read off the
 * constructed instance before anything activates, merged, and its conflicts resolved *here* — two
 * Applications claiming `ctrl+n` is a load-time problem, not a first-keypress problem.
 *
 * The payoff is that after this runs, the palette and the keymap are populated for contributions
 * that have not started, which is what lets a key press start one.
 */

import type {
    CommandDecl, Declarations, KeyDecl, MenuDecl, SettingDecl, ViewDecl,
} from '../contribution/contract.js';

export interface Contributed<T> {
    readonly by: string;
    readonly decl: T;
}

export interface Conflict {
    readonly kind: 'command' | 'binding' | 'setting' | 'view';
    readonly key: string;
    readonly claimants: readonly string[];
    readonly message: string;
}

export interface Manifest {
    readonly commands: ReadonlyMap<string, Contributed<CommandDecl>>;
    /** Keyed by the binding itself — `ctrl+n`, `gamepad:Y` — because that is what collides. */
    readonly bindings: ReadonlyMap<string, Contributed<KeyDecl>>;
    readonly menus: readonly Contributed<MenuDecl>[];
    readonly settings: ReadonlyMap<string, Contributed<SettingDecl>>;
    /** Keyed `<contributor>/<view id>`; view ids are scoped, so two Applications may both have `main`. */
    readonly views: ReadonlyMap<string, Contributed<ViewDecl>>;
    readonly conflicts: readonly Conflict[];
}

export function mergeManifests(
    contributions: readonly { readonly id: string; readonly declarations: Declarations }[],
): Manifest {
    const commands = new Map<string, Contributed<CommandDecl>>();
    const bindings = new Map<string, Contributed<KeyDecl>>();
    const menus: Contributed<MenuDecl>[] = [];
    const settings = new Map<string, Contributed<SettingDecl>>();
    const views = new Map<string, Contributed<ViewDecl>>();
    const conflicts: Conflict[] = [];

    const claim = <T>(
        map: Map<string, Contributed<T>>,
        key: string,
        by: string,
        decl: T,
        kind: Conflict['kind'],
        describe: (key: string, first: string, second: string) => string,
    ): void => {
        const existing = map.get(key);
        if (existing !== undefined) {
            conflicts.push({
                kind,
                key,
                claimants: [existing.by, by],
                message: describe(key, existing.by, by),
            });
            return; // first claim stands; the conflict is reported, not silently resolved
        }
        map.set(key, { by, decl });
    };

    for (const { id, declarations } of contributions) {
        for (const decl of declarations.commands ?? []) {
            claim(commands, decl.id, id, decl, 'command', (key, first, second) =>
                `Command "${key}" is declared by both ${first} and ${second}. Command ids are global.`);
        }

        for (const decl of declarations.keys ?? []) {
            for (const binding of bindingKeys(decl)) {
                claim(bindings, binding, id, decl, 'binding', (key, first, second) =>
                    `Binding "${key}" is claimed by ${first} and ${second}. ` +
                    `Resolved here rather than on the first keypress.`);
            }
        }

        for (const decl of declarations.menus ?? []) {
            menus.push({ by: id, decl });
        }

        for (const decl of declarations.settings ?? []) {
            claim(settings, decl.path, id, decl, 'setting', (key, first, second) =>
                `Setting "${key}" is declared by both ${first} and ${second}.`);
        }

        for (const decl of declarations.views ?? []) {
            claim(views, `${id}/${decl.id}`, id, decl, 'view', (key, first, second) =>
                `View "${key}" is declared twice, by ${first} and ${second}.`);
        }
    }

    // A menu item pointing at a command nobody declared is a dangling reference, and finding it
    // here is the difference between a broken menu entry and a puzzling one.
    for (const item of menus) {
        if (!commands.has(item.decl.command)) {
            conflicts.push({
                kind: 'command',
                key: item.decl.command,
                claimants: [item.by],
                message: `${item.by} put "${item.decl.title}" in a menu pointing at command ` +
                    `"${item.decl.command}", which nothing declares.`,
            });
        }
    }

    for (const [binding, entry] of bindings) {
        if (!commands.has(entry.decl.command)) {
            conflicts.push({
                kind: 'binding',
                key: binding,
                claimants: [entry.by],
                message: `${entry.by} bound "${binding}" to command "${entry.decl.command}", ` +
                    `which nothing declares.`,
            });
        }
    }

    return { commands, bindings, menus, settings, views, conflicts };
}

/** One declaration may bind several devices to one command. Each is a separate collision surface. */
function bindingKeys(decl: KeyDecl): readonly string[] {
    const out: string[] = [];
    if (decl.keys !== undefined) out.push(decl.keys);
    if (decl.gamepad !== undefined) out.push(`gamepad:${decl.gamepad}`);
    if (decl.gesture !== undefined) out.push(`gesture:${decl.gesture}`);
    return out;
}
