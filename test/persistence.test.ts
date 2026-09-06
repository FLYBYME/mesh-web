/**
 * Window geometry, remembered — roadmap A2.5.
 *
 * The `device` hive, not `user`, and the reason is concrete: a Deck and a desktop have different
 * screens, so a layout that followed a person between them would put windows off the edge. That is
 * also what made D5 free — geometry lives somewhere never shared, so it never conflicts.
 */

import { describe, expect, it, vi } from 'vitest';

import {
    SettingLocked, WindowManager, createSettingsRegistry, memoryProvider, pageWindowMode, windowGeometry,
    windowMode, windowPersistence,
    type HiveBindings, type Registry, type StorageProvider,
} from '../src/index.js';

const hives = (device: StorageProvider): HiveBindings => ({
    system: { provider: memoryProvider('system'), writable: false },
    user: { provider: memoryProvider('user'), writable: true },
    device: { provider: device, writable: true },
    session: { provider: memoryProvider('session'), writable: true },
});

const registryOver = (device: StorageProvider): Registry =>
    createSettingsRegistry({ hives: hives(device), namespace: 'blog' });

const openThree = (manager: WindowManager): void => {
    manager.open({ owner: 'p1', view: 'masthead', tile: 'header' });
    manager.open({ owner: 'p1', view: 'sidebar', tile: 'sidebar' });
    manager.open({ owner: 'p1', view: 'reader', tile: 'content' });
};

/** The debounce plus a margin, so a save has actually happened. */
const afterSave = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

describe('geometry survives a reload', () => {
    it('saves where the user put a window, and reads it back', async () => {
        const device = memoryProvider('device');

        const first = new WindowManager({ width: 1000, height: 600 });
        const saving = windowPersistence({
            manager: first,
            registry: registryOver(device),
            application: 'blog',
            debounceMs: 5,
        });

        openThree(first);
        const stop = saving.watch();

        const window = first.windows()[0]!;
        first.move(window.id, 120, 60);
        await afterSave();
        stop();

        // A second page, a second manager, the same device.
        const restored = await windowPersistence({
            manager: new WindowManager({ width: 1000, height: 600 }),
            registry: registryOver(device),
            application: 'blog',
        }).restore();

        expect(restored).toHaveLength(3);
        const masthead = restored.find((w) => w.view === 'masthead')!;
        expect(masthead.x).toBe(Math.round(first.get(window.id)!.rect.x));
        expect(masthead.y).toBe(Math.round(first.get(window.id)!.rect.y));
    });

    it('remembers the mode this device was left in', async () => {
        const device = memoryProvider('device');

        const manager = new WindowManager({ width: 1000, height: 600 });
        const persistence = windowPersistence({
            manager, registry: registryOver(device), application: 'blog', debounceMs: 5,
        });

        openThree(manager);
        const stop = persistence.watch();
        manager.setMode('tiled');
        await afterSave();
        stop();

        const next = new WindowManager({ width: 1000, height: 600 });
        await windowPersistence({ manager: next, registry: registryOver(device), application: 'blog' }).restore();

        // A Deck is tiled and a desktop may not be, which is why this is `device` too.
        expect(next.mode()).toBe('tiled');
    });

    it('keeps two Applications apart', async () => {
        const device = memoryProvider('device');

        const blog = new WindowManager({ width: 1000, height: 600 });
        blog.open({ owner: 'p1', view: 'sidebar' });
        const stop = windowPersistence({
            manager: blog, registry: registryOver(device), application: 'blog', debounceMs: 5,
        }).watch();
        blog.move(blog.windows()[0]!.id, 50, 50);
        await afterSave();
        stop();

        const console_ = await windowPersistence({
            manager: new WindowManager(), registry: registryOver(device), application: 'console',
        }).restore();

        expect(console_).toEqual([]);
    });

    it('does not write over what it just restored', async () => {
        const device = memoryProvider('device');
        await device.write('blog', 'window-manager/geometry/blog', [
            { view: 'sidebar', x: 10, y: 20, width: 300, height: 200, state: 'normal' },
        ]);

        const manager = new WindowManager({ width: 1000, height: 600 });
        const persistence = windowPersistence({
            manager, registry: registryOver(device), application: 'blog', debounceMs: 5,
        });

        await persistence.restore();
        // Nothing open yet, and watching starts here. The first effect run is the *subscription*,
        // not a change — saving on it would write an empty list straight over the restore.
        const stop = persistence.watch();
        await afterSave();
        stop();

        const stored = (await device.read('blog', 'window-manager/geometry/blog'))?.value;
        expect(stored).toEqual([
            { view: 'sidebar', x: 10, y: 20, width: 300, height: 200, state: 'normal' },
        ]);
    });
});

