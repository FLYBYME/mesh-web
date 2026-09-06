/**
 * `start(composition)` — the kernel's entry point.
 *
 * ## What this replaces
 *
 * `surfdns-console/src/main.ts` was 140 lines and **almost none of it was about that console**: a
 * `WindowManager`, four settings hives and their providers, `windowPersistence`, a mesh client wired
 * through `withHeaders`, a component registry, `mountPage`, an effect rendering notifications, and a
 * resize listener. Identical on every site, hand-written on every site, and wrong in a different way
 * on each one.
 *
 * The cdn generates a page per site and could have generated those 140 lines too. It must not: a
 * generator that tracks another package's internals is a second copy of that package, updated
 * whenever this one changes. So the split is **the cdn generates a composition, the kernel knows how
 * to run one** — and this is the function that makes that split possible.
 *
 * What a generated boot module looks like afterwards:
 *
 * ```js
 * import { start } from '/_a/9f2c1a/index.js';
 * import part0 from '/_a/3ab77e/index.js';
 *
 * start({
 *     application: 'surfdns-console',
 *     api: document.documentElement.dataset.api ?? '',
 *     policy: { 'window-manager/mode': 'tiled' },
 *     parts: [{ id: 'chrome', contribution: part0 }],
 * });
 * ```
 *
 * ## The five undeclared contracts it removes
 *
 * A hand-written page and a bundle agreed on five things that nothing declared and nothing checked:
 * a `#console` element, a `#notifications` element, a stylesheet defining `.window` and `.titlebar`,
 * an import map, and `data-api`. Getting one wrong rendered a blank or half-styled page with no error
 * naming the cause.
 *
 * Three of them are gone here: **the kernel creates what it mounts into**, it mounts its own
 * notification surface, and it reads the API from the document rather than being told twice. The
 * import map and the stylesheet stay with the page, where they belong — they are what a browser
 * needs before any of this runs.
 */

import type { ErasedContribution } from '../contribution/contract.js';
import { effect } from '../reactivity/index.js';
import { createRegistry as createComponents, PRIMITIVES } from '../render/component.js';
import type { ComponentRegistry } from '../render/component.js';
import { createClient, fetchTransport, withHeaders } from '../net/client.js';
import type { MeshClient } from '../net/client.js';
import type { AnyApiCall, Api } from '../net/api.js';
import { SettingLocked, createRegistry as createSettings } from '../registry/registry.js';
import type { Registry } from '../registry/registry.js';
import type { BuildPolicy, HiveBindings } from '../registry/hives.js';
import { localProvider, memoryProvider } from '../registry/providers.js';
import { mountPage, PAGE_CHROME } from '../window/page.js';
import type { Page } from '../window/page.js';
import { pageWindowMode, windowPersistence } from '../window/persistence.js';
import type { RememberedWindow, WindowPersistence } from '../window/persistence.js';
import { windowSink } from '../window/sink.js';
import { WindowManager } from '../window/manager.js';
import type { Action } from '../description/types.js';
import { bindingTable } from '../input/keys.js';
import { createServices } from './broker.js';
import { Kernel } from './kernel.js';

/**
 * One part, as the page hands it over.
 *
 * `contribution` is a **class or an instance**, and accepting both is not laziness. Extracting the
 * first real Extension showed why: `AuthExtension` takes `endpoints` and a ticket `store`, which are
 * the *site's* decisions, so the package cannot construct itself and its default export has to be
 * the constructor. A part that needs nothing exports an instance just as reasonably. The kernel is
 * the only thing holding both the class and the site's options, so it is the only thing that can
 * join them.
 */
export interface PartRef {
    readonly id: string;
    /**
     * `never[]` and not `(options?: unknown)`, which is what this said until a real part broke it.
     *
     * Constructor parameters are **contravariant**: a class taking `{ endpoints?: … }` is *not*
     * assignable to one taking `unknown`, because `unknown` is wider than what it accepts. So the
     * first version rejected every part with a typed constructor — which is every realistic part,
     * since taking options is the reason a part exports a constructor at all.
     *
     * It typechecked because the fixture that tested it took `unknown` too. A type tested only
     * against a shape built to satisfy it is a type that has not been tested. Found by the first
     * part written by somebody else.
     */
    readonly contribution: ErasedContribution | (new (...args: never[]) => ErasedContribution);
    /** Passed to the constructor. From the site record, never from the part. */
    readonly options?: unknown;
}

