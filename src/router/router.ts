/**
 * The browser's history, narrowed to what a site needs — so a test can fake it.
 *
 * The app model's routing lives in `src/app/routes.ts` (patterns, typed params) and
 * `src/app/site.ts` / `desktop.ts` (what a URL mounts). This file is only the seam to the browser.
 * The legacy router — `routerSink`, and `match.ts`'s `/<applicationId>/<view>` scheme — went with
 * the part model (docs/app-model.md, phase 5c).
 */

export interface HistoryLike {
    pathname(): string;
    search(): string;
    push(path: string): void;
    /** Replace the current entry: a redirect, so back does not return to the page that redirected. */
    replace(path: string): void;
    back(): void;
    /** Fires on a browser back/forward navigation. Returns the unsubscribe. */
    onChange(fn: () => void): () => void;
}

export function browserHistory(win: Window): HistoryLike {
    return {
        pathname: () => win.location.pathname,
        search: () => win.location.search,
        push: (path) => { win.history.pushState({}, '', path); },
        replace: (path) => { win.history.replaceState({}, '', path); },
        back: () => { win.history.back(); },
        onChange: (fn) => {
            win.addEventListener('popstate', fn);
            return () => { win.removeEventListener('popstate', fn); };
        },
    };
}
