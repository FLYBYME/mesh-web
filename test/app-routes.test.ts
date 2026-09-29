/**
 * The route table (docs/app-model.md, phase 4): matching, precedence, the view's schema as part of
 * matching, and building links back.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { element, type Node } from '../src/index.js';
import { compileRoutes, View } from '../src/app/index.js';

const nothing = (): Node => element('Stack', { children: [] });

class Home extends View({}) { render(): Node { return nothing(); } }
class New extends View({}) { render(): Node { return nothing(); } }
class User extends View({ params: z.object({ id: z.coerce.number().int().positive() }) }) { render(): Node { return nothing(); } }
class Handle extends View({ params: z.object({ handle: z.string().regex(/^[a-z]+$/) }) }) { render(): Node { return nothing(); } }
class Records extends View({
    params: z.object({ zone: z.string().min(3), page: z.coerce.number().default(1) }),
}) { render(): Node { return nothing(); } }

const table = compileRoutes({
    '/': Home,
    '/users/:id': User,
    '/users/new': New,
    '/people/:handle': Handle,
    '/domains/:zone/records': Records,
});

describe('route table', () => {
    it('matches the root and nothing else for "/"', () => {
        expect(table.match('/', '')?.view).toBe(Home);
        expect(table.match('', '')?.view).toBe(Home);
    });

    it('prefers a static segment to a param, whatever the declaration order', () => {
        // '/users/:id' is declared first; 'new' still goes to New.
        expect(table.match('/users/new', '')?.view).toBe(New);
        expect(table.match('/users/42', '')?.view).toBe(User);
    });

    it('treats a URL whose params do not parse as no match — a 404, not a crash', () => {
        expect(table.match('/users/-3', '')).toBeUndefined();
        expect(table.match('/people/NOT_LOWER', '')).toBeUndefined();
        expect(table.match('/domains/ab/records', '')).toBeUndefined();
        expect(table.match('/nowhere', '')).toBeUndefined();
    });

    it('merges the query into params, with the path winning a clash', () => {
        const m = table.match('/domains/example.com/records', '?page=3&zone=spoofed');
        expect(m?.raw).toEqual({ zone: 'example.com', page: '3' });
    });

    it('decodes path segments, and a segment that cannot decode matches nothing', () => {
        expect(table.match('/domains/ex%20ample.com/records', '')?.raw['zone']).toBe('ex ample.com');
        expect(table.match('/domains/%E0%A4%A/records', '')).toBeUndefined();
    });

    it('keys a match by route and params, so the same URL is the same key and any change is a new one', () => {
        const a = table.match('/domains/example.com/records', '?page=2');
        const b = table.match('/domains/example.com/records', '?page=2');
        const c = table.match('/domains/example.com/records', '?page=3');
        expect(a?.key).toBe(b?.key);
        expect(a?.key).not.toBe(c?.key);
    });

    it('builds links: path params in the path, everything else in the query, encoded', () => {
        expect(table.href(Home)).toBe('/');
        expect(table.href(Records, { zone: 'a b.com', page: 2 })).toBe('/domains/a%20b.com/records?page=2');
        expect(table.href(Records, { zone: 'x.com', page: undefined })).toBe('/domains/x.com/records');
    });

    it('refuses to build a link it cannot', () => {
        expect(() => table.href(Records, {})).toThrow(/needs "zone"/);
        class Orphan extends View({}) { render(): Node { return nothing(); } }
        expect(() => table.href(Orphan)).toThrow(/Orphan is not routed/);
    });

    it('refuses two patterns that match the same URLs, and malformed patterns', () => {
        expect(() => compileRoutes({ '/a/:x': Home, '/a/:y': New })).toThrow(/match the same URLs/);
        expect(() => compileRoutes({ 'a': Home })).toThrow(/must start with/);
        expect(() => compileRoutes({ '/a/:x/:x': Home })).toThrow(/names ":x" twice/);
    });
});
