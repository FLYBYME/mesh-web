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

import { isApplication } from '../contribution/contract.js';
import type { ErasedContribution } from '../contribution/contract.js';
import { effect } from '../reactivity/index.js';
import { createRegistry as createComponents, PRIMITIVES } from '../render/component.js';
import type { ComponentRegistry } from '../render/component.js';
import { createClient, fetchTransport, withHeaders } from '../net/client.js';
import type { MeshClient } from '../net/client.js';
import type { AnyApiCall, Api } from '../net/api.js';
import { createRegistry as createSettings } from '../registry/registry.js';
import type { Registry } from '../registry/registry.js';
import type { BuildPolicy } from '../registry/hives.js';
import { localProvider, memoryProvider } from '../registry/providers.js';
import { mountPage, PAGE_CHROME } from '../window/page.js';
import type { Page } from '../window/page.js';
import { windowPersistence } from '../window/persistence.js';
import { windowSink } from '../window/sink.js';
import { WindowManager } from '../window/manager.js';
import type { Action } from '../description/types.js';
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
    readonly contribution: ErasedContribution | (new (options?: unknown) => ErasedContribution);
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

    const services = createServices(undefined, { apiOrigin: api });
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
        hives: {
            system: { provider: memoryProvider('system'), writable: false },
            user: { provider: memoryProvider('user'), writable: true },
            device: { provider: localProvider(), writable: true },
            session: { provider: memoryProvider('session'), writable: true },
        },
        onError: (error, { path }) => {
            kernel.services.logs.push({ level: 'warn', source: 'registry', message: path, data: error });
        },
    });

    windowPersistence({ manager, registry: settings, application: composition.application });

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
        render: { components, dispatch: { dispatch: run } },
        onCommand: run,
    });

    const notifications = mountNotifications(doc, root, kernel);

    // A resize is the viewport changing under the manager, which clamps every window back inside it.
    const host = composition.window ?? globalThis.window;
    host?.addEventListener('resize', () => {
        manager.setViewport({ width: root.clientWidth, height: root.clientHeight });
    });

    return {
        kernel, manager, page, settings, components,
        ready: open(kernel, composition),
        dispose() {
            page.dispose();
            notifications.remove();
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
    // Filling the viewport, because the window manager measures its host and a host with no height
    // clamps every window to nothing — a blank page whose only symptom is that nothing is visible.
    created.style.cssText = 'position:relative;width:100%;height:100vh;overflow:hidden';
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
async function open(kernel: Kernel, composition: Composition): Promise<void> {
    const wanted = composition.open ?? defaultOpen(composition);

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
}

/**
 * Every Application in the composition, with no views. See `Composition.open`.
 *
 * Only instances can be classified: a class has to be constructed before anything can tell what it
 * is, and construction happens once, inside `boot`. So a site whose parts export constructors — the
 * ordinary case for anything taking options — must name what to open. That is a real limitation and
 * the alternative is worse: constructing every part twice, once to ask what it is.
 */
type OpenEntry = NonNullable<Composition['open']>[number];

const defaultOpen = (composition: Composition): readonly OpenEntry[] =>
    composition.parts
        .filter((part) => {
            const value = part.contribution;
            return typeof value !== 'function' && isApplication(value);
        })
        .map((part) => ({ application: part.id }));