export interface Composition {
    /** Namespaces this page's settings, so two Applications cannot collide in one backing store. */
    readonly application: string;
    /**
     * Where `mesh` sends requests. `''` means same origin.
     *
     * The one value a page cannot discover at run time, and the reason the generated boot module
     * reads it from `data-api` rather than having it baked in: one part artifact serves every site.
     */
    readonly api?: string;
    /**
     * Values frozen into this deployment.
     *
     * Not a setting: resolved first and unwritable. `{ 'window-manager/mode': 'tiled' }` is how a
     * blog is locked, and locking it needs no mechanism in the window manager — a locked deployment
     * writes the setting as policy and it becomes one nobody can change.
     */
    readonly policy?: BuildPolicy;
    readonly parts: readonly PartRef[];
    /**
     * Where to mount.
     *
     * **Created if absent**, which is the point: a page should not have to contain an element for a
     * bundle to find by id. That contract was undeclared, unchecked, and rendered a blank page when
     * it was wrong.
     */
    readonly root?: Element;
    /**
     * Which Applications to open, and which views of each.
     *
     * Absent means **every Application in the composition, with no views open**. A bare kernel
     * showing nothing is correct — and a desktop with nothing on it is also indistinguishable from
     * one that failed, which is why a site says what to open.
     */
    readonly open?: readonly { readonly application: string; readonly views?: readonly string[] }[];
    /** Injected by a test that would rather not touch `window`. */
    readonly window?: { addEventListener(type: 'resize', fn: () => void): void };
    readonly hives?: HiveBindings;
}

export interface Started {
    readonly kernel: Kernel;
    readonly manager: WindowManager;
    readonly page: Page;
    readonly settings: Registry;
    readonly components: ComponentRegistry;
    /**
     * Resolves when the Applications named in `open` have started.
     *
     * Separate from the return, because **the page mounts synchronously and an Application starts
     * asynchronously**. Waiting for the second before returning the first would leave a blank screen
     * for as long as the slowest `start()` takes, which is exactly when a user most wants to see
     * that something is happening.
     */
    readonly ready: Promise<void>;
    dispose(): void;
}

