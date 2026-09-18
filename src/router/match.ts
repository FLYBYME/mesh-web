/**
 * URL <-> {applicationId, view, params}, as pure functions.
 *
 * No DOM here, on purpose: parsing a pathname against a list of ids and formatting one back is
 * ordinary string logic, and keeping it apart from `router.ts` (which owns `history`/`location`) is
 * the same split `window/geometry.ts` draws from `window/manager.ts` — the matching rules are
 * unit-testable on their own, with no `window.location` to fake.
 *
 * Application ids are namespaced (`platform/repo`, per `console.site.schema.ts`'s `PartSpec.key`) and
 * already look like path segments, so this doesn't invent a URL syntax: the pathname's leading
 * segments *are* the application id, for as long as they match one the site actually has. Longest
 * match wins, so a shorter id can never shadow a more specific one that happens to share a prefix.
 */

import type { Json } from '../description/types.js';

export interface RouteMatch {
    readonly applicationId: string;
    readonly view: string | undefined;
    readonly params: Readonly<Record<string, Json>>;
}

const segmentsOf = (path: string): readonly string[] => path.split('/').filter((s) => s.length > 0);

/**
 * `pathname` and `search` come apart because that's how `location` already hands them over — see
 * `router.ts`'s `browserHistory`. Callers with a whole URL split it once, here.
 */
export function parsePath(
    pathname: string,
    search: string,
    applicationIds: readonly string[],
): RouteMatch | undefined {
    const segments = segmentsOf(pathname);

    let best: { readonly id: string; readonly consumed: number } | undefined;
    for (const id of applicationIds) {
        const idSegments = segmentsOf(id);
        if (idSegments.length > segments.length) continue;
        if (idSegments.some((s, i) => s !== segments[i])) continue;
        if (best === undefined || idSegments.length > best.consumed) {
            best = { id, consumed: idSegments.length };
        }
    }
    if (best === undefined) return undefined;

    const rest = segments.slice(best.consumed);
    const params: Record<string, Json> = {};
    for (const [key, value] of new URLSearchParams(search)) params[key] = value;

    return { applicationId: best.id, view: rest[0], params };
}

export function formatPath(
    applicationId: string,
    view?: string,
    params?: Readonly<Record<string, Json>>,
): string {
    const segments = [applicationId, ...(view === undefined ? [] : [view])];
    const path = `/${segments.join('/')}`;
    if (params === undefined || Object.keys(params).length === 0) return path;

    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        query.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    return `${path}?${query.toString()}`;
}
