/**
 * The registry — roadmap A4.1–A4.4, A4.6.
 *
 * spec/storage-and-registry.md. Two things are actually being checked, and neither is "does a Map
 * store a value":
 *
 *   1. **the resolution order**, because a setting's meaning depends on which hive answered
 *   2. **locking**, because "you cannot change this, and here is why" is the thing every settings
 *      screen gets wrong
 */

import { describe, expect, it, vi } from 'vitest';

import {
    RESOLUTION_ORDER, SettingLocked, VersionConflict, asBoolean, asNumber, asOneOf, asShape,
    asString, createSettingsRegistry, flushSync, keyOf, LOCAL_PREFIX, localProvider,
    memoryProvider, setting,
    unavailableProvider,
    type HiveBindings, type KeyValueStore, type StorageProvider,
} from '../src/index.js';

// ---------------------------------------------------------------------------- fixtures

const bindings = (over: Partial<Record<keyof HiveBindings, { provider: StorageProvider; writable: boolean }>> = {}): HiveBindings => ({
    system: { provider: memoryProvider('system'), writable: false },
    user: { provider: memoryProvider('user'), writable: true },
    device: { provider: memoryProvider('device'), writable: true },
    session: { provider: memoryProvider('session'), writable: true },
    ...over,
});

const mode = setting({
    path: 'window-manager/mode',
    hive: 'device',
    fallback: 'windowed' as 'windowed' | 'tiled',
    parse: asOneOf(['windowed', 'tiled'] as const),
});

const geometry = setting({
    path: 'window-manager/geometry',
    hive: 'device',
    fallback: { x: 0, y: 0, width: 480, height: 320 },
    parse: asShape({ x: asNumber, y: asNumber, width: asNumber, height: asNumber }),
});

/**
 * Wait for a setting to finish resolving.
 *
 * `registry.ready(decl)` rather than a timer, because cells are created on first touch: awaiting a
 * timer before ever reading the setting waits for something that has not started. That is exactly
 * the trap `ready()` was added for — and the same one the kernel hits restoring geometry at boot.
 */
const settled = async (registry: { ready(d: never): Promise<void> }, ...decls: unknown[]): Promise<void> => {
    for (const decl of decls) await registry.ready(decl as never);
    flushSync();
};

// ---------------------------------------------------------------------------- reads

describe('a read answers now and improves later', () => {
    it('starts at the declared default rather than waiting on a provider', () => {
        const registry = createSettingsRegistry({ hives: bindings(), namespace: 'blog' });

        // Synchronous. A page that awaited a remote hive before first paint would blank on every
        // reload, which is what A4.3 exists to prevent.
        expect(registry.read(mode)()).toBe('windowed');
    });

    it('updates in place when the hive comes back', async () => {
        const hives = bindings();
        await hives.device.provider.write('blog', 'window-manager/mode', 'tiled');

        const registry = createSettingsRegistry({ hives, namespace: 'blog' });
        const value = registry.read(mode);

        expect(value()).toBe('windowed');   // the default, immediately
        await settled(registry, mode);
        expect(value()).toBe('tiled');      // the stored value, once it arrived
    });

    it('gives one signal per path, so two readers share a subscription', async () => {
        const registry = createSettingsRegistry({ hives: bindings(), namespace: 'blog' });
        expect(registry.read(mode)).toBe(registry.read(mode));
    });

    it('namespaces, so two Applications cannot collide in one store', async () => {
        const hives = bindings();
        await hives.device.provider.write('blog', 'window-manager/mode', 'tiled');

        const other = createSettingsRegistry({ hives, namespace: 'console' });
        await settled(other, mode);

        // Same path, same provider, different Application. The kernel supplies the namespace, so
        // this is not something an Application is trusted to remember.
        expect(other.read(mode)()).toBe('windowed');
    });
});

