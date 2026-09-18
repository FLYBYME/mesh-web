/**
 * `parsePath`/`formatPath` — the pure half of the router (`src/router/match.ts`). No DOM, no
 * `WindowManager`, no `Kernel`: application ids are namespaced (`platform/repo`) and already look
 * like path segments, and this is the whole of the rule that turns one into the other.
 */
import { describe, expect, it } from 'vitest';

import { formatPath, parsePath } from '../src/router/match.js';

const IDS = ['platform/repo', 'platform/gitserver', 'blog'];

describe('parsePath', () => {
    it('matches a single-segment application id', () => {
        expect(parsePath('/blog', '', IDS)?.applicationId).toBe('blog');
    });

    it('matches a namespaced application id across several segments', () => {
        expect(parsePath('/platform/repo', '', IDS)?.applicationId).toBe('platform/repo');
    });

    it('prefers the longer of two ids that share a prefix', () => {
        const ids = ['platform', 'platform/repo'];
        expect(parsePath('/platform/repo', '', ids)?.applicationId).toBe('platform/repo');
        expect(parsePath('/platform/repo/extra', '', ids)?.applicationId).toBe('platform/repo');
    });

    it('carries the remaining segment as the view', () => {
        expect(parsePath('/platform/repo/settings', '', IDS)?.view).toBe('settings');
        expect(parsePath('/blog', '', IDS)?.view).toBeUndefined();
    });

    it('reads query params off the search string', () => {
        expect(parsePath('/blog', '?id=42&name=x', IDS)?.params).toEqual({ id: '42', name: 'x' });
    });

    it('returns undefined for a path matching no known application', () => {
        expect(parsePath('/nothing-here', '', IDS)).toBeUndefined();
    });

    it('ignores extra leading/trailing slashes', () => {
        expect(parsePath('//platform/repo/', '', IDS)?.applicationId).toBe('platform/repo');
    });
});

describe('formatPath', () => {
    it('formats an application id alone', () => {
        expect(formatPath('platform/repo')).toBe('/platform/repo');
    });

    it('appends the view as a segment', () => {
        expect(formatPath('platform/repo', 'settings')).toBe('/platform/repo/settings');
    });

    it('appends params as a query string', () => {
        expect(formatPath('blog', undefined, { id: '42' })).toBe('/blog?id=42');
    });

    it('round-trips through parsePath', () => {
        const path = formatPath('platform/repo', 'settings', { id: '42' });
        const [pathname, search] = path.split('?');
        const match = parsePath(pathname!, `?${search}`, IDS);

        expect(match).toEqual({
            applicationId: 'platform/repo',
            view: 'settings',
            params: { id: '42' },
        });
    });
});