describe('what it does with a bad or missing value', () => {
    it('starts empty when nothing was saved', async () => {
        const restored = await windowPersistence({
            manager: new WindowManager(),
            registry: registryOver(memoryProvider('device')),
            application: 'blog',
        }).restore();

        expect(restored).toEqual([]);
    });

    it('drops one corrupt entry rather than the whole layout', async () => {
        const device = memoryProvider('device');
        await device.write('blog', 'window-manager/geometry/blog', [
            { view: 'sidebar', x: 10, y: 20, width: 300, height: 200, state: 'normal' },
            { view: 'reader', x: 'somewhere' },                        // written by an older version
            { view: 'masthead', x: 0, y: 0, width: 400, height: 44, state: 'normal' },
        ]);

        const restored = await windowPersistence({
            manager: new WindowManager(), registry: registryOver(device), application: 'blog',
        }).restore();

        // One window at a default position is a much better outcome than every window at one.
        expect(restored.map((w) => w.view)).toEqual(['sidebar', 'masthead']);
    });

    it('keeps going when the device hive refuses a write', async () => {
        const device = memoryProvider('device');
        const failing: StorageProvider = {
            ...device,
            write: () => Promise.reject(new Error('QuotaExceededError')),
        };

        const onError = vi.fn();
        const manager = new WindowManager({ width: 1000, height: 600 });
        const persistence = windowPersistence({
            manager, registry: registryOver(failing), application: 'blog', debounceMs: 5, onError,
        });

        openThree(manager);
        const stop = persistence.watch();
        manager.move(manager.windows()[0]!.id, 10, 10);
        await afterSave();
        stop();

        // A preference that could not be saved must not take the page down, and must not throw out
        // of the effect — that would tear down the shell's own paint.
        expect(onError).toHaveBeenCalled();
        expect(manager.windows()).toHaveLength(3);
    });
});

describe('the declarations', () => {
    it('put geometry and mode in the device hive, per application', () => {
        expect(windowGeometry('blog')).toMatchObject({
            path: 'window-manager/geometry/blog',
            hive: 'device',
        });
        expect(windowMode('console')).toMatchObject({
            path: 'window-manager/mode/console',
            hive: 'device',
            fallback: 'windowed',
        });
    });
});

describe('a window maximized before a reload can still be turned back', () => {
    it('remembers where it was, not the viewport it was filling', async () => {
        /**
         * The defect this exists for: `save()` wrote `w.rect`, which for a maximized window is the
         * whole viewport, alongside `state: 'maximized'`. Restoring placed the window at that rect
         * and called `maximize()`, which captures the *current* rect as the one to restore to — so
         * the restore rect became the maximized rect and **the restore button was a permanent
         * no-op**. Reported by a user who could maximize a window and never get it back.
         *
         * The fix is that the saved geometry means *where this window sits when it is not
         * maximized*, so restoring is `place(normal)` then `maximize()` and the restore rect lands
         * on the normal geometry by construction.
         */
        const device = memoryProvider('device');

        const first = new WindowManager({ width: 1000, height: 600 });
        const saving = windowPersistence({
            manager: first, registry: registryOver(device), application: 'blog', debounceMs: 5,
        });

        openThree(first);
        const stop = saving.watch();

        const window = first.windows()[0]!;
        first.move(window.id, 120, 60);
        const normal = { ...first.get(window.id)!.rect };

        first.maximize(window.id);
        expect(first.get(window.id)!.rect).toEqual({ x: 0, y: 0, width: 1000, height: 600 });
        await afterSave();
        stop();

        const restored = await windowPersistence({
            manager: new WindowManager({ width: 1000, height: 600 }),
            registry: registryOver(device),
            application: 'blog',
        }).restore();

        const saved = restored.find((w) => w.view === window.view)!;
        expect(saved.state).toBe('maximized');
        expect({ x: saved.x, y: saved.y, width: saved.width, height: saved.height })
            .toEqual({
                x: Math.round(normal.x), y: Math.round(normal.y),
                width: Math.round(normal.width), height: Math.round(normal.height),
            });

        // And the round trip a page actually performs: place the normal geometry, maximize, then
        // ask to be turned back. This is the assertion that failed before the fix.
        const second = new WindowManager({ width: 1000, height: 600 });
        const again = second.open({ owner: 'p1', view: window.view });
        second.place(again.id, { x: saved.x, y: saved.y, width: saved.width, height: saved.height });
        second.maximize(again.id);
        second.restore(again.id);

        expect(second.get(again.id)!.rect).toEqual(normal);
        expect(second.get(again.id)!.state).toBe('normal');
    });
});

describe('page-level window mode policy', () => {
    it('declares pageWindowMode with fallback windowed in device hive', () => {
        expect(pageWindowMode).toMatchObject({
            path: 'window-manager/mode',
            hive: 'device',
            fallback: 'windowed',
        });
    });

    it('locks mode and restores single when pageWindowMode is pinned by policy', async () => {
        const device = memoryProvider('device');
        const registry = createSettingsRegistry({
            hives: hives(device),
            namespace: 'blog',
            policy: { 'window-manager/mode': 'single' },
        });

        const manager = new WindowManager({ width: 1000, height: 600 });
        const persistence = windowPersistence({
            manager,
            registry,
            application: 'blog',
        });

        expect(persistence.modePolicy().locked).toBe(true);

        await persistence.restore();
        expect(manager.mode()).toBe('single');

        await expect(persistence.setMode('windowed')).rejects.toThrow(SettingLocked);
    });

    it('prefers page-level window mode over per-application setting', async () => {
        const device = memoryProvider('device');
        await device.write('blog', 'window-manager/mode', 'single');
        await device.write('blog', 'window-manager/mode/blog', 'tiled');

        const registry = createSettingsRegistry({
            hives: hives(device),
            namespace: 'blog',
        });

        const manager = new WindowManager({ width: 1000, height: 600 });
        const persistence = windowPersistence({
            manager,
            registry,
            application: 'blog',
        });

        await persistence.restore();
        expect(manager.mode()).toBe('single');
    });
});