describe('the resolution order', () => {
    it('walks system, then user, then device', async () => {
        expect(RESOLUTION_ORDER).toEqual(['system', 'user', 'device']);

        const hives = bindings();
        await hives.device.provider.write('blog', 'window-manager/mode', 'windowed');
        await hives.user.provider.write('blog', 'window-manager/mode', 'tiled');

        const registry = createSettingsRegistry({ hives, namespace: 'blog' });
        await settled(registry, mode);

        // `user` is earlier in the order, so it wins over the device's own value.
        expect(registry.read(mode)()).toBe('tiled');
        expect(registry.resolution(mode)().from).toBe('user');
    });

    it('does not let a session value shadow a saved one', async () => {
        const hives = bindings();
        await hives.session.provider.write('blog', 'window-manager/mode', 'tiled');
        await hives.user.provider.write('blog', 'window-manager/mode', 'windowed');

        const registry = createSettingsRegistry({ hives, namespace: 'blog' });
        await settled(registry, mode);

        // `session` is deliberately not in the order: a tab-scoped value is asked for by name, not
        // silently preferred over a user's saved choice.
        expect(registry.read(mode)()).toBe('windowed');
    });

    it('falls back to the declaration when no hive has it', async () => {
        const registry = createSettingsRegistry({ hives: bindings(), namespace: 'blog' });
        await settled(registry, mode);

        expect(registry.resolution(mode)()).toMatchObject({ value: 'windowed', from: undefined, locked: false });
    });
});

// ---------------------------------------------------------------------------- policy

