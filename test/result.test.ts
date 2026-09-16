import { describe, expect, it } from 'vitest';

import {
    ok, err, describe as describeError, MeshCallError,
    type Ok, type Err, type CallError, type ExposureDifference,
} from '../src/net/result.js';

// ---------------------------------------------------------------------------- ok() and err() constructors

describe('ok()', () => {
    it('has ok === true and value === the passed value', () => {
        const result = ok('hello');
        expect(result.ok).toBe(true);
        expect(result.value).toBe('hello');
    });

    it('works with an object value', () => {
        const obj = { id: 1, name: 'test' };
        const result = ok(obj);
        expect(result.ok).toBe(true);
        expect(result.value).toBe(obj);
    });

    it('works with null', () => {
        const result = ok(null);
        expect(result.ok).toBe(true);
        expect(result.value).toBeNull();
    });

    it('works with a number', () => {
        const result = ok(42);
        expect(result.ok).toBe(true);
        expect(result.value).toBe(42);
    });

    it('type-narrows: after checking .ok === true the value branch is accessible', () => {
        const result: Ok<string> | Err<string> = ok('narrow');
        if (result.ok) {
            // TypeScript would fail to compile if .value were not accessible here
            const v: string = result.value;
            expect(v).toBe('narrow');
        } else {
            throw new Error('should not reach err branch');
        }
    });
});

describe('err()', () => {
    it('has ok === false and error === the passed error', () => {
        const result = err('oops');
        expect(result.ok).toBe(false);
        expect(result.error).toBe('oops');
    });

    it('works with an object error', () => {
        const error = { kind: 'unauthorized' as const };
        const result = err(error);
        expect(result.ok).toBe(false);
        expect(result.error).toBe(error);
    });

    it('works with null', () => {
        const result = err(null);
        expect(result.ok).toBe(false);
        expect(result.error).toBeNull();
    });

    it('works with a number', () => {
        const result = err(404);
        expect(result.ok).toBe(false);
        expect(result.error).toBe(404);
    });

    it('type-narrows: after checking .ok === false the error branch is accessible', () => {
        const result: Ok<string> | Err<string> = err('failure');
        if (!result.ok) {
            // TypeScript would fail to compile if .error were not accessible here
            const e: string = result.error;
            expect(e).toBe('failure');
        } else {
            throw new Error('should not reach ok branch');
        }
    });
});

// ---------------------------------------------------------------------------- describe() — every error kind

describe('describe() — TransportError kinds', () => {
    it("'unauthorized' returns 'You need to sign in.'", () => {
        expect(describeError({ kind: 'unauthorized' })).toBe('You need to sign in.');
    });

    it("'forbidden' returns 'You do not have access to that.'", () => {
        expect(describeError({ kind: 'forbidden' })).toBe('You do not have access to that.');
    });

    it("'not_found' returns 'That does not exist.'", () => {
        expect(describeError({ kind: 'not_found' })).toBe('That does not exist.');
    });

    it("'invalid' with a detail includes the detail string", () => {
        const msg = describeError({ kind: 'invalid', detail: 'id: Required' });
        expect(msg).toContain('id: Required');
    });

    it("'conflict' with a detail includes the detail string", () => {
        const msg = describeError({ kind: 'conflict', detail: 'name already taken' });
        expect(msg).toContain('name already taken');
    });

    it("'rate_limited' includes 'Too many requests'", () => {
        expect(describeError({ kind: 'rate_limited' })).toContain('Too many requests');
    });

    it("'rate_limited' with retryAfterMs includes 'Too many requests'", () => {
        expect(describeError({ kind: 'rate_limited', retryAfterMs: 5000 })).toContain('Too many requests');
    });

    it("'server' with status 500 includes '500'", () => {
        expect(describeError({ kind: 'server', status: 500, detail: 'internal error' })).toContain('500');
    });

    it("'server' with status 503 includes '503'", () => {
        expect(describeError({ kind: 'server', status: 503, detail: 'unavailable' })).toContain('503');
    });

    it("'offline' returns 'Could not reach the server.'", () => {
        expect(describeError({ kind: 'offline', detail: 'network down' })).toBe('Could not reach the server.');
    });

    it("'stale' with no differences property returns a message containing 'Reload'", () => {
        const msg = describeError({
            kind: 'stale',
            expected: 'sha256:abc',
            actual: 'sha256:xyz',
        });
        expect(msg).toContain('Reload');
    });

    it("'stale' with empty differences array (length 0) returns the 'Reload' variant", () => {
        const msg = describeError({
            kind: 'stale',
            expected: 'sha256:abc',
            actual: 'sha256:xyz',
            differences: [],
        });
        expect(msg).toContain('Reload');
    });

    it("'stale' with a non-empty differences array includes each difference's message", () => {
        const msg = describeError({
            kind: 'stale',
            expected: 'sha256:abc',
            actual: 'sha256:xyz',
            differences: [
                { contract: 'domains.zone_find', kind: 'missing', message: 'removed' },
                { contract: 'domains.zone_create', kind: 'method', message: 'method changed' },
            ],
        });
        expect(msg).toContain('removed');
        expect(msg).toContain('method changed');
    });
});