export function start(composition: Composition): Started {
    const doc = composition.root?.ownerDocument ?? globalThis.document;
    const root = composition.root ?? mountRoot(doc);
    const api = composition.api ?? readApi(doc);

    const manager = new WindowManager({
        width: root.clientWidth,
        height: root.clientHeight,
    });

    const hives = composition.hives ?? {
        system: { provider: memoryProvider('system'), writable: false },
        user: { provider: memoryProvider('user'), writable: true },
        device: { provider: localProvider(), writable: true },
        session: { provider: memoryProvider('session'), writable: true },
    };

    const services = createServices(undefined, { apiOrigin: api, hives });
    const kernel = new Kernel({ services });

    /**
     * Four hives, and where each is backed.
     *
     * `device` on `localStorage`, which is what makes a reload remember where a window was left —
     * geometry belongs to a screen and should never follow someone between them. `system` is memory
     * and unwritable, standing in for a hive a deployment fills from the server.
     */
    const settings = createSettings({
        namespace: composition.application,
        ...(composition.policy === undefined ? {} : { policy: composition.policy }),
        hives,
        onError: (error, { path }) => {
            kernel.services.logs.push({ level: 'warn', source: 'registry', message: path, data: error });
        },
    });

    const pagePolicy = settings.resolution(pageWindowMode)();
    if (pagePolicy.locked || pagePolicy.from !== undefined) {
        manager.setMode(pagePolicy.value);
    }

    /**
     * Window geometry across reloads.
     *
     * **The return value used to be discarded**, and that was the whole bug: `windowPersistence`
     * builds a complete mechanism — debounced saves, a restore that the boot sequence can await, a
     * mode setting backed by the `device` hive on `localStorage` — and it does none of it until
     * something calls `watch()`. Constructed and dropped, it wrote nothing and read nothing back,
     * so `localStorage` stayed empty and every window came back at its cascade position.
     *
     * `watch()` here; the restore is applied in `open()` below, after the Applications that own
     * those windows have started — a geometry for a view whose Application is not running has
     * nothing to be applied to.
     */
    const persistence = windowPersistence({
        manager, registry: settings, application: composition.application,
    });
    const stopPersisting = persistence.watch();

    kernel.services.windows = windowSink(manager, (owner, view) => kernel.viewOf(owner, view));

    /**
     * How a declared API becomes a client, and the one place a credential could be handled.
     *
     * It is not handled here either: `withHeaders` takes a *function*, and the auth Extension fills
     * it in through `needs('credentials')`. This installs the seam and never looks through it, which
     * is the whole of *an Application never handles a credential* — it calls `cx.mesh.call(...)` and
     * its request carries a ticket it has never seen.
     */
    kernel.services.meshClient = (declared) => createClient(declared as Api<Record<string, AnyApiCall>>, {
        transport: withHeaders(
            fetchTransport(api),
            () => kernel.services.credentials.headers?.() ?? {},
        ),
    }) as MeshClient<unknown>;

    kernel.boot(composition.parts.map((part) => ({
        id: part.id,
        contribution: construct(part),
    })));

    const components = createComponents(PRIMITIVES);

    const run = (action: Action): void => {
        if (action.kind !== 'command') return;
        void kernel.services.commands.get(action.id)?.run(...(action.args ?? []));
    };

    /**
     * The page: chrome around a window host, both from contributions.
     *
     * `mountPage` asks the kernel for whatever provides `PAGE_CHROME`, renders it, finds where that
     * put its window host, and mounts the window layer there. Chrome that forgot the host throws at
     * boot rather than rendering a page with no windows — which is the right time to find out.
     */
    const chrome = kernel.provided(PAGE_CHROME);
    const page = mountPage(root, {
        manager,
        ...(chrome === undefined ? {} : { chrome }),
        viewOf: (owner, view) => {
            const process = kernel.processes.find((p) => p.pid === owner);
            return process === undefined ? undefined : kernel.viewOf(process.pid, view);
        },
        apiOf: (owner) => kernel.processes.find((p) => p.pid === owner)?.api,
        isReady: (owner) => kernel.processes.find((p) => p.pid === owner)?.state === 'running',
        render: { components, dispatch: { dispatch: run } },
        onCommand: run,
    });

    const notifications = mountNotifications(doc, root, kernel);
    const keys = mountKeys(doc, kernel, manager, persistence);

    // A resize is the viewport changing under the manager, which clamps every window back inside it.
    // In single mode there is nothing to re-measure.
    const host = composition.window ?? globalThis.window;
    let lastMode = manager.mode();
    const onResize = () => {
        if (manager.mode() === 'single') return;
        manager.setViewport({ width: root.clientWidth, height: root.clientHeight });
    };
    host?.addEventListener('resize', onResize);

    const stopTracking = effect(() => {
        const currentMode = manager.mode();
        if (lastMode === 'single' && currentMode !== 'single') {
            // Leaving single mode: re-measure viewport to restore windowed / tiled layout
            manager.setViewport({ width: root.clientWidth, height: root.clientHeight });
        }
        lastMode = currentMode;
    });

    return {
        kernel, manager, page, settings, components,
        ready: open(kernel, composition, manager, persistence),
        dispose() {
            stopPersisting();
            stopTracking();
            keys();
            page.dispose();
            notifications.remove();
            if (host !== undefined && 'removeEventListener' in host && typeof host.removeEventListener === 'function') {
                host.removeEventListener('resize', onResize);
            }
        },
    };
}

// ---------------------------------------------------------------------------- the pieces

/**
 * A class becomes an instance; an instance is left alone.
 *
 * Detected by `prototype`, not by `typeof === 'function'`: an arrow function is a function and is not
 * a constructor, and calling `new` on one throws in a way that reads as a kernel bug rather than as
 * a part exporting the wrong thing.
 */
