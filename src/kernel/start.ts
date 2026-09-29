/**
 * `start(composition)` — the kernel's entry point, and the one mesh-serve's boot script calls.
 *
 * ## What it boots
 *
 * An App (docs/app-model.md). The generated boot module is unchanged from the part era:
 *
 * ```js
 * import { start } from '/_a/9f2c1a/index.js';
 * import part0 from '/_a/3ab77e/index.js';
 *
 * start({
 *     application: 'company-site',
 *     api: document.documentElement.dataset.api ?? '',
 *     policy: { 'window-manager/mode': 'single' },
 *     parts: [{ id: 'company-site', contribution: part0 }],
 * });
 * ```
 *
 * `start` finds the part whose default export is an App and boots it: its `needs` become a real
 * context, then it mounts as a single-page site — or, when the site's policy asks for windows, as a
 * desktop. Anything else in `parts` is from the legacy model (Applications, Extensions), which no
 * longer boots; it is reported, not silently dropped (phase 5c, A1).
 *
 * ## The undeclared contracts it removes
 *
 * A hand-written page and a bundle once agreed on things nothing declared: a `#console` element, a
 * `#notifications` element, `data-api`. **The kernel creates what it mounts into**, mounts its own
 * notification surface, and reads the API from the document rather than being told twice. The import
 * map and the stylesheet stay with the page — they are what a browser needs before any of this runs.
 */

import type { ProviderToken } from '../contribution/provider.js';
import { effect } from '../reactivity/index.js';
import { IoManager } from './io.js';
import { STORAGE } from '../registry/storage-driver.js';
import { HOST_WINDOW_DRIVER, ONLINE_DRIVER } from './drivers.js';
import { createHostWindowDriver, createOnlineDriver } from './default-drivers.js';
import { createClient, fetchTransport, withHeaders } from '../net/client.js';
import { createFetchEventSource } from '../net/eventsource.js';
import type { MeshClient } from '../net/client.js';
import type { AnyApiCall, Api } from '../net/api.js';
import type { BuildPolicy, HiveBindings } from '../registry/hives.js';
import { localProvider, memoryProvider } from '../registry/providers.js';
import { domConfirm } from './confirm.js';
import { createContext, createServices, type KernelServices } from './broker.js';
import { mountSite, type MountedApp } from '../app/site.js';
import { mountDesktop, type MountedDesktop } from '../app/desktop.js';
import type { AppClass } from '../app/runtime.js';
import { kernelLog, mountLogViewer, reasonOf, type LogViewer } from './logs.js';

/** One part in a composition: an id, the module's default export, and the site's options for it. */
export interface PartRef {
    readonly id: string;
    /** The default export. An App class is booted; anything else is reported and not booted. */
    readonly contribution: unknown;
    /** From the site record, never from the part. */
    readonly options?: unknown;
}

export interface Composition {
    /** Names this page — in logs, and for anything that namespaces by site. */
    readonly application: string;
    /**
     * Where `mesh` sends requests. `''` means same origin.
     *
     * The one value a page cannot discover at run time; absent, it is read from `data-api` on
     * `<html>`, so one part artifact serves every site.
     */
    readonly api?: string;
    /**
     * Values frozen into this deployment. `{ 'window-manager/mode': 'windowed' }` (or `'tiled'`) boots
     * the App as a desktop; anything else, or nothing, as a single-page site.
     */
    readonly policy?: BuildPolicy;
    readonly parts: readonly PartRef[];
    /** Where to mount. **Created if absent**: a page should not have to contain an element for a bundle to find. */
    readonly root?: Element;
    /**
     * Legacy: which Applications to open. Accepted so an existing boot script still runs; an App opens
     * whatever its URL routes to, so there is nothing for this to do.
     */
    readonly open?: readonly { readonly application: string; readonly views?: readonly string[] }[];
    readonly hives?: HiveBindings;
    readonly logCapacity?: number;
}

/** What `start` returns. */
export interface Started {
    readonly kind: 'app';
    /** The page's services — logs, notifications, credentials — and its drivers. */
    readonly services: KernelServices;
    readonly io: IoManager;
    /** The single-page site, or — when the policy asks for windows — the desktop (it has a `manager`). */
    readonly site: MountedApp | MountedDesktop;
    /** The kernel's log panel (ctrl+alt+q). */
    readonly logViewer: LogViewer;
    /** Resolved: an App's first view is mounted synchronously. Kept so a boot script can await either way. */
    readonly ready: Promise<void>;
    dispose(): void;
}

