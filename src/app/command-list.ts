/**
 * `CommandList`: every live command on the page, for a unit that shows them (a palette).
 *
 * A service like any other, wired by the runtime the way `Router` is. Injected, so what a page can
 * see is declared the same way as everything else it uses.
 */

import { computed } from '../reactivity/index.js';
import type { CommandRegistry, LiveCommand } from './registry.js';
import { Service } from './units.js';

const registries = new WeakMap<object, CommandRegistry>();

/** Kernel side: give a constructed `CommandList` its page's registry. Not for app code. */
export function attachCommandList(list: object, registry: CommandRegistry): void {
    registries.set(list, registry);
}

export class CommandList extends Service({}) {
    /** Oldest first, and current: a command leaves when its owner does. */
    readonly live = computed((): readonly LiveCommand[] => registries.get(this)?.live() ?? []);
}