function construct(part: PartRef): ErasedContribution {
    const value = part.contribution;

    if (typeof value === 'function' && (value as { prototype?: unknown }).prototype !== undefined) {
        return new (value as new (options?: unknown) => ErasedContribution)(part.options);
    }
    return value as ErasedContribution;
}

/** The element the page did not have to contain. */
function mountRoot(doc: Document): Element {
    const created = doc.createElement('div');
    created.id = 'mesh-web-root';
    // Filling the viewport in windowed/tiled modes; single mode is ordinary document flow.
    // Base styles live in kernel.css; min-height: 100% ensures an unstyled page doesn't collapse.
    created.style.cssText = 'position:relative;width:100%;min-height:100%';
    doc.body.append(created);
    return created;
}

/**
 * Where the API is, from the document.
 *
 * `data-api` on `<html>`, written by whoever generated the page. Read here rather than passed twice,
 * so a composition that omits `api` still works and the two can never disagree.
 */
const readApi = (doc: Document): string =>
    (doc.documentElement as HTMLElement | null)?.dataset['api'] ?? '';

/**
 * Notifications, on a surface the kernel owns.
 *
 * A capability with no surface is a silent failure: `cx.notifications.warn(...)` would be called
 * correctly, recorded correctly, and displayed nowhere — so a failed API call would look exactly
 * like a button that did nothing. The console had to build this itself, against an element the page
 * was expected to contain.
 */
function mountNotifications(doc: Document, root: Element, kernel: Kernel): Element {
    const host = doc.createElement('div');
    host.className = 'mesh-notifications';
    root.append(host);

    effect(() => {
        host.replaceChildren();
        for (const notice of kernel.services.notifications()) {
            const line = doc.createElement('div');
            line.className = `mesh-notice ${notice.level}`;
            line.textContent = `${notice.source}: ${notice.message}`;
            host.append(line);
        }
    });

    return host;
}

/**
 * Start what the site asked for.
 *
 * A failure is recorded and does not stop the others: one Application that cannot start is a missing
 * window, and taking the whole page down with it would turn a broken part into a broken site.
 *
 * **Two different failures, and only one of them throws.** `kernel.start` catches an Application
 * whose `start()` rejects and leaves the process in `failed` — *"a resting state, not a
 * disappearance"*, because an Application that vanishes on error is one nobody can debug. So it
 * returns a pid either way, and the process table is what has to be read. It *does* throw for an
 * application id nothing declared, which is a composition naming a part it does not have.
 */
async function open(
    kernel: Kernel,
    composition: Composition,
    manager: WindowManager,
    persistence: WindowPersistence,
): Promise<void> {
    const wanted = composition.open ?? defaultOpen(kernel);

    if (wanted.length === 0 && composition.parts.length > 0) {
        // Never silent. A composition with parts that opens nothing is a site that will render an
        // empty page, and the reason has to be visible somewhere other than a debugger.
        kernel.services.logs.push({
            level: 'warn',
            source: 'kernel',
            message: `This composition has ${String(composition.parts.length)} part(s) and no `
                + 'Application among them, so nothing was opened. An Application declares `views`; '
                + 'an Extension is never opened.',
        });
    }

    for (const entry of wanted) {
        let pid: string;
        try {
            pid = await kernel.start(entry.application);
        } catch (cause) {
            kernel.services.logs.push({
                level: 'error',
                source: entry.application,
                message: 'is named in this composition and is not in it',
                data: cause,
            });
            continue;
        }

        const process = kernel.processes.find((p) => p.pid === pid);
        if (process?.state === 'failed') {
            // Surfaced here rather than left in the table. A window that never appears is otherwise
            // indistinguishable from one the site did not ask for.
            kernel.services.logs.push({
                level: 'error',
                source: entry.application,
                message: 'did not start',
                data: process.error,
            });
            continue;
        }

        for (const view of entry.views ?? []) {
            kernel.services.windows.open(pid, view, {});
        }
    }

    await restoreGeometry(kernel, manager, persistence);
    applyLayout(kernel, manager);
}

