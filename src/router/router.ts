/**
 * The adapter between the kernel's `router` capability and the real window manager plus browser
 * history — same relationship `window/sink.ts` has to the window manager, and the same reason: the
 * broker never imports either, so a kernel can be booted with `recordingRouter()` and no browser at
 * all (most of this repository's own tests), and with the real thing only where one is running.
 */

import type { Kernel } from '../kernel/kernel.js';
import type { RouterSink } from '../kernel/broker.js';
import type { RouterApplication } from '../contribution/capabilities.js';
import type { WindowManager } from '../window/manager.js';
import type { Json } from '../description/types.js';
import { signal } from '../reactivity/index.js';
import { formatPath, parsePath } from './match.js';

/** What `router.ts` needs from a browser's `history`/`location` — narrow, so a test can fake it. */
export interface HistoryLike {
    pathname(): string;
    search(): string;
    push(path: string): void;
    back(): void;
    /** Fires on a browser back/forward navigation. Returns the unsubscribe. */
    onChange(fn: () => void): () => void;
}

export function browserHistory(win: Window): HistoryLike {
    return {
        pathname: () => win.location.pathname,
        search: () => win.location.search,
        push: (path) => { win.history.pushState({}, '', path); },
        back: () => { win.history.back(); },
        onChange: (fn) => {
            win.addEventListener('popstate', fn);
            return () => { win.removeEventListener('popstate', fn); };
        },
    };
}

/**
 * Builds the real `RouterSink`. Wired once, before `kernel.boot()` — the same moment `windowSink` is
 * (`start.ts`) — and never replaced afterward. An earlier version constructed it only after every
 * Application had started and swapped it into `kernel.services.router` then, which broke the
 * switcher's own reactivity (a plain property reassignment doesn't re-run anything that already
 * rendered) — see the git history on this file for that one.
 *
 * **`current()` is computed fresh from the URL on every call, not a value `resync()` sets.** A second
 * bug lived here after the first was fixed: `current` used to start `undefined` and stay that way
 * until something explicitly called `resync()`/`navigate()`. `ConsoleChrome` (mesh-core) uses
 * `current() === undefined` as its signal for "nothing has picked an Application yet, so pick the
 * first one" -- and that check ran during its own `activate()`, before anything had ever resynced,
 * so it *always* saw `undefined` and *always* overwrote whatever the page's real URL already said.
 * Loading `/platform/gitserver` directly bounced to `/platform/domains` every time. Fixed by making
 * `current()` itself resolve `explicit ?? matchFromURL() ?? kernel.applications[0]` on every read --
 * by the time anything can call it (after `kernel.boot()`, which populates `kernel.applications`
 * before activating a single Extension), a real URL match is already there to find, so a chrome
 * checking "has anything chosen yet" gets a true answer instead of a stale default.
 */
export function routerSink(
    kernel: Kernel,
    manager: WindowManager,
    history: HistoryLike,
): RouterSink & { resync(): void; dispose(): void } {
    /** Set only by `navigate()`. `undefined` means "nothing has explicitly chosen; read the URL." */
    let explicit: string | undefined;

    /**
     * Bumped by `navigate()` and by a browser back/forward, for no reason but to be *read* by
     * `current()` below -- an invalidation tick, not a value anyone consumes. `current()`'s own
     * computation reads `history.pathname()` and `kernel.applications`, neither of which is a
     * `Signal`, so nothing would tell a switcher's `each`/`when`/`text` to look again without this.
     */
    const tick = signal(0);

    const matchFromURL = (): string | undefined =>
        parsePath(history.pathname(), history.search(), kernel.applications)?.applicationId;

    const currentValue = (): string | undefined => explicit ?? matchFromURL() ?? kernel.applications[0];

    /** Whether `currentValue()` came from something that actually chose it, not just a fallback. */
    const shouldRestrict = (): boolean => explicit !== undefined || matchFromURL() !== undefined;

    const pidsOf = (applicationId: string): ReadonlySet<string> => new Set(
        kernel.processes
            .filter((p) => p.applicationId === applicationId && p.state === 'running')
            .map((p) => p.pid),
    );

    /**
     * The difference between *reporting* a current Application and *hiding everyone else's windows
     * over it* -- found live, by a pre-existing test that composes two Applications with no chrome
     * and no switcher, meaning both to share one ordinary window pool (single mode's "most recently
     * focused wins", across both). Restricting on every multi-Application boot regardless of whether
     * anything asked to switch between them broke exactly that. So `shouldRestrict()` -- a URL that
     * actually names an Application, or an explicit `navigate()` -- gates this; the fallback-to-first
     * case above still reports something for a switcher to highlight, but leaves every window visible.
     */
    const applyForeground = (): void => {
        const id = currentValue();
        manager.setForeground(shouldRestrict() && id !== undefined ? pidsOf(id) : undefined);
    };

    const onLocationChange = (): void => {
        applyForeground();
        tick.set(tick() + 1);
    };

    // Harmless when `kernel.applications` is still empty (real `start.ts` usage, constructed before
    // `kernel.boot()`): `matchFromURL()` finds nothing, `currentValue()` is `undefined`,
    // `setForeground(undefined)` is already the default. Correct immediately, though, wherever
    // applications already exist at construction time -- every test in this file.
    applyForeground();
    const unsubscribe = history.onChange(onLocationChange);

    return {
        applications: (): readonly RouterApplication[] => kernel.applications.map((id) => ({
            id,
            title: kernel.manifest.titles.get(id) ?? id,
        })),
        current: () => { tick(); return currentValue(); },
        navigate(applicationId, view?: string, params?: Readonly<Record<string, Json>>) {
            if (!kernel.applications.includes(applicationId)) {
                throw new Error(
                    `Cannot navigate to "${applicationId}": no Application by that id is loaded.`,
                );
            }
            const path = formatPath(applicationId, view, params);
            // Skip a redundant history entry when this is exactly where the URL already resolves to
            // -- ConsoleChrome calls navigate(current()) unconditionally on activation (see its own
            // comment), and a page loaded at a real deep link should not gain a duplicate back-stop.
            if (path !== `${history.pathname()}${history.search()}`) history.push(path);
            explicit = applicationId;
            applyForeground();
            tick.set(tick() + 1);
        },
        back: () => { history.back(); },
        // `resync`: re-applies foreground now that `kernel.processes` means something -- called once
        // by `start.ts` right after `open()`'s Applications have actually started. `current()`/
        // `applications()` never needed this (both compute fresh on every call already); only
        // `manager.setForeground`, an imperative call nothing else re-triggers, does.
        resync: applyForeground,
        dispose: unsubscribe,
    };
}
