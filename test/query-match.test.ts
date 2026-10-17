import { describe, expect, it } from 'vitest';
import { judgeQuery, matchesQuery } from '../src/models/query.js';

/**
 * Whether a row an event carries still belongs to a live list's find. 10-17: an app's Addresses
 * page asked for `{ host: { $in: [...] } }`; that was read as a plain value, never equal, so turning
 * a route off removed it from the page.
 */
describe('a live list judging the rows events carry', () => {
    const route = { id: 'r1', host: 'shop.example.com', active: false, target: { kind: 'service', id: 't1' } };

    it('reads $in, $nin, $ne and comparisons as the database does', () => {
        expect(matchesQuery(route, { query: { host: { $in: ['shop.example.com', 'www.shop.example.com'] } } })).toBe(true);
        expect(matchesQuery(route, { query: { host: { $in: ['other.example.com'] } } })).toBe(false);
        expect(matchesQuery(route, { query: { host: { $nin: ['shop.example.com'] } } })).toBe(false);
        expect(matchesQuery(route, { query: { active: { $ne: true } } })).toBe(true);
        expect(matchesQuery({ size: 5 }, { query: { size: { $gte: 5, $lt: 10 } } })).toBe(true);
        expect(matchesQuery({ size: 10 }, { query: { size: { $gte: 5, $lt: 10 } } })).toBe(false);
    });

    it('reads a nested field by its dotted path', () => {
        expect(matchesQuery(route, { query: { 'target.id': 't1' } })).toBe(true);
        expect(matchesQuery(route, { query: { 'target.id': 't2' } })).toBe(false);
    });

    it('a plain value and a missing field read as before', () => {
        expect(matchesQuery(route, { query: { host: 'shop.example.com' } })).toBe(true);
        expect(matchesQuery(route, { query: { name: 'x' } })).toBe(false);
        expect(matchesQuery(route, { query: { host: 'shop.example.com' }, sort: 'host', limit: 10 })).toBe(true);
    });

    it('an operator it cannot judge says so, so the list asks the api again rather than guess', () => {
        expect(judgeQuery(route, { query: { host: { $regex: '^shop' } } })).toBeUndefined();
        expect(judgeQuery(route, { query: { $or: [{ host: 'a' }, { host: 'b' }] } })).toBeUndefined();
        // A field that rules the row out is enough, whatever else is there.
        expect(judgeQuery(route, { query: { active: true, host: { $regex: '^shop' } } })).toBe(false);
    });
});
