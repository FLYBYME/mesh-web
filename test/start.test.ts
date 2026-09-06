/**
 * @vitest-environment jsdom
 *
 * `start(composition)` — the kernel's entry point.
 *
 * This is the function the cdn's generated boot module calls, and until it existed the generated
 * page loaded, resolved its import map, fetched every part, and then did nothing: there was no
 * function behind the call. So the assertions here are about what a *site* gets for free, which is
 * everything `surfdns-console/src/main.ts` had to write by hand and get right.
 */

import { describe, expect, it } from 'vitest';

import { needs } from '../src/contribution/capabilities.js';
import type { Context, Extension, Application, ViewContext, ViewDecl } from '../src/contribution/contract.js';
import { provider, type ProviderToken } from '../src/contribution/provider.js';
import { start } from '../src/kernel/start.js';
import { PAGE_CHROME, windowHost } from '../src/window/page.js';
import { element, text } from '../src/description/index.js';

const NEEDS = needs('state', 'log');

/** An Application with one view, so there is something to open. */
class Widget implements Application<typeof NEEDS, readonly []> {
    readonly needs = NEEDS;
    readonly views = [{
        id: 'main',
        title: 'Widget',
        render: () => text('widget'),
    }] as unknown as readonly ViewDecl<never, never>[];

    started = 0;

    async start(_cx: Context<typeof NEEDS, readonly []>): Promise<void> {
        this.started += 1;
    }
}

/** An Extension taking options, which is the case that made the default export a constructor. */
const SETTING: ProviderToken<{ readonly seen: unknown }> = provider('test/setting');

class Configured implements Extension<typeof NEEDS, readonly [], typeof SETTING> {
    readonly needs = NEEDS;
    readonly provides = SETTING;

    constructor(private readonly options?: unknown) {}

    activate(_cx: Context<typeof NEEDS, readonly []>): { readonly seen: unknown } {
        return { seen: this.options };
    }
}

const clean = (): void => { document.body.replaceChildren(); };

describe('the page it builds', () => {
    it('creates its own root, so a page need not contain an element for a part to find', async () => {
        // One of five undeclared contracts between a bundle and a hand-written page. Nothing
        // declared them and nothing checked them, so getting one wrong rendered a blank page with
        // no error naming the cause.
        clean();
        const started = start({ application: 'test', parts: [] });
        await started.ready;

        expect(document.getElementById('mesh-web-root')).not.toBeNull();
        started.dispose();
    });

    it('uses a root it was given', async () => {
        clean();
        const root = document.createElement('main');
        document.body.append(root);

        const started = start({ application: 'test', root, parts: [] });
        await started.ready;

        expect(started.page.host.closest('main')).toBe(root);
        started.dispose();
    });

    it('mounts a notification surface the kernel owns', async () => {
        // A capability with no surface is a silent failure: cx.notifications.warn would be called
        // correctly, recorded correctly, and displayed nowhere — so a failed API call would look
        // exactly like a button that did nothing.
        clean();
        const started = start({ application: 'test', parts: [] });
        await started.ready;

        expect(document.querySelector('.mesh-notifications')).not.toBeNull();
        started.dispose();
    });

    it('reads the api from the document rather than being told twice', async () => {
        // So a composition that omits `api` still works, and the two can never disagree.
        clean();
        document.documentElement.dataset['api'] = 'https://api.example';

        const started = start({ application: 'test', parts: [] });
        await started.ready;

        expect(started.kernel.services.credentials.origin).toBe('https://api.example');
        started.dispose();
        delete document.documentElement.dataset['api'];
    });

    it('prefers an api the composition states', async () => {
        clean();
        document.documentElement.dataset['api'] = 'https://from-document.example';

        const started = start({ application: 'test', api: 'https://stated.example', parts: [] });
        await started.ready;

        expect(started.kernel.services.credentials.origin).toBe('https://stated.example');
        started.dispose();
        delete document.documentElement.dataset['api'];
    });
});

