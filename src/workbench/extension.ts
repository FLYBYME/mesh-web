/**
 * The workbench — roadmap A6.3, spec/extension.md §8.
 *
 * > "i think i should be able to write an extention that would cover the 'workbench' idea too"
 *
 * This is that, and it is the point of the whole exercise. §8 calls it *the load-bearing test of the
 * whole design*: if the IDE shell cannot be written as an ordinary Extension over the window
 * manager, the capability split is wrong. Two things had to be built before it could exist —
 * `needs('chrome')`, because a workbench could previously see only its own windows (A6.3c), and a
 * window layer in the package at all, because until A6.3e the only shell lived in the demo.
 *
 * **What is not here is the argument.** There is no `Shell` object, no privileged import, no
 * reaching into the kernel, and no DOM. It declares four capabilities, returns a description, and
 * puts `cx.chrome.host()` where it wants the windows. Everything it does, an outside author can do —
 * which is the only honest test that the interfaces are usable, and the reason the built-ins are
 * required to be written against them ([kernel §2](../../spec/kernel.md)).
 *
 * It is also deliberately *plain*. A tab strip, a mode button and a status line: enough to prove the
 * shape, and no more, because the interesting claim is that this file has no special powers rather
 * than that it looks like VS Code. A site with a designer replaces it and keeps the capability.
 */

import { needs } from '../contribution/capabilities.js';
import type { Chrome, ChromeWindow } from '../contribution/capabilities.js';
import type { Context, Extension } from '../contribution/contract.js';
import { command, each, element, text } from '../description/build.js';
import type { Node } from '../description/types.js';
import { PAGE_CHROME, type PageChrome } from '../window/page.js';

const NEEDS = needs('chrome', 'state', 'commands', 'log');

export interface WorkbenchOptions {
    /**
     * Show a window's owner beside its title.
     *
     * Off by default. An owner is a pid, which is exactly right for a developer console and noise on
     * a blog — and which of those a site is, the site knows.
     */
    readonly showOwners?: boolean;
    /** Class prefix, so a site styles it without the framework naming its CSS. */
    readonly prefix?: string;
}

/**
 * The workbench.
 *
 * A class, and the host constructs it — spec/extension.md §2. Construction is side-effect free:
 * nothing is rendered and nothing is registered until `activate`.
 */
export class WorkbenchExtension implements Extension<typeof NEEDS, readonly [], typeof PAGE_CHROME> {
    readonly needs = NEEDS;
    readonly provides = PAGE_CHROME;

    /**
     * Declared, so both are bindable to a key and reachable from a palette before this Extension has
     * done anything — the manifest is complete before anything runs (spec/kernel.md §4).
     *
     * `focusWindow` takes the window id as an argument, which is what makes a tab **scriptable**
     * rather than only clickable ([view-layer §5](../../spec/view-layer.md)). It also means chrome
     * holds no callbacks: every affordance below is an `Action`, dispatched by the page, exactly as
     * in a view.
     */
    readonly commands = [
        { id: 'workbench.toggleMode', title: 'Toggle tiled / windowed' },
        { id: 'workbench.focusWindow', title: 'Focus window' },
    ];

    readonly #options: WorkbenchOptions;

    constructor(options: WorkbenchOptions = {}) {
        this.#options = options;
    }

    activate(cx: Context<typeof NEEDS, readonly []>): PageChrome {
        const chrome = cx.chrome;
        const prefix = this.#options.prefix ?? 'workbench';
        const showOwners = this.#options.showOwners ?? false;

        cx.commands.implement('workbench.toggleMode', () => {
            chrome.setMode(chrome.mode() === 'tiled' ? 'windowed' : 'tiled');
        });

        cx.commands.implement('workbench.focusWindow', (id) => {
            if (typeof id === 'string') chrome.focus(id);
        });

        cx.log.info('workbench ready');

        return {
            render: (): Node => element('Stack', {
                props: { class: prefix },
                children: [
                    tabStrip(chrome, prefix, showOwners),

                    // **The windows.** Unconditional and never inside a `when` or an `each`: it is
                    // destroyed and rebuilt by either, which re-parents every window and resets
                    // their scroll. The kernel checks, so getting this wrong is loud.
                    chrome.host(),

                    statusBar(chrome, prefix),
                ],
            }),
        };
    }
}

// ---------------------------------------------------------------------------- the pieces

/**
 * A tab per window, whoever opened it.
 *
 * `each` keyed by window id, so opening a window adds a tab and moves none of the others — and the
 * list comes from `chrome.windows()`, which is a plain read the renderer tracks. There is no
 * subscription here and nothing to unsubscribe.
 */
function tabStrip(chrome: Chrome, prefix: string, showOwners: boolean): Node {
    return element('Row', {
        props: { class: `${prefix}-tabs` },
        children: [
            each(
                () => chrome.windows(),
                (w: ChromeWindow) => w.id,
                (w: () => ChromeWindow) => element('Button', {
                    props: {
                        class: () => (chrome.focused() === w().id
                            ? `${prefix}-tab focused`
                            : `${prefix}-tab`),
                        // A tab is a button, so it is reachable without a pointer. Every action needs
                        // a non-pointer path (spec/input.md §3), and a div with a click handler has
                        // none.
                        type: 'button',
                        title: () => (showOwners ? `${w().title} — ${w().owner}` : w().title),
                    },
                    // The id is bound once per tab, which is safe because `each` is keyed by it —
                    // this tab is that window for as long as it exists.
                    intents: { activate: { action: command('workbench.focusWindow', w().id) } },
                    children: [
                        element('Text', {
                            props: { class: `${prefix}-tab-label` },
                            children: [text(() => w().title)],
                        }),
                        ...(showOwners
                            ? [element('Badge', {
                                props: { class: `${prefix}-tab-owner` },
                                children: [text(() => w().owner)],
                            })]
                            : []),
                    ],
                }),
            ),
        ],
    });
}

/** Mode, window count, and what is focused. The kernel's own state, on screen. */
function statusBar(chrome: Chrome, prefix: string): Node {
    const focusedTitle = (): string => {
        const id = chrome.focused();
        return chrome.windows().find((w) => w.id === id)?.title ?? 'nothing';
    };

    return element('Row', {
        props: { class: `${prefix}-status` },
        children: [
            element('Button', {
                props: { class: `${prefix}-mode`, type: 'button' },
                // Through the command rather than calling `setMode` directly, so the button, a key
                // binding and a palette entry are one code path and cannot drift.
                intents: { activate: { action: command('workbench.toggleMode') } },
                children: [text(() => (chrome.mode() === 'tiled' ? 'Tiled' : 'Windowed'))],
            }),
            element('Text', {
                props: { class: `${prefix}-count` },
                children: [text(() => `${String(chrome.windows().length)} windows`)],
            }),
            element('Text', {
                props: { class: `${prefix}-focused` },
                children: [text(() => `focus: ${focusedTitle()}`)],
            }),
        ],
    });
}
