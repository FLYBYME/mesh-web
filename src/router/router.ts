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
 * Builds the real `RouterSink`: parses the current location against `kernel.applications` on
 * construction and on every `popstate`, and drives `WindowManager.setForeground` from the result.
 *
 * `dispose()` (beyond the `RouterSink` surface itself) drops the `popstate` listener — `start.ts`'s
 * `dispose()` calls it alongside everything else it tears down.
 */
export function routerSink(
    kernel: Kernel,
    manager: WindowManager,
    history: HistoryLike,
): RouterSink & { dispose(): void } {
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

    const applyCurrent = (applicationId: string | undefined): void => {
        current.set(applicationId);
        manager.setForeground(applicationId === undefined ? undefined : pidsOf(applicationId));
    };

    // No route in the URL yet (a first boot, or a site not yet linking anywhere) falls back to the
    // first Application — the same "first wins" precedent `applyLayout` already sets for a
    // composition's declared layouts, so a site with no router-aware links behaves as it always has.
    const syncFromLocation = (): void => {
        const match = parsePath(history.pathname(), history.search(), kernel.applications);
        applyCurrent(match?.applicationId ?? kernel.applications[0]);
    };

    syncFromLocation();
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
            applyCurrent(applicationId);
        },
        back: () => { history.back(); },
        dispose: unsubscribe,
    };
}