describe('policy wins, and says so', () => {
    it('a build constant beats every hive and cannot be written', async () => {
        const hives = bindings();
        await hives.user.provider.write('blog', 'window-manager/mode', 'windowed');

        // spec §2: a locked blog is `system` policy on `window-manager/mode`. No separate locking
        // mechanism and no special case in the window manager — it reads a setting, and the setting
        // happens to be one nobody can change.
        const registry = createSettingsRegistry({
            hives,
            namespace: 'blog',
            policy: { 'window-manager/mode': 'tiled' },
        });
        await settled(registry, mode);

        expect(registry.read(mode)()).toBe('tiled');

        const resolution = registry.resolution(mode)();
        expect(resolution.locked).toBe(true);
        // The reason, so a settings screen can say why it is greyed out.
        expect(resolution.reason).toBe('Frozen into this build.');

        await expect(registry.write(mode, 'windowed')).rejects.toThrow(SettingLocked);
    });

    it('locks a value held by a hive this page may not write', async () => {
        const hives = bindings();
        await hives.system.provider.write('blog', 'window-manager/mode', 'tiled');

        const registry = createSettingsRegistry({ hives, namespace: 'blog' });
        await settled(registry, mode);

        expect(registry.resolution(mode)()).toMatchObject({ from: 'system', locked: true });
        await expect(registry.write(mode, 'windowed')).rejects.toThrow(/may not write/);
    });

    it('ignores a build policy that does not match the declaration, loudly', async () => {
        const onError = vi.fn();
        const registry = createSettingsRegistry({
            hives: bindings(),
            namespace: 'blog',
            policy: { 'window-manager/mode': 'sideways' },
            onError,
        });
        await settled(registry, mode);

        expect(registry.read(mode)()).toBe('windowed');
        expect(onError).toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------- writes

describe('writing', () => {
    it('writes to the setting’s own hive and updates the signal', async () => {
        const hives = bindings();
        const registry = createSettingsRegistry({ hives, namespace: 'blog' });
        await settled(registry, mode);

        await registry.write(mode, 'tiled');

        expect(registry.read(mode)()).toBe('tiled');
        expect((await hives.device.provider.read('blog', 'window-manager/mode'))?.value).toBe('tiled');
        // Not written to the hive that merely *could* hold it.
        expect(await hives.user.provider.read('blog', 'window-manager/mode')).toBeUndefined();
    });

    it('falls back to whatever is underneath when cleared', async () => {
        const hives = bindings();
        await hives.user.provider.write('blog', 'window-manager/mode', 'tiled');

        const registry = createSettingsRegistry({ hives, namespace: 'blog' });
        await settled(registry, mode);
        expect(registry.read(mode)()).toBe('tiled');

        // `user` holds it, so the device value is locked out — clearing the device value changes
        // nothing, which is the honest outcome rather than a silent no-op that looks like success.
        await registry.clear(mode);
        await settled(registry, mode);
        expect(registry.read(mode)()).toBe('tiled');
    });

    it('refuses a write that would never be seen', async () => {
        const hives = bindings();
        await hives.user.provider.write('blog', 'window-manager/mode', 'tiled');

        const registry = createSettingsRegistry({ hives, namespace: 'blog' });
        await settled(registry, mode);

        // `mode` writes to `device`, and `user` is earlier in the order. Accepting this write would
        // store a value nobody will ever read, and the screen would show the old one — which is how
        // a settings page comes to lie.
        await expect(registry.write(mode, 'windowed')).rejects.toThrow(SettingLocked);
    });

    it('re-resolves rather than clobbering when another writer got there first', async () => {
        const hives = bindings();
        const registry = createSettingsRegistry({ hives, namespace: 'blog' });
        await settled(registry, mode);

        await registry.write(mode, 'tiled');

        // Another tab writes the same key. The version this page holds is now stale.
        await hives.device.provider.write('blog', 'window-manager/mode', 'windowed');

        await expect(registry.write(mode, 'tiled')).rejects.toThrow(VersionConflict);
        await settled(registry, mode);

        // And it shows what is actually stored, rather than what this page tried to store.
        expect(registry.read(mode)()).toBe('windowed');
    });
});

// ---------------------------------------------------------------------------- parsing

describe('a stored value that does not match its declaration', () => {
    it('falls back to the default, and says so', async () => {
        const onError = vi.fn();
        const hives = bindings();
        // What an older version of the Application wrote, before the setting became an enum.
        await hives.device.provider.write('blog', 'window-manager/mode', { legacy: true });

        const registry = createSettingsRegistry({ hives, namespace: 'blog', onError });
        await settled(registry, mode);

        expect(registry.read(mode)()).toBe('windowed');
        expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
        expect(String(onError.mock.calls[0]?.[0])).toMatch(/does not match its declaration/);
    });

    it('checks a shape field by field', async () => {
        const hives = bindings();
        await hives.device.provider.write('blog', 'window-manager/geometry', { x: 10, y: 20, width: 300 });

        const registry = createSettingsRegistry({ hives, namespace: 'blog', onError: () => {} });
        await settled(registry, geometry);

        // `height` is missing, so the whole value is rejected: half a geometry is not a geometry,
        // and merging it with the default would put a window somewhere nobody chose.
        expect(registry.read(geometry)()).toEqual({ x: 0, y: 0, width: 480, height: 320 });
    });

    it('accepts one that does match', async () => {
        const hives = bindings();
        await hives.device.provider.write('blog', 'window-manager/geometry', { x: 10, y: 20, width: 300, height: 200 });

        const registry = createSettingsRegistry({ hives, namespace: 'blog' });
        await settled(registry, geometry);

        expect(registry.read(geometry)()).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    });

    it('has parsers for the shapes a declaration reaches for', () => {
        expect(asString('a')).toBe('a');
        expect(asString(1)).toBeUndefined();
        expect(asNumber(1)).toBe(1);
        expect(asNumber(Number.NaN)).toBeUndefined();     // NaN is not a number anyone meant
        expect(asBoolean(false)).toBe(false);
        expect(asBoolean('false')).toBeUndefined();
        expect(asOneOf(['a', 'b'] as const)('b')).toBe('b');
        expect(asOneOf(['a', 'b'] as const)('c')).toBeUndefined();
        expect(asShape({ n: asNumber })({ n: 1 })).toEqual({ n: 1 });
        expect(asShape({ n: asNumber })([])).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------- providers

describe('the local provider', () => {
    /** localStorage's interface, in a Map. */
    const fakeStore = (): KeyValueStore & { readonly map: Map<string, string> } => {
        const map = new Map<string, string>();
        return {
            map,
            getItem: (k) => map.get(k) ?? null,
            setItem: (k, v) => void map.set(k, v),
            removeItem: (k) => void map.delete(k),
            key: (i) => [...map.keys()][i] ?? null,
            get length() { return map.size; },
        };
    };

    it('stores the value and its version as one envelope', async () => {
        const store = fakeStore();
        const provider = localProvider(store);

        const written = await provider.write('blog', 'a/b', { n: 1 });
        expect((await provider.read('blog', 'a/b'))?.value).toEqual({ n: 1 });

        // One key, not two: a value and its version written separately could be updated by
        // different tabs and disagree.
        expect(store.map.size).toBe(1);
        expect([...store.map.keys()][0]).toBe(`${LOCAL_PREFIX}${keyOf('blog', 'a/b')}`);
        expect(written.version).toBeTruthy();
    });

    it('keeps working when the browser will not store anything', async () => {
        // A private window with site data blocked. Reads return nothing, writes are accepted and
        // lost, the page works — a registry that took the page down because a preference could not
        // be saved has the priority backwards.
        const provider = unavailableProvider();

        await expect(provider.write('blog', 'a/b', 1)).resolves.toBeTruthy();
        expect(provider.capabilities.watch).toBe(false);
    });

    it('reports a version conflict rather than overwriting', async () => {
        const provider = localProvider(fakeStore());
        const first = await provider.write('blog', 'a/b', 1);
        await provider.write('blog', 'a/b', 2);

        await expect(provider.write('blog', 'a/b', 3, first.version)).rejects.toThrow(VersionConflict);
        expect((await provider.read('blog', 'a/b'))?.value).toBe(2);
    });

    it('lists and measures what it holds', async () => {
        const provider = localProvider(fakeStore());
        await provider.write('blog', 'window/a', 1);
        await provider.write('blog', 'window/b', 2);
        await provider.write('blog', 'other/c', 3);

        expect((await provider.list('blog', 'window/')).map((e) => e.path).sort()).toEqual(['window/a', 'window/b']);
        expect((await provider.usage('blog')).entries).toBe(3);
    });

    it('treats a corrupt entry as absent', async () => {
        const store = fakeStore();
        const provider = localProvider(store);
        await provider.write('blog', 'a/b', 1);

        // Something else wrote here, or an older format did.
        store.map.set([...store.map.keys()][0]!, 'not json');
        expect(await provider.read('blog', 'a/b')).toBeUndefined();
    });
});

describe('the memory provider', () => {
    it('applies a batch atomically, or not at all', async () => {
        const provider = memoryProvider();
        const a = await provider.write('blog', 'a', 1);
        await provider.write('blog', 'b', 1);

        await expect(provider.batch!('blog', [
            { path: 'a', value: 2, expect: a.version },
            { path: 'b', value: 2, expect: 'stale' },
        ])).rejects.toThrow(VersionConflict);

        // The first write must not have landed. Every write is checked before any is applied.
        expect((await provider.read('blog', 'a'))?.value).toBe(1);
    });

    it('says it is only as durable as the tab', () => {
        expect(memoryProvider().capabilities.durability).toBe('session');
        expect(localProvider(undefined).capabilities.durability).toBe('device');
    });

    it('counts what it did', async () => {
        const provider = memoryProvider();
        await provider.write('blog', 'a', 1);
        await provider.read('blog', 'a');

        expect(provider.metrics()).toMatchObject({ reads: 1, writes: 1, failures: 0 });
    });
});