describe('parts', () => {
    it('constructs a class, because a part that takes options cannot construct itself', async () => {
        // Found extracting the first real Extension: AuthExtension takes endpoints and a ticket
        // store, which are the site's decisions, so its default export has to be the constructor.
        clean();
        const started = start({
            application: 'test',
            parts: [{ id: 'configured', contribution: Configured, options: { endpoint: '/x' } }],
        });
        await started.ready;

        expect(started.kernel.provided(SETTING)).toEqual({ seen: { endpoint: '/x' } });
        started.dispose();
    });

    it('accepts an already-built contribution', async () => {
        clean();
        const widget = new Widget();
        const started = start({
            application: 'test',
            parts: [{ id: 'widget', contribution: widget }],
        });
        await started.ready;

        expect(widget.started).toBe(1);
        started.dispose();
    });

    it('opens every Application, when the site says nothing', async () => {
        clean();
        const widget = new Widget();
        const started = start({ application: 'test', parts: [{ id: 'widget', contribution: widget }] });
        await started.ready;

        expect(started.kernel.processes).toHaveLength(1);
        started.dispose();
    });

    it('opens an Application exported as a class, which is the ordinary case', async () => {
        /**
         * The regression this file was reopened for. `defaultOpen` read `composition.parts` and
         * skipped anything `typeof 'function'`, because only an instance can be classified — so a
         * part exported as a *class*, which is every part taking options, was filtered out and
         * nothing started at all. Silently: an empty open list is indistinguishable from a site that
         * asked for nothing.
         *
         * The test above passes an instance and always did. That is why nothing caught this until a
         * real Application was published, deployed, and rendered a black page.
         */
        clean();
        const started = start({ application: 'test', parts: [{ id: 'widget', contribution: Widget }] });
        await started.ready;

        expect(started.kernel.applications).toEqual(['widget']);
        expect(started.kernel.processes).toHaveLength(1);
        expect(started.kernel.processes[0]?.state).not.toBe('failed');
        started.dispose();
    });

    it('opens only what the site named', async () => {
        clean();
        const a = new Widget();
        const b = new Widget();
        const started = start({
            application: 'test',
            parts: [{ id: 'a', contribution: a }, { id: 'b', contribution: b }],
            open: [{ application: 'b' }],
        });
        await started.ready;

        expect(a.started).toBe(0);
        expect(b.started).toBe(1);
        started.dispose();
    });

    it('opens the views the site asked for', async () => {
        clean();
        const started = start({
            application: 'test',
            parts: [{ id: 'widget', contribution: new Widget() }],
            open: [{ application: 'widget', views: ['main'] }],
        });
        await started.ready;

        expect(started.manager.windows()).toHaveLength(1);
        started.dispose();
    });

    it('survives an Application that will not start', async () => {
        // One Application that cannot start is a missing window. Taking the page down with it turns
        // a broken part into a broken site.
        //
        // Note what `kernel.start` does here: it does **not** throw. It leaves the process in
        // `failed` — "a resting state, not a disappearance", because an Application that vanishes on
        // error is one nobody can debug — so the process table is what has to be read, and this is
        // where a window that never appeared stops being indistinguishable from one nobody asked for.
        clean();
        class Broken implements Application<typeof NEEDS, readonly []> {
            readonly needs = NEEDS;
            readonly views = [] as unknown as readonly ViewDecl<never, never>[];
            start(): never { throw new Error('nope'); }
        }

        const good = new Widget();
        const started = start({
            application: 'test',
            parts: [{ id: 'broken', contribution: new Broken() }, { id: 'good', contribution: good }],
        });
        await started.ready;

        expect(good.started).toBe(1);
        expect(started.kernel.processes.find((p) => p.applicationId === 'broken')?.state)
            .toBe('failed');
        expect(started.kernel.services.logs.some((l) => l.source === 'broken')).toBe(true);
        started.dispose();
    });

    it('says so when a composition names a part it does not contain', async () => {
        // The other failure, and the one that *does* throw: a site asking for an Application nobody
        // put in the release.
        clean();
        const started = start({
            application: 'test', parts: [], open: [{ application: 'absent' }],
        });
        await started.ready;

        expect(started.kernel.services.logs.some((l) => l.source === 'absent')).toBe(true);
        started.dispose();
    });
});

