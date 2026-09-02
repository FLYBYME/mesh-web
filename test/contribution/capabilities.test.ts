import { describe, it, expect, beforeEach } from 'vitest';
import { createScope } from '../../src/reactivity/index.js';
import { AppStateContainerImpl, MemoryStorage } from '../../src/app/index.js';
import {
    defineApplication,
    getRegisteredApplication,
    getAllRegisteredApplications,
    clearApplicationRegistry,
} from '../../src/contribution/application.js';
import {
    defineExtension,
    getRegisteredExtension,
    clearExtensionRegistry,
} from '../../src/contribution/extension.js';

/**
 * The claim these tests exist to check is a *type-level* one: a contributor receives exactly the
 * capabilities it declared in `needs`, and reaching for anything else fails to compile.
 *
 * That cannot be asserted with `expect`. It is checked by `@ts-expect-error`, which fails the build
 * if the line it marks turns out to compile — so if the narrowing ever silently widens to
 * `Partial<CapabilityMap>` or `unknown`, `npm run typecheck` goes red here rather than the mistake
 * surfacing as a runtime `undefined` in someone's product months later.
 *
 * `tsconfig.check.json` includes `test/**`, so these are checked in CI. Vitest transpiles without
 * type-checking, which is exactly why that separate step exists.
 */

describe('capability narrowing', () => {
    beforeEach(() => {
        clearApplicationRegistry();
        clearExtensionRegistry();
    });

    it('gives an Application exactly the capabilities it declared', () => {
        let sawBaseUrl: string | undefined;

        defineApplication({
            id: 'test.declared',
            title: 'Declared',
            needs: ['net', 'commands'] as const,
            onLoad(cx) {
                // Declared: both resolve to their real types, not to `unknown`.
                sawBaseUrl = cx.net.baseUrl;
                cx.commands.available();

                // Always present, never declared.
                expect(cx.id).toBe('test.declared');

                // @ts-expect-error — `notifications` was not declared, so it is not on the context.
                cx.notifications.info('this line must not compile');
            },
        });

        expect(getRegisteredApplication('test.declared')?.title).toBe('Declared');
        // onLoad is the host's to call; nothing has run it here.
        expect(sawBaseUrl).toBeUndefined();
    });

    it('gives an Extension nothing but the base context when it declares nothing', () => {
        defineExtension({
            id: 'test.bare',
            title: 'Bare',
            activate(cx) {
                expect(cx.id).toBe('test.bare');

                // @ts-expect-error — declaring no `needs` means no capabilities at all.
                cx.log.info('this line must not compile');
            },
        });

        expect(getRegisteredExtension('test.bare')?.title).toBe('Bare');
    });

    it('types an Extension by what activate returns', () => {
        const ext = defineExtension({
            id: 'test.exports',
            title: 'Exports',
            needs: ['storage'] as const,
            activate(cx) {
                return { lastSeen: cx.storage.get('lastSeen', 0) };
            },
        });

        // The definition carries its export type, so a consumer of `uses` can be typed against it.
        // The context is built from real pieces rather than cast into shape: `as never` here would
        // mean this test proves the types line up only because it was told not to look.
        const exports: { lastSeen: number } | Promise<{ lastSeen: number }> = ext.activate({
            id: 'test.exports',
            state: new AppStateContainerImpl('test.exports', createScope(), new MemoryStorage()),
            registerCleanup: () => undefined,
            storage: {
                get: <T,>(_key: string, fallback: T): T => fallback,
                set: () => undefined,
                remove: () => undefined,
            },
        });
        expect(exports).toEqual({ lastSeen: 0 });
    });
});

describe('contribution registries', () => {
    beforeEach(() => {
        clearApplicationRegistry();
        clearExtensionRegistry();
    });

    it('refuses two Applications with the same id, naming both', () => {
        defineApplication({ id: 'dup', title: 'First' });
        expect(() => defineApplication({ id: 'dup', title: 'Second' })).toThrow(
            /two Applications claim the id "dup".*First.*Second/s,
        );
    });

    it('refuses two Extensions with the same id, naming both', () => {
        defineExtension({ id: 'dup', title: 'First', activate: () => undefined });
        expect(() =>
            defineExtension({ id: 'dup', title: 'Second', activate: () => undefined }),
        ).toThrow(/two Extensions claim the id "dup".*First.*Second/s);
    });

    it('keeps Application and Extension ids in separate namespaces', () => {
        defineApplication({ id: 'shared', title: 'An Application' });
        expect(() =>
            defineExtension({ id: 'shared', title: 'An Extension', activate: () => undefined }),
        ).not.toThrow();
    });

    it('rejects an empty id', () => {
        expect(() => defineApplication({ id: '', title: 'Nameless' })).toThrow(/non-empty "id"/);
    });

    it('lists what has been registered', () => {
        defineApplication({ id: 'a', title: 'A' });
        defineApplication({ id: 'b', title: 'B' });
        expect(getAllRegisteredApplications().map(a => a.id)).toEqual(['a', 'b']);
    });
});
