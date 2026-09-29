/**
 * The route table (docs/app-model.md §5, phase 4): `App.spec.routes` compiled into a matcher and a
 * link builder.
 *
 * Replaces `router/match.ts`'s `/<applicationId>/<view>?query` for app-model sites. A path is the
 * site's own — `/domains/example.com/records` — and a route pattern names its params
 * (`/domains/:zone/records`), which the types have already checked against the view's `params`.
 *
 * **Matching includes the view's schema.** A URL whose params do not parse is not a match for that
 * route, and matching carries on to the next one; if nothing matches, it is a 404. So
 * `/users/:id` with a numeric `id` and `/users/:handle` can coexist, and a malformed URL is a
 * not-found page rather than an exception thrown from somewhere inside rendering.
 */

import type { Json } from '../description/types.js';
import type { ViewClass } from './types.js';

type Segment = { readonly kind: 'static'; readonly value: string } | { readonly kind: 'param'; readonly name: string };

interface CompiledRoute {
    readonly pattern: string;
    readonly segments: readonly Segment[];
    readonly view: ViewClass;
}

export interface RouteMatch {
    /** The pattern that matched, e.g. `/domains/:zone/records`. */
    readonly pattern: string;
    readonly view: ViewClass;
    /** Path params, as strings, before the view's `params` schema — what `runtime.view` parses. */
    readonly raw: Readonly<Record<string, string>>;
    /** The query string, as strings, before the view's `query` schema. */
    readonly query: Readonly<Record<string, string>>;
    /**
     * Same route and same **path** params ⇒ same key. The site mounts one view instance per key, so
     * `/domains/a` → `/domains/b` is a new instance (path params are constructor input), while
     * `?page=1` → `?page=2` is the same instance with its `query` updated — a list keeps its scroll,
     * selection and open dialogs when its filters change.
     */
    readonly key: string;
}

export interface RouteTable {
    match(pathname: string, search: string): RouteMatch | undefined;
    /** The URL for a view with these params: path params filled in, everything else as the query. */
    href(view: ViewClass, params?: unknown): string;
}

export function compileRoutes(routes: { readonly [pattern: string]: ViewClass }): RouteTable {
    const declared: CompiledRoute[] = Object.entries(routes).map(([pattern, view]) => ({
        pattern,
        segments: parsePattern(pattern),
        view,
    }));

    const shapes = new Map<string, string>();
    for (const route of declared) {
        const shape = route.segments.map((s) => (s.kind === 'static' ? s.value : ':')).join('/');
        const other = shapes.get(shape);
        if (other !== undefined) {
            // Two patterns that differ only in param names match exactly the same URLs; which one
            // wins would be an accident of declaration order.
            throw new Error(`Routes "${other}" and "${route.pattern}" match the same URLs.`);
        }
        shapes.set(shape, route.pattern);
    }

    // Most specific first: at the first position where two patterns differ, a static segment beats
    // a param. Stable, so otherwise declaration order stands.
    const byPrecedence = [...declared].sort((a, b) => {
        const length = Math.min(a.segments.length, b.segments.length);
        for (let i = 0; i < length; i++) {
            const sa = a.segments[i]?.kind === 'static' ? 1 : 0;
            const sb = b.segments[i]?.kind === 'static' ? 1 : 0;
            if (sa !== sb) return sb - sa;
        }
        return 0;
    });

    return {
        match(pathname, search) {
            const parts = splitPath(pathname);
            if (parts === undefined) return undefined;
            const query = Object.fromEntries(new URLSearchParams(search));

            for (const route of byPrecedence) {
                if (route.segments.length !== parts.length) continue;
                const path: Record<string, string> = {};
                let fits = true;
                for (const [i, segment] of route.segments.entries()) {
                    const part = parts[i] ?? '';
                    if (segment.kind === 'static') {
                        if (segment.value !== part) { fits = false; break; }
                    } else {
                        path[segment.name] = part;
                    }
                }
                if (!fits) continue;

                // Both halves must parse for the route to match; a URL that does not is not found.
                const paramsSchema = route.view.spec.params;
                if (paramsSchema !== undefined && !paramsSchema.safeParse(path).success) continue;
                const querySchema = route.view.spec.query;
                if (querySchema !== undefined && !querySchema.safeParse(query).success) continue;
                return { pattern: route.pattern, view: route.view, raw: path, query, key: `${route.pattern}?${canonical(path)}` };
            }
            return undefined;
        },

        href(view, params) {
            const route = declared.find((r) => r.view === view);
            if (route === undefined) throw new Error(`${view.name} is not routed in this app.`);

            const values = toStrings(params, view.name);
            const used = new Set<string>();
            const path = route.segments.map((segment) => {
                if (segment.kind === 'static') return segment.value;
                const value = values.get(segment.name);
                if (value === undefined) throw new Error(`${route.pattern} needs "${segment.name}" to build a link to ${view.name}.`);
                used.add(segment.name);
                return encodeURIComponent(value);
            });

            const query = new URLSearchParams();
            for (const [name, value] of [...values].sort(([a], [b]) => a.localeCompare(b))) {
                if (!used.has(name)) query.set(name, value);
            }
            const q = query.toString();
            return `/${path.join('/')}${q === '' ? '' : `?${q}`}`;
        },
    };
}

function parsePattern(pattern: string): readonly Segment[] {
    if (!pattern.startsWith('/')) throw new Error(`Route "${pattern}" must start with "/".`);
    const names = new Set<string>();
    return pattern.split('/').filter((s) => s !== '').map((part): Segment => {
        if (!part.startsWith(':')) return { kind: 'static', value: part };
        const name = part.slice(1);
        if (name === '') throw new Error(`Route "${pattern}" has a ":" with no name.`);
        if (names.has(name)) throw new Error(`Route "${pattern}" names ":${name}" twice.`);
        names.add(name);
        return { kind: 'param', name };
    });
}

/** Decoded path segments, or `undefined` for a path that does not decode — which matches nothing. */
function splitPath(pathname: string): readonly string[] | undefined {
    try {
        return pathname.split('/').filter((s) => s !== '').map((s) => decodeURIComponent(s));
    } catch {
        return undefined;
    }
}

function canonical(raw: Readonly<Record<string, string>>): string {
    return Object.keys(raw).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(raw[k] ?? '')}`).join('&');
}

/** Params for a link, as strings. Only what can round-trip through a URL is accepted. */
function toStrings(params: unknown, viewName: string): Map<string, string> {
    const out = new Map<string, string>();
    if (params === undefined || params === null) return out;
    if (typeof params !== 'object') throw new Error(`Link params for ${viewName} must be an object.`);
    for (const [name, value] of Object.entries(params)) {
        if (value === undefined) continue;
        if (!isScalar(value)) throw new Error(`Link param "${name}" for ${viewName} is not a string, number or boolean.`);
        out.set(name, String(value));
    }
    return out;
}

function isScalar(value: unknown): value is Extract<Json, string | number | boolean> {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}