describe('chrome', () => {
    it('mounts the window layer inside whatever provides PAGE_CHROME', async () => {
        clean();

        // `render()` takes nothing and returns a description. Chrome never receives an element and
        // never mounts anything: it marks where the windows go with `windowHost()`, and the kernel
        // finds its own marker in what chrome produced.
        //
        // `Stack`, not `div` — a first draft of this test wrote `div` and the registry refused it by
        // name, which is the view-layer rule holding rather than being asked for: an Application's
        // vocabulary is components, and this file is chrome written the way a site would write it.
        class Chrome implements Extension<typeof NEEDS, readonly [], typeof PAGE_CHROME> {
            readonly needs = NEEDS;
            readonly provides = PAGE_CHROME;
            activate(): { render: () => ReturnType<typeof element> } {
                return {
                    render: () => element('Stack', {
                        props: { class: 'test-chrome' },
                        children: [windowHost()],
                    }),
                };
            }
        }

        const withChrome = start({
            application: 'test',
            parts: [{ id: 'chrome', contribution: new Chrome() }],
        });
        await withChrome.ready;

        const chromeRoot = withChrome.page.host.parentElement;
        expect(chromeRoot).not.toBeNull();
        // The windows are mounted *inside* what chrome rendered, not beside it.
        expect(chromeRoot?.classList.contains('test-chrome')).toBe(true);
        withChrome.dispose();
    });

    it('mounts at the root when nothing provides chrome', async () => {
        // A site with no chrome resolves nothing and the window layer is the page — which is the
        // ordinary case for a blog, and the reason chrome is an Extension rather than a mode.
        clean();
        const bare = start({ application: 'test', parts: [] });
        await bare.ready;

        expect(bare.page.host.parentElement?.classList.contains('test-chrome')).not.toBe(true);
        bare.dispose();
    });
});

describe('what it returns', () => {
    it('hands back the pieces, so a dev tool can reach in without rebuilding them', async () => {
        clean();
        const started = start({ application: 'test', parts: [] });
        await started.ready;

        expect(started.kernel).toBeDefined();
        expect(started.manager).toBeDefined();
        expect(started.settings).toBeDefined();
        expect(started.components).toBeDefined();
        started.dispose();
    });

    it('mounts before a slow Application has finished starting', async () => {
        // The page mounts synchronously and an Application starts asynchronously. Waiting for the
        // second before returning the first leaves a blank screen for as long as the slowest start()
        // takes, which is exactly when someone most wants to see that something is happening.
        clean();
        let finished = false;

        class Slow implements Application<typeof NEEDS, readonly []> {
            readonly needs = NEEDS;
            readonly views = [] as unknown as readonly ViewDecl<never, never>[];
            async start(): Promise<void> {
                await new Promise((done) => setTimeout(done, 5));
                finished = true;
            }
        }

        const started = start({ application: 'test', parts: [{ id: 'slow', contribution: new Slow() }] });

        // The page is up and the Application is not.
        expect(started.page.host).toBeDefined();
        expect(finished).toBe(false);

        await started.ready;
        expect(finished).toBe(true);
        started.dispose();
    });

    it('allows a view opened synchronously during start() to access vx.app', async () => {
        clean();
        const WINDOWS_NEEDS = needs('windows');

        interface TodoApi {
            readonly title: string;
        }
        const TODO = provider<TodoApi>('test/todo');

        class TodoApp implements Application<typeof WINDOWS_NEEDS, readonly [], typeof TODO> {
            readonly needs = WINDOWS_NEEDS;
            readonly provides = TODO;
            readonly views = [{
                id: 'main',
                title: 'Todo',
                render(vx: ViewContext<Record<string, never>, TodoApi>) {
                    return element('Text', { children: [text(vx.app.title)] });
                },
            }];

            async start(cx: Context<typeof WINDOWS_NEEDS, readonly []>): Promise<TodoApi> {
                cx.windows.open({ view: 'main' });
                return { title: 'Todos from start API' };
            }
        }

        const started = start({
            application: 'test',
            parts: [{ id: 'todo', contribution: new TodoApp() }],
        });
        await started.ready;

        const textSpan = started.page.host?.querySelector('.content span');
        expect(textSpan?.textContent).toBe('Todos from start API');
        started.dispose();
    });
});

/**
 * Declared key bindings, actually bound.
 *
 * `bindingTable` existed, `manifest.bindings` was collected, collisions between two Applications
 * claiming one chord were detected and reported — and **nothing ever listened for a keypress**.
 * Every `keys` declaration in every Application was inert, and the window layer had no keyboard path
 * to close or maximize at all, which made `spec/input.md` §3 false in the one place it most matters.
 */
