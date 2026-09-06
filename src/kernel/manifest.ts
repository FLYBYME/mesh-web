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
    CommandDecl, Declarations, KeyDecl, MenuDecl, SettingDecl, StoreDecl, ViewDecl,
} from '../contribution/contract.js';
import type { AnyApiCall, Api } from '../net/api.js';
import type { LayoutNode } from '../window/layout.js';
import { BROWSER_TAB_RESERVED, normalizeBinding, reservedSet } from '../input/keys.js';

export interface Contributed<T> {
    readonly by: string;
    readonly decl: T;
}

export interface Conflict {
    readonly kind: 'command' | 'binding' | 'setting' | 'view' | 'store';
    readonly key: string;
    readonly claimants: readonly string[];
    readonly message: string;
}

export interface Manifest {
    readonly commands: ReadonlyMap<string, Contributed<CommandDecl>>;
    /** Keyed by the binding itself — `ctrl+n`, `gamepad:Y` — because that is what collides. */
    readonly bindings: ReadonlyMap<string, Contributed<KeyDecl>>;
    readonly menus: readonly Contributed<MenuDecl>[];
    /**
     * Every API a site's contributions declare, known before any of them runs.
     *
     * spec/network.md section 4: this is the list a review, a CSP or an audit wants, and the point
     * of declaring the API rather than constructing a client inside `start()` is that it can be read
     * without executing anything.
     */
    readonly apis: readonly Contributed<Api<Record<string, AnyApiCall>>>[];
    /**
     * Each Application's tiled arrangement, by contributor id.
     *
     * Here rather than on the running process because the kernel restores geometry at boot step 9
     * and starts Applications at step 10 — the tile names have to be known before anything runs
     * (spec/application.md §6).
     */
    readonly layouts: ReadonlyMap<string, LayoutNode>;
    readonly settings: ReadonlyMap<string, Contributed<SettingDecl>>;
    readonly stores: ReadonlyMap<string, Contributed<StoreDecl>>;
    /** Keyed `<contributor>/<view id>`; view ids are scoped, so two Applications may both have `main`. */
    readonly views: ReadonlyMap<string, Contributed<ViewDecl>>;
    readonly conflicts: readonly Conflict[];
}

export function mergeManifests(
    contributions: readonly { readonly id: string; readonly declarations: Declarations }[],
    /**
     * Bindings the host takes first (spec/input.md §7.1).
     *
     * A parameter rather than a constant: a page in a browser tab loses `ctrl+n` and `ctrl+w`, an
     * Electron shell loses far less, and a kiosk owns the whole keyboard. Defaults to a browser tab
     * because that is where this runs today and the safe default is the most restrictive one.
     */
    reservedBindings: readonly string[] = BROWSER_TAB_RESERVED,
): Manifest {
    const reserved = reservedSet(reservedBindings);
    const commands = new Map<string, Contributed<CommandDecl>>();
    const bindings = new Map<string, Contributed<KeyDecl>>();
    const menus: Contributed<MenuDecl>[] = [];
    const apis: Contributed<Api<Record<string, AnyApiCall>>>[] = [];
    const layouts = new Map<string, LayoutNode>();
    const settings = new Map<string, Contributed<SettingDecl>>();
    const stores = new Map<string, Contributed<StoreDecl>>();
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
            const invalid = (spec: string, reason: string): void => void conflicts.push({
                kind: 'binding',
                key: spec,
                claimants: [id],
                message: `${id} declared the binding "${spec}", which is not one: ${reason}`,
            });

            for (const binding of bindingKeys(decl, invalid)) {
                // spec/input.md §7.1: a binding the host takes first is a load-time conflict, not a
                // binding that half works. `ctrl+n` fires the command *and* opens a browser window,
                // which looks like it worked and is worse than not firing.
                if (reserved.has(binding)) {
                    conflicts.push({
                        kind: 'binding',
                        key: binding,
                        claimants: [id],
                        message:
                            `${id} bound "${binding}" to "${decl.command}", and the host takes that ` +
                            `binding first — preventDefault on it is ignored. The command would fire ` +
                            `*and* the host would act, which looks like it worked. Bind something else; ` +
                            `the command stays reachable by its other bindings and from the palette.`,
                    });
                    continue;
                }

                claim(bindings, binding, id, decl, 'binding', (key, first, second) =>
                    `Binding "${key}" is claimed by ${first} and ${second}. ` +
                    `Resolved here rather than on the first keypress.`);
            }
        }

        for (const decl of declarations.menus ?? []) {
            menus.push({ by: id, decl });
        }

        // Not a claim on a shared name, so no conflict: two Applications may talk to the same API,
        // and two APIs may coexist because a client is scoped to the one that declared it.
        if (declarations.api !== undefined) apis.push({ by: id, decl: declarations.api });

        // Keyed by contributor rather than merged: two Applications have two arrangements, and
        // whichever is in the foreground supplies the one in force. Nothing collides.
        if (declarations.layout !== undefined) layouts.set(id, declarations.layout);

        for (const decl of declarations.settings ?? []) {
            claim(settings, decl.path, id, decl, 'setting', (key, first, second) =>
                `Setting "${key}" is declared by both ${first} and ${second}.`);
        }

        for (const decl of declarations.stores ?? []) {
            claim(stores, `${id}/${decl.name}`, id, decl, 'store', (_key, first) =>
                `Store "${decl.name}" is declared twice by ${first}.`);
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

    return { commands, bindings, menus, apis, layouts, settings, stores, views, conflicts };
}

/**
 * One declaration may bind several devices to one command. Each is a separate collision surface.
 *
 * Keyboard bindings go through `normalizeBinding`, so `Shift+Ctrl+P` and `ctrl+shift+p` are one
 * entry and therefore collide. Without that they are two strings, two entries, and two Applications
 * both believing they own the shortcut — which is the same class of bug as roadmap A1.4, where a
 * configurable binding was compared against a literal and silently never fired.
 *
 * A binding that cannot be parsed is reported rather than dropped: an Application declaring
 * `ctrl++n` should be told, not quietly given no shortcut.
 */
function bindingKeys(decl: KeyDecl, onInvalid: (spec: string, reason: string) => void): readonly string[] {
    const out: string[] = [];

    if (decl.keys !== undefined) {
        try {
            out.push(normalizeBinding(decl.keys));
        } catch (error) {
            onInvalid(decl.keys, error instanceof Error ? error.message : String(error));
        }
    }

    if (decl.gamepad !== undefined) out.push(`gamepad:${decl.gamepad}`);
    if (decl.gesture !== undefined) out.push(`gesture:${decl.gesture}`);
    return out;
}