/**
 * Give the window manager the layout an Application declared.
 *
 * **`setLayout` was called by nothing.** An Application declared `layout`, `mergeManifests`
 * collected it into `manifest.layouts`, `WindowManager.setLayout` existed to receive it — and no
 * code joined the three, so `layout()` was `undefined` for the life of every page. Tiled mode
 * therefore had nothing to tile: the mode switched, the button's label changed, and not one window
 * moved. Reported exactly that way.
 *
 * The first Application with a layout wins, which is a placeholder for the real rule.
 * [application §9](../../spec/application.md) says the *foreground* Application's layout governs and
 * a background one keeps its own — that needs the router, because what is foreground is a routing
 * question. Until then a composition with one tiling Application behaves correctly and one with two
 * takes the first, rather than every composition behaving as if none had a layout at all.
 */
function applyLayout(kernel: Kernel, manager: WindowManager): void {
    if (manager.layout() !== undefined) return;

    for (const application of kernel.applications) {
        const layout = kernel.manifest.layouts.get(application);
        if (layout !== undefined) {
            manager.setLayout(layout);
            return;
        }
    }
}

/**
 * Put windows back where this device left them.
 *
 * **After the Applications have started**, because a saved geometry names a *view*, and a view has
 * nothing to be applied to until the Application that declares it is running and has opened its
 * windows. An Application that opens its own windows during `start()` is therefore covered too.
 *
 * Matched by view id, not by window id: window ids are minted per boot, so they cannot survive a
 * reload — which is exactly why `RememberedWindow` stores `view` and not `id`.
 *
 * Anything unmatched is skipped in silence. A remembered window whose view no longer exists is the
 * ordinary consequence of a part being upgraded or removed, not an error worth showing anybody.
 */
async function restoreGeometry(
    kernel: Kernel,
    manager: WindowManager,
    persistence: WindowPersistence,
): Promise<void> {
    let remembered: readonly RememberedWindow[];
    try {
        remembered = await persistence.restore();
    } catch (error) {
        // Geometry is a convenience. A hive that cannot be read must not stop a page from booting.
        kernel.services.logs.push({
            level: 'warn', source: 'window-manager',
            message: 'could not read saved window geometry', data: error,
        });
        return;
    }

    for (const saved of remembered) {
        const record = manager.windows().find((w) => w.view === saved.view);
        if (record === undefined) continue;

        manager.place(record.id, {
            x: saved.x, y: saved.y, width: saved.width, height: saved.height,
        });
        if (saved.state === 'maximized') manager.maximize(record.id);
        if (saved.state === 'minimized') manager.minimize(record.id);
    }
}

/**
 * Every Application in the composition, with no views. See `Composition.open`.
 *
 * **Asked of the kernel, after `boot`.** This used to read `composition.parts` directly and skip any
 * whose contribution was `typeof 'function'`, on the reasoning that only an instance can be
 * classified and construction happens inside `boot`. Both halves were true and the conclusion was
 * wrong: a part that takes options is exported as a *class*, which is the ordinary case rather than
 * the exception, so the filter removed nearly everything and `open` iterated an empty list. A site
 * with one Application started nothing, logged nothing, and rendered a black page — indistinguishable
 * from a site that asked for nothing, because that is exactly what it had become.
 *
 * `boot` has already run by the time this is called, so the kernel knows what each part turned out to
 * be. There was never a need to guess from the export.
 */
type OpenEntry = NonNullable<Composition['open']>[number];

const defaultOpen = (kernel: Kernel): readonly OpenEntry[] =>
    kernel.applications.map((application) => ({ application }));

// ---------------------------------------------------------------------------- keyboard

/**
 * Declared key bindings, actually bound.
 *
 * **`bindingTable` existed, `manifest.bindings` was collected, and nothing listened.** So every
 * `keys` declaration in every Application was inert: the clock declared `ctrl+t` to toggle its
 * format, the manifest recorded it, collisions between two Applications claiming one chord were
 * detected and reported — and pressing the key did nothing, because no `keydown` handler was ever
 * installed. Three mechanisms, none of them reachable, and a green suite over all of it.
 *
 * It also left `spec/input.md` §3 — *every action has a non-pointer path* — false at the window
 * layer: a window could be closed and maximized only with a pointer. The rule that gated the whole
 * primitive vocabulary was not being kept by the thing the vocabulary renders into.
 *
 * The window commands below are the kernel's own, registered under `window.*` so an Application
 * cannot claim them and a site can rebind them like anything else.
 */