describe('the keyboard', () => {
    const press = (binding: { key: string; alt?: boolean; ctrl?: boolean }): void => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: binding.key, altKey: binding.alt ?? false, ctrlKey: binding.ctrl ?? false,
            bubbles: true, cancelable: true,
        }));
    };

    it('runs a command an Application declared', async () => {
        clean();
        let ran = 0;

        const KEYED = needs('state', 'log', 'commands');
        class Keyed implements Application<typeof KEYED, readonly []> {
            readonly needs = KEYED;
            readonly commands = [{ id: 'keyed.go', title: 'Go' }];
            readonly keys = [{ command: 'keyed.go', keys: 'ctrl+g' }];
            readonly views = [] as unknown as readonly ViewDecl<never, never>[];
            async start(cx: Context<typeof KEYED, readonly []>): Promise<void> {
                cx.commands.implement('keyed.go', () => { ran += 1; });
            }
        }

        const started = start({ application: 'test', parts: [{ id: 'keyed', contribution: Keyed }] });
        await started.ready;

        press({ key: 'g', ctrl: true });
        expect(ran).toBe(1);
        started.dispose();
    });

    it('gives a window a non-pointer path to maximize and back', async () => {
        // spec/input.md §3. The title bar button was the only way, which made every window in the
        // framework unreachable without a mouse — while that same rule gated the primitive audit.
        clean();
        const started = start({
            application: 'test', parts: [{ id: 'widget', contribution: Widget }],
            open: [{ application: 'widget', views: ['main'] }],
        });
        await started.ready;

        const id = started.manager.windows()[0]!.id;
        started.manager.focus(id);

        press({ key: 'm', alt: true });
        expect(started.manager.get(id)?.state).toBe('maximized');

        press({ key: 'm', alt: true });
        expect(started.manager.get(id)?.state).toBe('normal');
        started.dispose();
    });

    it('switches between windowed and tiled, which nothing else could reach', async () => {
        // setMode was real, persisted, and lockable by policy — and no menu, button or binding
        // called it. Tiled mode existed and could not be turned on.
        clean();
        const started = start({ application: 'test', parts: [{ id: 'widget', contribution: Widget }] });
        await started.ready;

        expect(started.manager.mode()).toBe('windowed');
        press({ key: 't', alt: true });
        expect(started.manager.mode()).toBe('tiled');
        started.dispose();
    });

    it('does not steal a keystroke from something being typed into', async () => {
        clean();
        const started = start({ application: 'test', parts: [{ id: 'widget', contribution: Widget }] });
        await started.ready;

        const field = document.createElement('input');
        document.body.append(field);
        field.focus();

        const before = started.manager.mode();
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true }));
        expect(started.manager.mode()).toBe(before);

        field.remove();
        started.dispose();
    });
});

describe('the layout an Application declared', () => {
    it('reaches the window manager, so tiled mode has something to tile', async () => {
        /**
         * `setLayout` was called by nothing. An Application declared `layout`, `mergeManifests`
         * collected it into `manifest.layouts`, and `WindowManager.setLayout` existed to receive
         * it — three parts, no code joining them, so `layout()` was `undefined` for the life of
         * every page.
         *
         * Tiled mode therefore had nothing to tile. The mode switched, the button's label changed,
         * and not one window moved: *"the tile window button changes its text but the tiles do
         * not."*
         */
        clean();

        class Tiling implements Application<typeof NEEDS, readonly []> {
            readonly needs = NEEDS;
            readonly layout = {
                split: 'row' as const,
                children: [
                    { node: { tile: 'main' }, size: 2 },
                    { node: { tile: 'side' }, size: 1 },
                ],
            };
            readonly views = [
                { id: 'a', title: 'A', tile: 'main', render: () => text('a') },
                { id: 'b', title: 'B', tile: 'side', render: () => text('b') },
            ] as unknown as readonly ViewDecl<never, never>[];
            async start(_cx: Context<typeof NEEDS, readonly []>): Promise<void> {}
        }

        const started = start({
            application: 'test',
            parts: [{ id: 'tiling', contribution: Tiling }],
            open: [{ application: 'tiling', views: ['a', 'b'] }],
        });
        await started.ready;

        expect(started.manager.layout()).toBeDefined();

        // And the windows actually take tile rects rather than their own. The viewport is set
        // explicitly because jsdom reports clientWidth 0, so a tile of it would be 0 wide.
        started.manager.setViewport({ width: 1200, height: 800 });
        started.manager.setMode('tiled');
        const [a, b] = started.manager.windows();
        const rectA = started.manager.rectOf(a!.id);
        const rectB = started.manager.rectOf(b!.id);

        expect(rectA).toBeDefined();
        expect(rectB).toBeDefined();
        // `main` is twice `side`, so the split is real rather than two equal halves.
        expect(rectA!.width).toBeGreaterThan(rectB!.width);
        started.dispose();
    });
});
