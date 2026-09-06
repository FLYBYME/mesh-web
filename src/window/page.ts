/**
 * The page: chrome around the windows — roadmap A6.3d, spec/extension.md §8.
 *
 * An activity bar, a tab strip and a status bar are the frame *around* the windows rather than
 * windows, so chrome needs a surface outside the window area. Two shapes were rejected before this
 * one and both are recorded in the spec:
 *
 * - **A DOM handle**, which hands chrome the thing [kernel §2](../../spec/kernel.md) says the kernel
 *   owns — that the DOM exists at all, and that it is not replaceable by the code it renders.
 * - **Named regions** — `top`, `bottom`, or worse `activityBar` and `statusBar` — which is PR #6's
 *   shell *profiles* in different clothes: a docking model baked into the framework that every site
 *   pays for and no site can escape.
 *
 * So the surface is inverted. **Chrome describes the whole page**, in the same description language
 * a view uses, and one node in that description says *the windows go here*:
 *
 * ```ts
 * render: () => element('Stack', { children: [
 *     tabStrip(cx.chrome.windows()),
 *     cx.chrome.host(),          // ← the window area, wherever chrome puts it
 *     statusBar(cx.chrome.focused()),
 * ]})
 * ```
 *
 * The framework gains exactly one concept — *"the window area goes here"* — and names no layout at
 * all. Chrome arranges anything it likes around the windows, in any nesting, and still never touches
 * the DOM or the mounting.
 *
 * A site with no chrome gets the window layer at the root, which is what makes chrome **optional
 * rather than a mode with a default**.
 */

import { element } from '../description/build.js';
import type { Node } from '../description/types.js';
import { effect } from '../reactivity/index.js';
import { render, type RenderOptions } from '../render/dom.js';
import type { ComponentDefinition } from '../render/component.js';
import { provider, type ProviderToken } from '../contribution/provider.js';
import { mountShell, type Shell, type ShellOptions } from './shell.js';

// ---------------------------------------------------------------------------- the marker

/**
 * The component name that means "the windows go here".
 *
 * A component rather than an attribute convention, so chrome composes it exactly like every other
 * node and cannot get the spelling subtly wrong: `element(WINDOW_HOST)` either resolves or fails
 * loudly at render, and `cx.chrome.host()` writes it for you.
 */
export const WINDOW_HOST = 'WindowHost';

const HOST_ATTRIBUTE = 'data-mesh-window-host';

/**
 * What the marker renders as.
 *
 * `position: relative` is the one style the framework insists on, and it is mechanism rather than
 * look: windows are absolutely positioned, and absolute positioning needs a positioned ancestor or
 * every window would be placed against the viewport instead of against the area chrome gave them.
 * Everything else — size, background, border — is the site's.
 */
export const windowHostComponent: ComponentDefinition = {
    name: WINDOW_HOST,
    create: () => {
        const el = document.createElement('div');
        el.setAttribute(HOST_ATTRIBUTE, '');
        el.style.position = 'relative';
        return el;
    },
};

/** The node chrome puts where it wants the windows. Returned by `cx.chrome.host()`. */
export const windowHost = (): Node => element(WINDOW_HOST);

// ---------------------------------------------------------------------------- what chrome provides

/**
 * The page chrome, as an Extension provides it.
 *
 * `render` is called once. It returns a description; the renderer binds its signals fine-grained, so
 * a tab appearing does not re-render the page and — critically — does not recreate the window host.
 */
export interface PageChrome {
    render(): Node;
}

/**
 * The token a chrome Extension provides.
 *
 * An ordinary provider token, so page chrome is discovered exactly the way any other contributed API
 * is, and a site with none simply resolves nothing.
 */
export const PAGE_CHROME: ProviderToken<PageChrome> = provider<PageChrome>('mesh-web/page-chrome');

// ---------------------------------------------------------------------------- mounting

export interface PageOptions extends ShellOptions {
    /**
     * The page chrome, if the site has one.
     *
     * Typically `kernel.provided(PAGE_CHROME)`. Absent means the window layer mounts at the root.
     */
    readonly chrome?: PageChrome;
    /**
     * Told when the window host is detached — see the observer below.
     *
     * Defaults to throwing. An option because a throw inside a `MutationObserver` callback becomes
     * an uncaught error rather than something a caller can catch, so without this the check would be
     * loud in a console and invisible to a test.
     */
    readonly onError?: (error: ChromeError) => void;
}

export interface Page {
    readonly shell: Shell;
    /** Where the windows are actually mounted — the root, or the node chrome marked. */
    readonly host: Element;
    dispose(): void;
}

export class ChromeError extends Error {
    override readonly name = 'ChromeError';
}

/**
 * Render the chrome, find the window host, mount the shell inside it.
 *
 * The order matters and is the whole mechanism: chrome describes, the kernel renders, and only then
 * does the kernel decide where windows go — by looking for its own marker in what chrome produced.
 * Chrome never receives an element and never mounts anything.
 */
export function mountPage(root: Element, options: PageOptions): Page {
    const stopMode = effect(() => {
        const mode = options.manager.mode();
        if (root instanceof HTMLElement) {
            root.dataset['meshWindowMode'] = mode;
            root.dataset['windowMode'] = mode;
            if (mode === 'single') {
                root.style.overflow = '';
                root.style.height = '';
            }
        } else {
            root.setAttribute('data-mesh-window-mode', mode);
            root.setAttribute('data-window-mode', mode);
        }
    });

    if (options.chrome === undefined) {
        // No chrome. The window layer is the page, which is the ordinary case for a blog and the
        // reason chrome is an Extension rather than a mode.
        const shell = mountShell(root, options);
        return {
            shell,
            host: root,
            dispose: () => {
                stopMode();
                shell.dispose();
            },
        };
    }

    // Registered here rather than asked of the site: the marker is the framework's, and a site that
    // had to remember to register it would discover the omission as chrome that renders nothing.
    if (options.render.components.get(WINDOW_HOST) === undefined) {
        options.render.components.register(windowHostComponent);
    }

    const chrome = render(options.chrome.render(), root, options.render);

    const host = root.querySelector(`[${HOST_ATTRIBUTE}]`);
    if (host === null) {
        chrome.dispose();
        throw new ChromeError(
            'The page chrome rendered no window host, so no window could ever appear. Put ' +
            '`cx.chrome.host()` somewhere in what it returns. A site whose chrome forgot the ' +
            'windows is broken rather than a site with no windows, so this is refused at boot.',
        );
    }

    const shell = mountShell(host, options);

    // The host must survive every repaint of the chrome. Inside a `when` or an `each` it would be
    // destroyed and rebuilt, re-parenting every window — and re-parenting resets scroll, which is
    // the exact defect the no-remount design exists to prevent. Detached is therefore not a
    // cosmetic problem, and it is checked rather than documented.
    const fail = options.onError ?? ((error: ChromeError) => { throw error; });

    const watch = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(() => {
        if (host.isConnected) return;
        watch?.disconnect();
        fail(new ChromeError(
            'The window host was removed from the page. It must be unconditional in the chrome ' +
            'description — inside a `when` or an `each` it is recreated on every change, which ' +
            're-parents every window and resets their scroll.',
        ));
    });
    watch?.observe(root, { childList: true, subtree: true });

    return {
        shell,
        host,
        dispose() {
            stopMode();
            watch?.disconnect();
            shell.dispose();
            chrome.dispose();
        },
    };
}
