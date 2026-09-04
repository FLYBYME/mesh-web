/**
 * The workbench, as an Extension — roadmap A6.3, spec/extension.md §8.
 *
 * > "i think i should be able to write an extention that would cover the 'workbench' idea too"
 *
 * §8 calls this the load-bearing test of the whole design: *if the IDE shell cannot be written as an
 * ordinary Extension over the window manager, the capability split is wrong, and it is much better
 * to learn that from writing the workbench than from the first outside author.* Three things had to
 * be built before the question could even be asked — `needs('chrome')` (A6.3c), a window layer in
 * the package (A6.3e), and a surface for chrome to draw on (A6.3d).
 *
 * So this suite asks it. The workbench boots through the ordinary Extension path, draws a tab strip
 * and a status bar around a window area it chose the position of, and an Application running beside
 * it neither knows nor can find out. **The answer is yes.**
 */

import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from '@vitest/browser/context';

import {
    Kernel, WindowManager, PAGE_CHROME, createRegistry, element, flushSync,
    mountPage, needs, text, windowSink, PRIMITIVES,
    type Application, type Context, type Page,
} from '../../src/index.js';

// From `browser/`, not from the package. The workbench is not part of `@flybyme/mesh-web` — the IDE
// is a different product — and importing it from where an outside author's code would live is part
// of what this suite asserts.
import { WorkbenchExtension } from '../../browser/workbench.js';

// ---------------------------------------------------------------------------- a site

const APP_NEEDS = needs('windows');

class NotesApp implements Application<typeof APP_NEEDS> {
    readonly needs = APP_NEEDS;

    readonly views = [
        {
            id: 'list',
            title: 'Notes',
            instances: 'one' as const,
            defaultSize: { width: 260, height: 180 },
            render: () => element('Text', { children: [text('notes')] }),
        },
        {
            id: 'detail',
            title: 'Detail',
            instances: 'one' as const,
            defaultSize: { width: 260, height: 180 },
            render: () => element('Text', { children: [text('detail')] }),
        },
    ];

    async start(cx: Context<typeof APP_NEEDS>): Promise<void> {
        cx.windows.open({ view: 'list' });
        cx.windows.open({ view: 'detail' });
    }
}

interface Site {
    readonly kernel: Kernel;
    readonly manager: WindowManager;
    readonly page: Page;
    dispose(): void;
}

let site: Site | undefined;

afterEach(() => {
    site?.dispose();
    site = undefined;
    document.body.innerHTML = '';
});

async function boot(options: { workbench?: boolean } = {}): Promise<Site> {
    const root = document.createElement('div');
    root.id = 'page';
    root.style.cssText = 'position:relative;width:900px;height:600px;overflow:hidden';
    document.body.appendChild(root);

    const style = document.createElement('style');
    style.textContent = `
        .workbench { display:flex; flex-direction:column; height:100%; }
        .workbench-tabs { flex:0 0 auto; height:30px; display:flex; }
        .workbench-status { flex:0 0 auto; height:24px; display:flex; }
        [data-mesh-window-host] { flex:1 1 auto; min-height:0; }
        .window { position:absolute; box-sizing:border-box; display:flex; flex-direction:column;
                  background:#fff; border:1px solid #999; }
        .titlebar { height:22px; flex:0 0 auto; background:#eee; }
        .content { flex:1 1 auto; overflow:auto; }
    `;
    document.head.appendChild(style);

    const manager = new WindowManager({ width: 900, height: 600 });
    const kernel = new Kernel();
    kernel.services.windows = windowSink(manager, (owner, view) => kernel.viewOf(owner, view));

    const loaded: { id: string; contribution: never }[] = [{
        id: 'notes',
        contribution: new NotesApp() as never,
    }];
    if (options.workbench !== false) {
        loaded.unshift({ id: 'workbench', contribution: new WorkbenchExtension() as never });
    }
    kernel.boot(loaded);

    const page = mountPage(root, {
        manager,
        viewOf: (owner, view) => kernel.viewOf(owner, view),
        apiOf: (owner) => kernel.processes.find((p) => p.pid === owner)?.api,
        render: {
            components: createRegistry(PRIMITIVES),
            // Chrome's affordances are Actions, so the page is what runs them — exactly as a view's
            // are. The workbench holds no callbacks of its own.
            dispatch: {
                dispatch: (action) => {
                    if (action.kind !== 'command') return;
                    void kernel.services.commands.get(action.id)?.run(...(action.args ?? []));
                },
            },
        },
        onCommand: () => {},
        // The ordinary provider lookup. A site with no chrome Extension resolves nothing here, and
        // the window layer mounts at the root instead.
        ...(kernel.provided(PAGE_CHROME) === undefined ? {} : { chrome: kernel.provided(PAGE_CHROME)! }),
    });

    await kernel.start('notes');
    flushSync();

    const created: Site = {
        kernel,
        manager,
        page,
        dispose() {
            page.dispose();
            root.remove();
            style.remove();
        },
    };

    site = created;
    return created;
}

const tabs = (): readonly string[] =>
    [...document.querySelectorAll('.workbench-tab-label')].map((el) => el.textContent ?? '');

// ---------------------------------------------------------------------------- the answer

