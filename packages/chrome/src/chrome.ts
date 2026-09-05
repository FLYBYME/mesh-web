/**
 * The console's shell, as an Extension.
 *
 * This is the claim mesh-web's A6.3 makes, tested by someone who cannot cheat: a workbench — tabs, a
 * mode switch, a status line, everything around the windows — is an *ordinary Extension* over the
 * window manager, with no privileged reach. It declares four capabilities, returns a description,
 * and marks with `cx.chrome.host()` where the windows go. There is no `Shell` object here, no import
 * from a framework internal, and **no DOM**.
 *
 * ## Why the console writes its own rather than installing one
 *
 * mesh-web has a `WorkbenchExtension` and it does not ship it. It lives in that repo's `browser/`
 * directory, outside the package, deliberately — the IDE is a different product from the framework,
 * and a blog that installs the framework should not receive an activity bar. So there was nothing to
 * import, and this file is what an outside author actually does.
 *
 * That turns out to be the better test. A shipped workbench would have proved that mesh-web can run
 * mesh-web's own chrome; writing one here proves the *interfaces* are enough, which is what A6.3
 * actually claims.
 *
 * ## Every affordance is an intent, not a handler
 *
 * There is no `onClick` anywhere below, and the description holds no functions. A button declares
 * `intents: { activate: { action: command(...) } }`, the page dispatches it, and the command is the
 * same one a key binding or a palette entry would reach. That is what makes a tab *scriptable*
 * rather than only clickable — and it is why chrome can be described by something that has never
 * seen an element.
 */

import {
    command, each, element, needs, text, when, PAGE_CHROME,
    type Chrome, type ChromeWindow, type Context, type Extension, type Node, type PageChrome,
} from '@flybyme/mesh-web';

const NEEDS = needs('chrome', 'state', 'commands', 'log');

export class ConsoleChrome implements Extension<typeof NEEDS, readonly [], typeof PAGE_CHROME> {
    readonly needs = NEEDS;
    readonly provides = PAGE_CHROME;

    /**
     * Declared, so both are bindable to a key and reachable from a palette before this Extension has
     * run at all — the manifest is complete before anything activates.
     */
    readonly commands = [
        { id: 'console.toggleMode', title: 'Toggle tiled / windowed' },
        { id: 'console.focusWindow', title: 'Focus window' },
    ];

    activate(cx: Context<typeof NEEDS, readonly []>): PageChrome {
        const chrome = cx.chrome;

        cx.commands.implement('console.toggleMode', () => {
            chrome.setMode(chrome.mode() === 'tiled' ? 'windowed' : 'tiled');
        });

        cx.commands.implement('console.focusWindow', (id) => {
            if (typeof id === 'string') chrome.focus(id);
        });

        cx.log.info('console chrome ready');

        return {
            render: (): Node => element('Stack', {
                props: { class: 'console' },
                children: [
                    banner(chrome),
                    tabs(chrome),

                    // **The windows.** Unconditional, and never inside a `when` or an `each`: either
                    // destroys and rebuilds it, which re-parents every window and resets its scroll.
                    // The kernel checks this at boot rather than trusting the comment.
                    chrome.host(),

                    status(chrome),
                ],
            }),
        };
    }
}

/** The site's own identity, and the one control that is always available. */
const banner = (chrome: Chrome): Node => element('Row', {
    props: { class: 'console-banner' },
    children: [
        element('Text', { props: { class: 'console-mark' }, children: [text('surfdns')] }),
        element('Text', { props: { class: 'console-where' }, children: [text('operator console')] }),
        element('Button', {
            // A button, so it is reachable without a pointer: every action needs a non-pointer path,
            // and a div with a click handler has none.
            props: { class: 'console-mode', type: 'button' },
            intents: { activate: { action: command('console.toggleMode') } },
            children: [text(() => (chrome.mode() === 'tiled' ? 'Tiled' : 'Windowed'))],
        }),
    ],
});

/**
 * One tab per open window, whoever opened it.
 *
 * `chrome.windows()` is what `needs('chrome')` buys, and it is the whole reason a workbench cannot
 * be written with `needs('windows')`: an Application sees only the windows it opened, which is
 * correct for an Application and useless for a shell.
 */
const tabs = (chrome: Chrome): Node => element('Row', {
    props: { class: 'console-tabs' },
    children: [
        each(
            () => chrome.windows(),
            (w: ChromeWindow) => w.id,
            (w: () => ChromeWindow) => element('Button', {
                props: {
                    class: () => (chrome.focused() === w().id ? 'console-tab focused' : 'console-tab'),
                    type: 'button',
                },
                // The id is bound once per tab, which is safe because `each` is keyed by it: this
                // tab is that window for as long as it exists.
                intents: { activate: { action: command('console.focusWindow', w().id) } },
                children: [text(() => w().title)],
            }),
        ),

        // A console with nothing open should say so. An empty strip reads as a rendering failure.
        when(() => chrome.windows().length === 0, () => element('Text', {
            props: { class: 'console-empty' },
            children: [text('no windows')],
        })),
    ],
});

/** The kernel's own state, on screen. */
const status = (chrome: Chrome): Node => element('Row', {
    props: { class: 'console-status' },
    children: [
        element('Text', {
            children: [text(() => {
                const open = chrome.windows().length;
                return `${String(open)} window${open === 1 ? '' : 's'}`;
            })],
        }),
        element('Text', {
            props: { class: 'dim' },
            children: [text(() => {
                const id = chrome.focused();
                return chrome.windows().find((w) => w.id === id)?.title ?? 'nothing focused';
            })],
        }),
    ],
});
