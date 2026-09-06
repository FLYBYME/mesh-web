import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
    Kernel,
    createServices,
    createContext,
    localProvider,
    memoryProvider,
    needs,
    store,
    type Application,
    type Context,
    type EntryStat,
    type KeyValueStore,
} from '../src/index.js';

// ---------------------------------------------------------------------------- fixtures

const DraftSchema = z.object({
    title: z.string(),
    body: z.string(),
    savedAt: z.number(),
});

type Draft = z.infer<typeof DraftSchema>;

const Drafts = store({
    name: 'drafts',
    hive: 'device',
    schema: DraftSchema,
});

const STORE_NEEDS = needs('storage');

function createMemoryKeyValueStore(): KeyValueStore {
    const map = new Map<string, string>();
    return {
        getItem: (k) => map.get(k) ?? null,
        setItem: (k, v) => { map.set(k, v); },
        removeItem: (k) => { map.delete(k); },
        key: (i) => [...map.keys()][i] ?? null,
        get length() { return map.size; },
    };
}

function storageContext(
    identity: { id: string; declaredBy: string },
    services = createServices(),
) {
    const handle = createContext(
        identity,
        ['storage'],
        [],
        () => undefined,
        services,
    );
    const cx = handle.context as unknown as Context<['storage']>;
    return { handle, storage: cx.storage, services };
}

describe('storage capability: isolation and security boundaries', () => {
    it('one part cannot reach another’s store by matching store name', async () => {
        const memDevice = memoryProvider('device');
        const hives = {
            system: { provider: memoryProvider('system'), writable: false },
            user: { provider: memoryProvider('user'), writable: true },
            device: { provider: memDevice, writable: true },
            session: { provider: memoryProvider('session'), writable: true },
        };
        const services = createServices(undefined, { hives });

        // Part A
        const { handle: handleA, storage: storageA } = storageContext(
            { id: 'part-a', declaredBy: 'part-a' },
            services,
        );
        const draftsA = storageA.open(Drafts);

        await draftsA.set('123', {
            title: 'Part A Secret Draft',
            body: 'Confidential',
            savedAt: 1000,
        });

        // Part B declaring the identical store definition
        const { handle: handleB, storage: storageB } = storageContext(
            { id: 'part-b', declaredBy: 'part-b' },
            services,
        );
        const draftsB = storageB.open(Drafts);

        // Part B reads key '123'
        const bVal = draftsB.get('123');
        await draftsB.ready('123');
        expect(bVal()).toBeUndefined();

        // Part B lists entries
        const bList = await draftsB.list();
        expect(bList()).toHaveLength(0);

        // Part A still has its value
        const aVal = draftsA.get('123');
        expect(aVal()).toEqual({
            title: 'Part A Secret Draft',
            body: 'Confidential',
            savedAt: 1000,
        });

        handleA.dispose();
        handleB.dispose();
    });

    it('one part cannot reach another’s store by directory traversal or path manipulation', async () => {
        const memDevice = memoryProvider('device');
        const hives = {
            system: { provider: memoryProvider('system'), writable: false },
            user: { provider: memoryProvider('user'), writable: true },
            device: { provider: memDevice, writable: true },
            session: { provider: memoryProvider('session'), writable: true },
        };
        const services = createServices(undefined, { hives });

        // Part A
        const { handle: handleA, storage: storageA } = storageContext(
            { id: 'part-a', declaredBy: 'part-a' },
            services,
        );
        const draftsA = storageA.open(Drafts);
        await draftsA.set('secret', { title: 'A', body: 'A', savedAt: 1 });

        // Part B attempts directory traversal via key
        const { handle: handleB, storage: storageB } = storageContext(
            { id: 'part-b', declaredBy: 'part-b' },
            services,
        );
        const draftsB = storageB.open(Drafts);

        const traversed = draftsB.get('../part-a/drafts/secret');
        await draftsB.ready('../part-a/drafts/secret');
        expect(traversed()).toBeUndefined();

        // And attempting to write via traversal only writes within Part B's namespace
        await draftsB.set('../part-a/drafts/secret', { title: 'B', body: 'B', savedAt: 2 });
        // Part A's value must remain untouched!
        expect(draftsA.get('secret')()).toEqual({ title: 'A', body: 'A', savedAt: 1 });

        handleA.dispose();
        handleB.dispose();
    });

    it('refuses invalid store names containing paths, slashes, null bytes or traversal characters', () => {
        expect(() => store({ name: '../bad', schema: DraftSchema })).toThrow(/Invalid store name/);
        expect(() => store({ name: 'bad/name', schema: DraftSchema })).toThrow(/Invalid store name/);
        expect(() => store({ name: 'bad\0name', schema: DraftSchema })).toThrow(/Invalid store name/);
        expect(() => store({ name: '', schema: DraftSchema })).toThrow(/Invalid store name/);
        expect(() => store({ name: '   ', schema: DraftSchema })).toThrow(/Invalid store name/);
    });

    it('refuses keys containing null separator characters', async () => {
        const { handle, storage } = storageContext({ id: 'part-1', declaredBy: 'part-1' });
        const drafts = storage.open(Drafts);

        expect(() => drafts.get('key\0injected')).toThrow(/null characters/);
        await expect(drafts.set('key\0injected', { title: 'T', body: 'B', savedAt: 1 })).rejects.toThrow(/null characters/);
        await expect(drafts.remove('key\0injected')).rejects.toThrow(/null characters/);
        await expect(drafts.stat('key\0injected')).rejects.toThrow(/null characters/);

        handle.dispose();
    });
});