describe('the workbench is an ordinary Extension', () => {
    it('activates through the normal path and provides the page chrome', async () => {
        const created = await boot();

        const entry = created.kernel.extensions.find((e) => e.id === 'workbench');
        expect(entry?.state).toBe('activated');
        // Discovered by provider token, like any other contributed API. There is no workbench-shaped
        // hole in the kernel for it to fit into.
        expect(created.kernel.provided(PAGE_CHROME)).toBeDefined();
    });

    it('draws a tab for every window, whoever opened them', async () => {
        const created = await boot();

        expect(tabs()).toEqual(['Notes', 'Detail']);
        // The windows belong to the Application, which never told the workbench anything.
        expect(created.manager.stacked()).toHaveLength(2);
    });

    it('puts the windows where it asked for them', async () => {
        const created = await boot();

        const host = document.querySelector('[data-mesh-window-host]')!;
        expect(created.page.host).toBe(host);

        // Inside the host, below the tabs and above the status bar — the arrangement the workbench
        // chose, in a description, with no DOM and no named region.
        const windows = host.querySelectorAll('.window');
        expect(windows).toHaveLength(2);

        const tabsBox = document.querySelector('.workbench-tabs')!.getBoundingClientRect();
        const hostBox = host.getBoundingClientRect();
        const statusBox = document.querySelector('.workbench-status')!.getBoundingClientRect();

        expect(hostBox.top).toBeGreaterThanOrEqual(tabsBox.bottom);
        expect(statusBox.top).toBeGreaterThanOrEqual(hostBox.bottom - 1);
    });

    it('positions windows against the area chrome gave them, not the viewport', async () => {
        const created = await boot();
        const id = created.manager.stacked()[0]!.id;

        const host = document.querySelector('[data-mesh-window-host]')!.getBoundingClientRect();
        const win = created.page.shell.hostOf(id)!.getBoundingClientRect();

        // The one style the framework insists on — `position: relative` on the host — and what it is
        // for. Without it every window would be placed against the viewport and would sit under the
        // tab strip.
        expect(win.top).toBeGreaterThanOrEqual(host.top - 1);
    });
});

describe('an Application beside it is none the wiser', () => {
    it('never declared chrome, so the workbench is watching windows it cannot watch back', async () => {
        const created = await boot();
        const pid = created.kernel.processes[0]!.pid;

        // Every window belongs to the Application, and the workbench — a different contribution
        // entirely — has drawn a tab for each. That asymmetry *is* the chrome capability: observing
        // every window is observing every Application, which is why declaring it is the price.
        expect(created.manager.stacked().every((w) => w.owner === pid)).toBe(true);
        expect(tabs()).toHaveLength(created.manager.stacked().length);

        // And the Application's own declaration is `needs('windows')` and nothing else. It has no
        // name for the workbench, no way to enumerate contributions, and no path to `chrome` —
        // test/chrome.test.ts asserts the absence directly; this asserts it is absent *here*, in a
        // page where a workbench is genuinely running beside it.
        expect(new NotesApp().needs).toEqual(['windows']);
    });
});

describe('the chrome works', () => {
    it('focuses a window from its tab, through a declared command', async () => {
        const created = await boot();
        const [first, second] = created.manager.stacked();

        expect(created.manager.focused()).toBe(second!.id);

        const tab = [...document.querySelectorAll('.workbench-tab')]
            .find((el) => el.textContent?.includes('Notes'))!;
        await userEvent.click(tab);
        flushSync();

        expect(created.manager.focused()).toBe(first!.id);
        // Raised too, because focusing is the kernel's and chrome only asked.
        expect(created.manager.stacked().at(-1)?.id).toBe(first!.id);
    });

    it('switches mode from the status bar, and the tabs survive it', async () => {
        const created = await boot();
        expect(created.manager.mode()).toBe('windowed');

        await userEvent.click(document.querySelector('.workbench-mode')!);
        flushSync();

        expect(created.manager.mode()).toBe('tiled');
        expect(document.querySelector('.workbench-mode')?.textContent).toBe('Tiled');
        // The chrome did not re-render wholesale: the same tabs, in the same order, and — the thing
        // that matters — the same window host.
        expect(tabs()).toEqual(['Notes', 'Detail']);
        expect(created.page.host.isConnected).toBe(true);
    });

    it('grows a tab when a window opens, without disturbing the window area', async () => {
        const created = await boot();
        const host = created.page.host;
        const before = created.page.shell.hostOf(created.manager.stacked()[0]!.id);

        created.manager.open({ owner: created.kernel.processes[0]!.pid, view: 'list', title: 'Third' });
        flushSync();

        expect(tabs()).toEqual(['Notes', 'Detail', 'Third']);
        // Fine-grained: a new tab did not rebuild the host or remount an existing window.
        expect(created.page.host).toBe(host);
        expect(created.page.shell.hostOf(created.manager.stacked()[0]!.id)).toBe(before);
    });
});

describe('a site with no workbench', () => {
    it('mounts the window layer at the root and renders no chrome', async () => {
        const created = await boot({ workbench: false });

        expect(document.querySelector('.workbench-tabs')).toBeNull();
        expect(document.querySelector('[data-mesh-window-host]')).toBeNull();
        expect(created.page.host).toBe(document.getElementById('page'));
        // Still two working windows. Chrome is optional rather than a mode with a default.
        expect(document.querySelectorAll('.window')).toHaveLength(2);
    });
});