/** Whether a part's default export is an App (docs/app-model.md). */
export function isAppClass(contribution: unknown): contribution is AppClass {
    return typeof contribution === 'function' && 'kind' in contribution && contribution.kind === 'app';
}

export function start(composition: Composition): Started {
    const doc = composition.root?.ownerDocument ?? globalThis.document;
    const api = composition.api ?? readApi(doc);

    const apps = composition.parts.filter((part) => isAppClass(part.contribution));
    const legacy = composition.parts.filter((part) => !isAppClass(part.contribution)).map((part) => part.id);
    const first = apps[0];
    if (first === undefined || !isAppClass(first.contribution)) {
        throw new Error(
            `${composition.application}: no part is an App, so there is nothing to boot` +
            (legacy.length > 0 ? ` (${legacy.join(', ')} ${legacy.length === 1 ? 'is' : 'are'} from the legacy part model, which no longer boots).` : '.'),
        );
    }

    // A root `start` made is `start`'s to remove; one it was given belongs to the page.
    const created = composition.root === undefined;
    const root = composition.root ?? mountRoot(doc);
    const page = createPage(composition, doc, api);
    const log = kernelLog(page.services.logs);
    if (legacy.length > 0) {
        log.warn(`Not booted — legacy parts: ${legacy.join(', ')}. Only an App boots.`, { part: first.id });
    }
    if (apps.length > 1) {
        log.warn(`More than one App in the composition; booting ${first.id} only.`, { part: first.id });
    }
    const started = startApp(first.contribution, first.id, composition, page, doc, root);
    if (!created) return started;
    return {
        ...started,
        dispose() {
            started.dispose();
            root.remove();
        },
    };
}

// ---------------------------------------------------------------------------- the page's services

interface Page {
    readonly services: KernelServices;
    readonly io: IoManager;
}

/** The page's services — storage hives, drivers, the API client, logs, credentials. */
function createPage(composition: Composition, doc: Document, api: string): Page {
    const io = new IoManager();
    if (io.get(STORAGE) === undefined) {
        const hives = composition.hives ?? {
            system: { provider: memoryProvider('system'), writable: false },
            user: { provider: memoryProvider('user'), writable: true },
            device: { provider: localProvider(), writable: true },
            session: { provider: memoryProvider('session'), writable: true },
        };
        io.register(STORAGE, hives);
        io.register(HOST_WINDOW_DRIVER, createHostWindowDriver());
        io.register(ONLINE_DRIVER, createOnlineDriver());
    }
    const hives = io.resolve(STORAGE);

    const services: KernelServices = createServices(undefined, {
        apiOrigin: api,
        hives,
        logCapacity: composition.logCapacity,
        // Installed by the page, never by the part that asks — that separation is the only reason
        // `confirmation` is worth having.
        confirm: domConfirm(doc),
        /**
         * **Live collections, which until this was supplied were switched off on every real page.**
         *
         * `createModels` takes an `eventSource` factory and passes it to `createEventStreamClient`,
         * which returns `{ isAvailable: false }` when there is none — and a collection is only
         * streamed when `isAvailable`. Nothing supplied one, so `<name>.created|updated|deleted` and
         * refetch-on-reconnect were dead in every deployed site, silently, because a list that never
         * updates looks exactly like a list nothing changed.
         *
         * `createFetchEventSource` rather than the browser's `EventSource` because `/events` is gated
         * and the native class **cannot send a header**; a ticket in the query string would write a
         * live credential into every access log on the way. Headers are read per attempt, so a
         * reconnect after a sign-in uses the ticket that exists then.
         */
        eventSource: (url) => createFetchEventSource(url, {
            headers: () => services.credentials.headers?.() ?? {},
        }),
    });

    /**
     * How a declared API becomes a client, and the one place a credential could be handled.
     *
     * It is not handled here either: `withHeaders` takes a *function*, filled through
     * `needs('credentials')` (the company site's `AuthService`). This installs the seam and never
     * looks through it — a view calls `cx.mesh.call(...)` and its request carries a ticket it has
     * never seen.
     */
    services.meshClient = (declared) => createClient(declared as Api<Record<string, AnyApiCall>>, {
        transport: withHeaders(
            fetchTransport(api),
            () => services.credentials.headers?.() ?? {},
        ),
    }) as MeshClient<unknown>;

    return { services, io };
}