describe('storage capability: schema validation and fallback', () => {
    it('refuses a write that fails the schema', async () => {
        const { handle, storage } = storageContext({ id: 'part-1', declaredBy: 'part-1' });
        const drafts = storage.open(Drafts);

        // Intentionally invalid object missing savedAt and title wrong type
        const badPayload = { title: 123, body: 'hello' };

        await expect(
            // @ts-expect-error deliberately passing wrong type to verify runtime check
            drafts.set('invalid', badPayload),
        ).rejects.toThrow();

        // Verify nothing was written
        const read = drafts.get('invalid');
        await drafts.ready('invalid');
        expect(read()).toBeUndefined();

        handle.dispose();
    });

    it('reads of malformed data fall back loudly rather than returning corrupt shape', async () => {
        const memDevice = memoryProvider('device');
        const hives = {
            system: { provider: memoryProvider('system'), writable: false },
            user: { provider: memoryProvider('user'), writable: true },
            device: { provider: memDevice, writable: true },
            session: { provider: memoryProvider('session'), writable: true },
        };
        const services = createServices(undefined, { hives });

        // Simulate malformed data written directly to backing provider (e.g. from an older version)
        await memDevice.write('test-app', 'drafts/corrupt', {
            title: 'Old shape with no savedAt',
            oldField: 999,
        });

        const { handle, storage } = storageContext(
            { id: 'test-app', declaredBy: 'test-app' },
            services,
        );
        const drafts = storage.open(Drafts);

        const corruptRead = drafts.get('corrupt');
        await drafts.ready('corrupt');

        // Must NOT return the corrupt payload:
        expect(corruptRead()).toBeUndefined();

        // Must fall back loudly: a warning logged to services.logs!
        const warnings = services.logs.filter((l) => l.level === 'warn');
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings[0]?.message).toContain('failed schema validation');

        handle.dispose();
    });

    it('reads of malformed data return declared fallback if specified', async () => {
        const memDevice = memoryProvider('device');
        const hives = {
            system: { provider: memoryProvider('system'), writable: false },
            user: { provider: memoryProvider('user'), writable: true },
            device: { provider: memDevice, writable: true },
            session: { provider: memoryProvider('session'), writable: true },
        };
        const services = createServices(undefined, { hives });

        await memDevice.write('fallback-app', 'drafts_with_default/corrupt', { invalid: true });

        const defaultDraft: Draft = { title: 'Default', body: 'Empty', savedAt: 0 };
        const StoreWithDefault = store({
            name: 'drafts_with_default',
            hive: 'device',
            schema: DraftSchema,
            fallback: defaultDraft,
        });

        const { handle, storage } = storageContext(
            { id: 'fallback-app', declaredBy: 'fallback-app' },
            services,
        );
        const drafts = storage.open(StoreWithDefault);

        const read = drafts.get('corrupt');
        await drafts.ready('corrupt');

        expect(read()).toEqual(defaultDraft);

        handle.dispose();
    });
});

describe('storage capability: reload and remount survival', () => {
    it('persisted values survive remount across reloads via localStorage', async () => {
        // Shared backing store simulating browser localStorage across reload
        const fakeLocalStorage = createMemoryKeyValueStore();
        const deviceProvider = () => localProvider(fakeLocalStorage);

        class PersistentNoteApp implements Application<typeof STORE_NEEDS> {
            readonly needs = STORE_NEEDS;
            readonly stores = [Drafts];
            public drafts?: ReturnType<Context<typeof STORE_NEEDS>['storage']['open']>;

            async start(cx: Context<typeof STORE_NEEDS>): Promise<void> {
                this.drafts = cx.storage.open(Drafts);
            }
        }

        // --- Run 1: initial page mount and write ---
        const kernel1 = new Kernel({
            services: createServices(undefined, {
                hives: {
                    system: { provider: memoryProvider('system'), writable: false },
                    user: { provider: memoryProvider('user'), writable: true },
                    device: { provider: deviceProvider(), writable: true },
                    session: { provider: memoryProvider('session'), writable: true },
                },
            }),
        });

        const app1 = new PersistentNoteApp();
        kernel1.boot([{ id: 'note-app', contribution: app1 }]);
        const pid1 = await kernel1.start('note-app');

        await app1.drafts!.set('note-1', {
            title: 'Remember Me',
            body: 'This must survive a reload',
            savedAt: 123456789,
        });

        await kernel1.stop(pid1);

        // --- Run 2: page reload / remount ---
        const kernel2 = new Kernel({
            services: createServices(undefined, {
                hives: {
                    system: { provider: memoryProvider('system'), writable: false },
                    user: { provider: memoryProvider('user'), writable: true },
                    device: { provider: deviceProvider(), writable: true },
                    session: { provider: memoryProvider('session'), writable: true },
                },
            }),
        });

        const app2 = new PersistentNoteApp();
        kernel2.boot([{ id: 'note-app', contribution: app2 }]);
        const pid2 = await kernel2.start('note-app');

        const readSignal = app2.drafts!.get('note-1');
        await app2.drafts!.ready('note-1');

        expect(readSignal()).toEqual({
            title: 'Remember Me',
            body: 'This must survive a reload',
            savedAt: 123456789,
        });

        await kernel2.stop(pid2);
    });
});

