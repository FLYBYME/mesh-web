import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSingleFramework, getFrameworkInstances } from '../src/instance.js';

describe('Framework instance tracking and singleton assertion', () => {
    const INSTANCES_KEY = Symbol.for('@flybyme/mesh-web/instances');
    let originalInstances: string[] | undefined;

    beforeEach(() => {
        const registry = globalThis as Record<symbol, string[] | undefined>;
        // Save current instances state
        originalInstances = registry[INSTANCES_KEY] ? [...registry[INSTANCES_KEY]!] : undefined;
    });

    afterEach(() => {
        const registry = globalThis as Record<symbol, string[] | undefined>;
        if (originalInstances !== undefined) {
            registry[INSTANCES_KEY] = [...originalInstances];
        } else {
            delete registry[INSTANCES_KEY];
        }
    });

    it('returns the recorded evaluation URLs as a shallow copy', () => {
        const instances = getFrameworkInstances();
        expect(instances.length).toBeGreaterThanOrEqual(1);

        // Modifying the returned array should not mutate the internal registry
        const initialLength = instances.length;
        (instances as string[]).push('http://fake/instance.js');
        expect(getFrameworkInstances()).toHaveLength(initialLength);
    });

    it('passes assertSingleFramework when exactly one framework instance is evaluated', () => {
        const registry = globalThis as Record<symbol, string[] | undefined>;
        registry[INSTANCES_KEY] = ['http://localhost:5173/@fs/mesh-web/src/index.ts'];

        expect(() => assertSingleFramework()).not.toThrow();
        expect(getFrameworkInstances()).toEqual(['http://localhost:5173/@fs/mesh-web/src/index.ts']);
    });

    it('throws singleton violation error when multiple framework instances are loaded', () => {
        const registry = globalThis as Record<symbol, string[] | undefined>;
        const url1 = 'http://localhost:5173/packages/mesh-web/src/index.ts';
        const url2 = 'http://localhost:5173/node_modules/@flybyme/mesh-web/src/index.ts';

        registry[INSTANCES_KEY] = [url1, url2];

        expect(() => assertSingleFramework()).toThrowError(
            /Framework singleton violation: @flybyme\/mesh-web was evaluated 2 times under multiple URLs:/,
        );

        try {
            assertSingleFramework();
            expect.unreachable('Should have thrown');
        } catch (error) {
            const message = (error as Error).message;
            expect(message).toContain(url1);
            expect(message).toContain(url2);
            expect(message).toContain(
                'A part must resolve the framework to exactly one copy. Check Vite resolve.dedupe and optimizeDeps.exclude.',
            );
        }
    });

    it('handles empty registry gracefully', () => {
        const registry = globalThis as Record<symbol, string[] | undefined>;
        registry[INSTANCES_KEY] = [];

        expect(() => assertSingleFramework()).not.toThrow();
        expect(getFrameworkInstances()).toEqual([]);
    });
});
