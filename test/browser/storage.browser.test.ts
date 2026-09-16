import { afterEach, describe, expect, it } from 'vitest';
import {
    element,
    flushSync,
    needs,
    provider,
    text,
    store,
    type Application,
    type Context,
    type ProviderToken,
    type ViewContext,
    KEEPS_NOTHING,
    LOCAL_PREFIX,
    KEY_SEPARATOR,
    type ReadonlySignal,
} from '@flybyme/mesh-web';
import { cleanup, mountPart } from '@flybyme/mesh-web/testing';
import { z } from 'zod';

const TestStore = store({
    name: 'test-store',
    hive: 'device',
    schema: z.string(),
    fallback: '',
});

const APP_NEEDS = needs('storage', 'windows');

interface AppApi {
    readonly getValue: () => ReadonlySignal<string | undefined>;
    readonly setValue: (val: string) => Promise<void>;
}

const APP_TOKEN: ProviderToken<AppApi> = provider<AppApi>('test/storage-app');

class StorageApp implements Application<typeof APP_NEEDS, readonly [], typeof APP_TOKEN, never> {
    readonly needs = APP_NEEDS;
    readonly provides = APP_TOKEN;
    readonly api = undefined as never;

    readonly views = [
        {
            id: 'main',
            title: 'Main',
            render: (vx: ViewContext<Record<string, never>, Record<string, never>, AppApi>) => {
                const val = vx.app.getValue();
                return element('Text', {
                    props: { id: 'value-display' },
                    children: [text(() => {
                        const v = val();
                        return v === '' ? 'empty' : (v ?? 'undefined');
                    })],
                });
            },
        },
    ];

    async start(cx: Context<typeof APP_NEEDS, readonly [], never>): Promise<{ api: AppApi } & typeof KEEPS_NOTHING> {
        const boundStore = cx.storage.open(TestStore);
        cx.windows.open({ view: 'main' });

        return {
            ...KEEPS_NOTHING,
            api: {
                getValue: () => boundStore.get('my-key'),
                setValue: async (val: string) => {
                    await boundStore.set('my-key', val);
                },
            },
        };
    }
}

describe('storage capability in browser', () => {
    afterEach(() => {
        cleanup();
        localStorage.clear();
    });

    it('syncs state across tabs using StorageEvent', async () => {
        const site = await mountPart({
            parts: [{ id: 'app', contribution: StorageApp }],
        });

        await site.ready;

        const app = site.kernel.provided(APP_TOKEN)!;
        expect(app).toBeDefined();

        // 5. Verifies the initial state (empty/undefined).
        expect(site.root.textContent).toContain('empty');

        // 6. Calls the app API to set a value, flushes sync, and verifies DOM updates.
        await app.setValue('hello');
        flushSync();
        expect(site.root.textContent).toContain('hello');

        // 7. Dispatches a raw StorageEvent on window
        const storageKey = `${LOCAL_PREFIX}app${KEY_SEPARATOR}test-store/my-key`;
        const newValue = JSON.stringify({
            value: 'world',
            version: 'some-version',
            updatedAt: Date.now(),
        });
        localStorage.setItem(storageKey, newValue);
        
        window.dispatchEvent(new StorageEvent('storage', {
            key: storageKey,
            newValue,
        }));
        
        // Wait for reactivity to settle since storage event triggers an async provider read inside boundStore
        await new Promise(resolve => setTimeout(resolve, 50));
        flushSync();
        
        expect(site.root.textContent).toContain('world');
    });
});