function mountKeys(
    doc: Document,
    kernel: Kernel,
    manager: WindowManager,
    persistence?: WindowPersistence,
): () => void {
    /**
     * Kernel commands, and the reason they are commands rather than key handlers.
     *
     * A command is nameable, so it can appear in a menu, be bound to a different chord by a site,
     * or be invoked by a part. A key handler is only a key. Everything the framework asks of an
     * Application — *declare it, do not register it* — applies to the framework too.
     */
    const focused = (): string | undefined => manager.focused();

    const windowCommands: Record<string, () => void> = {
        'window.close': () => {
            if (manager.mode() === 'single') return;
            const id = focused();
            if (id !== undefined) manager.close(id);
        },
        'window.maximize': () => {
            if (manager.mode() === 'single') return;
            const id = focused();
            if (id === undefined) return;
            // One binding, both directions — the same reasoning as the title bar's single button.
            manager.get(id)?.state === 'maximized' ? manager.restore(id) : manager.maximize(id);
        },
        'window.minimize': () => {
            if (manager.mode() === 'single') return;
            const id = focused();
            if (id !== undefined) manager.minimize(id);
        },
        'window.cycle': () => {
            if (manager.mode() === 'single') return;
            // Back to front, so cycling walks *away* from the current window rather than toggling
            // between the top two — which is what a stack ordered by focus would otherwise do.
            const open = manager.visible();
            if (open.length < 2) return;
            const at = open.findIndex((w) => w.id === focused());
            manager.focus(open[(at + 1) % open.length]!.id);
        },
        'window.mode': () => {
            if (manager.mode() === 'single') return;
            const next = manager.mode() === 'tiled' ? 'windowed' : 'tiled';
            if (persistence !== undefined) {
                void persistence.setMode(next).catch((error) => {
                    if (error instanceof SettingLocked) {
                        const id = String(Date.now());
                        const list = kernel.services.notifications;
                        list.set([...list(), { id, level: 'warn', source: 'window-manager', message: error.message }]);
                    }
                });
            } else {
                manager.setMode(next);
            }
        },
    };

    /**
     * Defaults, chosen against `BROWSER_TAB_RESERVED`.
     *
     * `ctrl+w` closes a browser tab and `ctrl+n` opens a window, so neither can mean anything here —
     * a binding that fires the command *and* the browser's own action is worse than no binding.
     * `alt` is the escape hatch a page actually owns.
     */
    const defaults: readonly { binding: string; command: string }[] = [
        { binding: 'alt+w', command: 'window.close' },
        { binding: 'alt+m', command: 'window.maximize' },
        { binding: 'alt+n', command: 'window.minimize' },
        { binding: 'alt+`', command: 'window.cycle' },
        { binding: 'alt+t', command: 'window.mode' },
    ];

    const onKey = (event: KeyboardEvent): void => {
        // A binding must never eat what somebody is typing. The window layer has no business
        // knowing about text fields, but it has less business stealing a keystroke from one.
        const target = event.target;
        if (target instanceof HTMLElement
            && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) {
            // Except a chord with a modifier, which is not text by definition.
            if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
        }

        const declared = [...kernel.manifest.bindings].map(([binding, entry]) => ({
            binding, command: entry.decl.command,
        }));
        const table = bindingTable([...defaults, ...declared]);

        const command = table.resolve(event);
        if (command === undefined) return;

        const builtin = windowCommands[command];
        if (builtin !== undefined) {
            event.preventDefault();
            builtin();
            return;
        }

        const declaredCommand = kernel.services.commands.get(command);
        if (declaredCommand === undefined) return;

        event.preventDefault();
        void declaredCommand.run();
    };

    doc.addEventListener('keydown', onKey);
    return () => { doc.removeEventListener('keydown', onKey); };
}
