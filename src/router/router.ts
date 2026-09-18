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
 * (`start.ts`) — and never replaced afterward, unlike an earlier version of this that constructed it
 * only after every Application had started and swapped it into `kernel.services.router` then.
 *
 * **That swap was a real bug, not just late wiring.** `ConsoleChrome`'s switcher reads `cx.router`
 * during its first render, which happens after `boot()` but before `open()` has started anything —
 * so it captured the *pre-swap* capability. Reassigning `services.router` to a new object afterward
 * changed what the capability's own functions read, but nothing re-runs the render tree just because
 * a plain property was reassigned elsewhere — only a `Signal` write does that, and the swap was not
 * one. The switcher rendered once, against a router that would never again be read from.
 *
 * The fix is the same shape every other capability here already uses: **one object, whose signals
 * are written in place.** `applications()` stays a live read of `kernel.applications` (accurate
 * whenever called, even before `resync()` — `boot()` has already populated it). `current` is a
 * `Signal`, seeded empty here and given its first real value by an explicit `resync()` call once
 * `kernel.processes` means something — `start.ts` calls it right after `open()`'s Applications have
 * started. A `popstate` after that calls the same `syncFromLocation` through the listener registered
 * here.
 *
 * `dispose()` (beyond the `RouterSink` surface itself) drops the `popstate` listener — `start.ts`'s
 * `dispose()` calls it alongside everything else it tears down.
 */
export function routerSink(
    kernel: Kernel,
    manager: WindowManager,
    history: HistoryLike,
): RouterSink & { resync(): void; dispose(): void } {
    // A signal, not a plain variable: `Router.current()` is read inside `each`/`when`/`text` in a
    // switcher's render tree (same reason `Chrome.focused()` wraps `WindowManager.focused`, a real
    // Signal, rather than a snapshot) -- a plain variable would leave the switcher showing whichever
    // Application was current when it first rendered.
    const current = signal<string | undefined>(undefined);

    const pidsOf = (applicationId: string): ReadonlySet<string> => new Set(
        kernel.processes
            .filter((p) => p.applicationId === applicationId && p.state === 'running')
            .map((p) => p.pid),
    );

    /**
     * `restrict` is the difference between *reporting* a current Application and *hiding everyone
     * else's windows over it* — found live, by a pre-existing test that composes two Applications
     * with no chrome and no switcher, and means for both to share one ordinary window pool (single
     * mode's "most recently focused wins", across both). Restricting on every multi-Application boot
     * regardless of whether anything asked to switch between them broke exactly that: a composition
     * nobody has navigated in yet is not the same thing as a composition that chose an Application.
     *
     * So an unmatched URL (a first boot with nothing router-aware linking anywhere, which is what
     * `single.browser.test.ts`'s composition is) still reports the first Application as `current` --
     * a switcher needs *something* to highlight -- but leaves every window visible, matching the
     * behavior every composition had before this existed. Only a URL that actually names an
     * Application, or an explicit `navigate()` (a switcher button, a link), narrows `foreground` for
     * real.
     */
    const applyCurrent = (applicationId: string | undefined, restrict: boolean): void => {
        current.set(applicationId);
        manager.setForeground(
            restrict && applicationId !== undefined ? pidsOf(applicationId) : undefined,
        );
    };

    const syncFromLocation = (): void => {
        const match = parsePath(history.pathname(), history.search(), kernel.applications);
        applyCurrent(match?.applicationId ?? kernel.applications[0], match !== undefined);
    };

    const unsubscribe = history.onChange(syncFromLocation);

    return {
        applications: (): readonly RouterApplication[] => kernel.applications.map((id) => ({
            id,
            title: kernel.manifest.titles.get(id) ?? id,
        })),
        current: () => current(),
        navigate(applicationId, view?: string, params?: Readonly<Record<string, Json>>) {
            if (!kernel.applications.includes(applicationId)) {
                throw new Error(
                    `Cannot navigate to "${applicationId}": no Application by that id is loaded.`,
                );
            }
            history.push(formatPath(applicationId, view, params));
            applyCurrent(applicationId, true);
        },
        back: () => { history.back(); },
        resync: syncFromLocation,
        dispose: unsubscribe,
    };
}