describe('describe() — DeclaredError kind', () => {
    it("'declared' returns the detail string verbatim", () => {
        expect(describeError({ kind: 'declared', name: 'revoked', detail: 'That credential was revoked.' }))
            .toBe('That credential was revoked.');
    });

    it("'declared' with a different detail still returns verbatim", () => {
        const detail = 'Custom declared error message.';
        expect(describeError({ kind: 'declared', name: 'custom', detail })).toBe(detail);
    });
});

// ---------------------------------------------------------------------------- ExposureDifference used in stale error

describe('ExposureDifference in stale error', () => {
    it('all fields are accessible on a constructed difference object', () => {
        const diff: ExposureDifference = {
            contract: 'domains.zone_find',
            kind: 'missing',
            message: 'removed',
        };
        expect(diff.contract).toBe('domains.zone_find');
        expect(diff.kind).toBe('missing');
        expect(diff.message).toBe('removed');
    });

    it('describe() of a stale error with differences includes the message field from each difference', () => {
        const error: CallError<string> = {
            kind: 'stale',
            expected: 'sha256:v1',
            actual: 'sha256:v2',
            differences: [{ contract: 'domains.zone_find', kind: 'missing', message: 'removed' }],
        };
        const msg = describeError(error);
        expect(msg).toContain('removed');
    });
});

// ---------------------------------------------------------------------------- MeshCallError