// ---------------------------------------------------------------------------- booting the App

/**
 * The App's `needs` become a real context through the broker's `createContext`, so `cx.mesh` is a
 * client for the App's declared API with the page's credentials, `cx.storage` is the page's hives,
 * `cx.notifications` reaches the surface below. That context is the grant the runtime projects to
 * every service, view and component. (Phase B replaces the broker with platform services.)
 */
function startApp(App: AppClass, partId: string, composition: Composition, page: Page, doc: Document, root: Element): Started {
    const log = kernelLog(page.services.logs);

    const handle = createContext(
        { id: partId, declaredBy: partId },
        App.spec.needs ?? [],
        [],
        <T>(token: ProviderToken<T>): T | undefined => page.io.get(token),
        page.services,
        page.io,
        App.spec.api,
    );

    /**
     * `cx.display`: measured **before** anything is constructed, so a service asking how much room
     * there is at construction is told, rather than 0×0 until somebody resizes something — then
     * again on every window resize and whenever the root's own box changes. The legacy boot did
     * this; the first App boot did not, and `test/display.test.ts` said so.
     */
    const measure = (): void => { page.services.displaySize.set({ width: root.clientWidth, height: root.clientHeight }); };
    measure();
    const win = doc.defaultView;
    win?.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    observer?.observe(root);
    const stopMeasuring = (): void => {
        win?.removeEventListener('resize', measure);
        observer?.disconnect();
    };

    // A website unless the site's policy asks for the desktop: single-page is the default for an App.
    const mode = composition.policy?.['window-manager/mode'];
    let site: MountedApp | MountedDesktop;
    try {
        site = mode === 'windowed' || mode === 'tiled'
            ? mountDesktop(App, { root, granted: handle.context, keys: doc, mode, io: page.io })
            : mountSite(App, { root, granted: handle.context, keys: doc });
    } catch (cause) {
        // Not a blank page. With one App there is nothing else to show, so the page says it could
        // not start and why, and the log panel is there to read — then the error still propagates,
        // loudly, to whatever booted it.
        log.error(`${partId} could not start: ${reasonOf(cause)}`, { part: partId });
        handle.dispose();
        stopMeasuring();
        const notice = doc.createElement('div');
        notice.setAttribute('role', 'alert');
        notice.className = 'mesh-boot-failed';
        notice.textContent = `This page could not start: ${reasonOf(cause)}`;
        root.append(notice);
        mountLogViewer(doc, root, page.services.logs);
        throw cause;
    }

    const notifications = mountNotifications(doc, root, page.services);
    const logViewer = mountLogViewer(doc, root, page.services.logs);
    log.info(`${partId} started`, { part: partId });

    return {
        kind: 'app',
        services: page.services,
        io: page.io,
        site,
        logViewer,
        ready: Promise.resolve(),
        dispose() {
            stopMeasuring();
            site.dispose();
            handle.dispose();
            notifications.dispose();
            logViewer.dispose();
        },
    };
}

/** The element the page did not have to contain. */
function mountRoot(doc: Document): Element {
    const created = doc.createElement('div');
    created.id = 'mesh-web-root';
    // Filling the viewport in windowed/tiled modes; single mode is ordinary document flow.
    created.style.cssText = 'position:relative;width:100%;min-height:100%';
    doc.body.append(created);
    return created;
}

/**
 * Where the API is, from the document: `data-api` on `<html>`, written by whoever generated the page.
 * Read here rather than passed twice, so a composition that omits `api` still works.
 */
const readApi = (doc: Document): string =>
    (doc.documentElement as HTMLElement | null)?.dataset['api'] ?? '';

/**
 * Notifications, on a surface the kernel owns.
 *
 * A capability with no surface is a silent failure: `cx.notifications.warn(...)` would be recorded
 * correctly and displayed nowhere — a failed API call would look exactly like a button that did
 * nothing.
 */
function mountNotifications(doc: Document, root: Element, services: KernelServices): { dispose(): void } {
    const host = doc.createElement('div');
    host.className = 'mesh-notifications';
    root.append(host);

    const stop = effect(() => {
        host.replaceChildren();
        for (const notice of services.notifications()) {
            const line = doc.createElement('div');
            line.className = `mesh-notice ${notice.level}`;
            line.textContent = `${notice.source}: ${notice.message}`;
            host.append(line);
        }
    });

    return {
        dispose() {
            stop();
            host.remove();
        },
    };
}