describe('storage capability: reactivity, list, and removal', () => {
    it('get returns a reactive signal that updates on write and remove', async () => {
        const { handle, storage } = storageContext({ id: 'part-1', declaredBy: 'part-1' });
        const drafts = storage.open(Drafts);

        const signalVal = drafts.get('doc-1');
        expect(signalVal()).toBeUndefined();

        await drafts.set('doc-1', {
            title: 'Hello',
            body: 'World',
            savedAt: 42,
        });

        // The signal updates in place!
        expect(signalVal()).toEqual({
            title: 'Hello',
            body: 'World',
            savedAt: 42,
        });

        // Calling get on the same key returns the exact same signal
        const sameSignal = drafts.get('doc-1');
        expect(sameSignal).toBe(signalVal);

        // Removing key updates the signal back to undefined
        await drafts.remove('doc-1');
        expect(signalVal()).toBeUndefined();

        handle.dispose();
    });

    it('list returns entry stats and updates when items are added or removed', async () => {
        const { handle, storage } = storageContext({ id: 'part-1', declaredBy: 'part-1' });
        const drafts = storage.open(Drafts);

        // Can be awaited or read as a signal:
        const listSignal = await drafts.list();
        expect(listSignal()).toHaveLength(0);

        await drafts.set('draft-a', { title: 'A', body: 'Body A', savedAt: 1 });
        await drafts.set('draft-b', { title: 'B', body: 'Body B', savedAt: 2 });

        // list updates reactively
        await drafts.ready();
        const items = listSignal();
        expect(items.map((i: EntryStat) => i.path).sort()).toEqual(['draft-a', 'draft-b']);

        // stat returns single entry metadata with stripped key
        const statA = await drafts.stat('draft-a');
        expect(statA).toBeDefined();
        expect(statA?.path).toBe('draft-a');
        expect(statA?.size).toBeGreaterThan(0);

        await drafts.remove('draft-a');
        await drafts.ready();
        expect(listSignal().map((i: EntryStat) => i.path)).toEqual(['draft-b']);

        handle.dispose();
    });

    it('refuses writes to unwritable hives like system', async () => {
        const SystemStore = store({
            name: 'system_records',
            hive: 'system',
            schema: z.object({ value: z.string() }),
        });

        const { handle, storage } = storageContext({ id: 'part-1', declaredBy: 'part-1' });
        const sysStore = storage.open(SystemStore);

        await expect(sysStore.set('key', { value: 'forbidden' })).rejects.toThrow(/read-only/);
        await expect(sysStore.remove('key')).rejects.toThrow(/read-only/);

        handle.dispose();
    });

    it('stores appear in manifest and duplicate store names in one contribution conflict', () => {
        class AppWithStores implements Application<typeof STORE_NEEDS> {
            readonly needs = STORE_NEEDS;
            readonly stores = [Drafts];
            async start(): Promise<void> {}
        }

        const kernel = new Kernel();
        kernel.boot([{ id: 'app-with-stores', contribution: new AppWithStores() }]);

        expect(kernel.manifest.stores.has('app-with-stores/drafts')).toBe(true);
        const stored = kernel.manifest.stores.get('app-with-stores/drafts');
        expect(stored?.by).toBe('app-with-stores');
        expect(stored?.decl.name).toBe('drafts');
        expect(stored?.decl.hive).toBe('device');
        expect(kernel.manifest.conflicts).toHaveLength(0);

        // App declaring same store twice conflicts:
        class AppWithConflict implements Application<typeof STORE_NEEDS> {
            readonly needs = STORE_NEEDS;
            readonly stores = [Drafts, Drafts];
            async start(): Promise<void> {}
        }

        const kernelConflict = new Kernel();
        kernelConflict.boot([{ id: 'conflict-app', contribution: new AppWithConflict() }]);
        expect(kernelConflict.manifest.conflicts.some((c) => c.kind === 'store')).toBe(true);
    });
});