describe('MeshCallError', () => {
    it('is an instance of Error', () => {
        const e = new MeshCallError({ kind: 'unauthorized' });
        expect(e).toBeInstanceOf(Error);
    });

    it('is an instance of MeshCallError', () => {
        const e = new MeshCallError({ kind: 'unauthorized' });
        expect(e).toBeInstanceOf(MeshCallError);
    });

    it('.name === "MeshCallError"', () => {
        const e = new MeshCallError({ kind: 'unauthorized' });
        expect(e.name).toBe('MeshCallError');
    });

    it('.error holds the original CallError', () => {
        const callError: CallError<string> = { kind: 'forbidden' };
        const e = new MeshCallError(callError);
        expect(e.error).toBe(callError);
    });

    it('.message equals describe(error)', () => {
        const callError: CallError<string> = { kind: 'not_found' };
        const e = new MeshCallError(callError);
        expect(e.message).toBe(describeError(callError));
    });

    it('works for unauthorized: .error.kind === "unauthorized"', () => {
        const e = new MeshCallError({ kind: 'unauthorized' });
        expect(e.error.kind).toBe('unauthorized');
        expect(e.message).toBe('You need to sign in.');
    });

    it('works for forbidden: .error.kind === "forbidden"', () => {
        const e = new MeshCallError({ kind: 'forbidden' });
        expect(e.error.kind).toBe('forbidden');
        expect(e.message).toBe('You do not have access to that.');
    });

    it('works for not_found', () => {
        const e = new MeshCallError({ kind: 'not_found' });
        expect(e.error.kind).toBe('not_found');
        expect(e.message).toBe('That does not exist.');
    });

    it('works for invalid', () => {
        const e = new MeshCallError({ kind: 'invalid', detail: 'bad input' });
        expect(e.error.kind).toBe('invalid');
        expect(e.message).toContain('bad input');
    });

    it('works for conflict', () => {
        const e = new MeshCallError({ kind: 'conflict', detail: 'duplicate' });
        expect(e.error.kind).toBe('conflict');
        expect(e.message).toContain('duplicate');
    });

    it('works for rate_limited', () => {
        const e = new MeshCallError({ kind: 'rate_limited' });
        expect(e.error.kind).toBe('rate_limited');
        expect(e.message).toContain('Too many requests');
    });

    it('works for server', () => {
        const e = new MeshCallError({ kind: 'server', status: 500, detail: 'crash' });
        expect(e.error.kind).toBe('server');
        expect(e.message).toContain('500');
    });

    it('works for offline', () => {
        const e = new MeshCallError({ kind: 'offline', detail: 'no network' });
        expect(e.error.kind).toBe('offline');
        expect(e.message).toBe('Could not reach the server.');
    });

    it('works for stale (no differences)', () => {
        const callError: CallError<string> = {
            kind: 'stale',
            expected: 'sha256:old',
            actual: 'sha256:new',
        };
        const e = new MeshCallError(callError);
        expect(e.error.kind).toBe('stale');
        expect(e.message).toContain('Reload');
    });

    it('works for stale (with differences)', () => {
        const callError: CallError<string> = {
            kind: 'stale',
            expected: 'sha256:old',
            actual: 'sha256:new',
            differences: [{ contract: 'a.b', kind: 'missing', message: 'gone' }],
        };
        const e = new MeshCallError(callError);
        expect(e.error.kind).toBe('stale');
        expect(e.message).toContain('gone');
    });

    it('works for declared', () => {
        const e = new MeshCallError({ kind: 'declared', name: 'revoked', detail: 'Revoked.' });
        expect(e.error.kind).toBe('declared');
        expect(e.message).toBe('Revoked.');
    });

    it('can be caught as Error and .error accessed', () => {
        let caught: unknown;
        try {
            throw new MeshCallError({ kind: 'unauthorized' });
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught).toBeInstanceOf(MeshCallError);
        expect((caught as MeshCallError).error.kind).toBe('unauthorized');
    });

    it('throw/catch pattern works for not_found', () => {
        try {
            throw new MeshCallError({ kind: 'not_found' });
        } catch (e) {
            expect(e).toBeInstanceOf(MeshCallError);
            expect((e as MeshCallError).error.kind).toBe('not_found');
        }
    });

    it('throw/catch pattern works for declared', () => {
        try {
            throw new MeshCallError({ kind: 'declared', name: 'revoked', detail: 'Revoked.' });
        } catch (e) {
            expect(e).toBeInstanceOf(MeshCallError);
            expect((e as MeshCallError).error.kind).toBe('declared');
            if ((e as MeshCallError).error.kind === 'declared') {
                expect(((e as MeshCallError).error as { detail: string }).detail).toBe('Revoked.');
            }
        }
    });

    it('throw/catch pattern works for stale', () => {
        try {
            throw new MeshCallError({
                kind: 'stale',
                expected: 'sha256:a',
                actual: 'sha256:b',
            });
        } catch (e) {
            expect(e).toBeInstanceOf(MeshCallError);
            expect((e as MeshCallError).error.kind).toBe('stale');
        }
    });
});
