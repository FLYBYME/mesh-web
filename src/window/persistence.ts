/**
 * Window geometry, remembered — roadmap A2.5.
 *
 * spec/storage-and-registry.md §7 and roadmap D5. **The `device` hive, not `user`**, and the reason
 * is concrete rather than tidy: a Deck and a desktop have different screens, so a layout that
 * followed a person from a 32-inch monitor to a laptop would put windows off the edge of it. That
 * choice is also what made D5 free — geometry lives somewhere that is never shared, so it never
 * conflicts, so conflict resolution can reject in one direction and nobody loses a window position.
 *
 * What is saved is what the *user* chose: position, size, state and stacking order in windowed mode.
 * Tiled geometry is derived from the layout and belongs to nobody, so there is nothing to remember.
 */

import { computed, effect } from '../reactivity/index.js';
import type { ReadonlySignal } from '../reactivity/types.js';
import type { Registry, Setting } from '../registry/registry.js';
import { SettingLocked, asNumber, asOneOf, asShape, asString, setting } from '../registry/registry.js';
import type { WindowManager, WindowMode } from './manager.js';
import type { WindowState } from './geometry.js';

/** One window's remembered geometry. Keyed by view, because that is what comes back. */
export interface RememberedWindow {
    readonly view: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly state: WindowState;
}

const asRemembered = asShape<RememberedWindow>({
    view: asString,
    x: asNumber,
    y: asNumber,
    width: asNumber,
    height: asNumber,
    state: asOneOf(['normal', 'minimized', 'maximized'] as const),
});

/**
 * Saved geometry for one Application.
 *
 * A list rather than a map because JSON keys are strings and a `Record` invites a caller to index it
 * with something that is not a view id. Parsed element by element: one corrupt entry drops itself
 * rather than the whole layout, which is the difference between one window at a default position and
 * every window at one.
 */
export const windowGeometry = (application: string): Setting<readonly RememberedWindow[]> =>
    setting({
        path: `window-manager/geometry/${application}`,
        hive: 'device',
        fallback: [],
        description: `Where ${application}'s windows were left, on this device.`,
        parse: (raw) => {
            if (!Array.isArray(raw)) return undefined;
            const out: RememberedWindow[] = [];
            for (const item of raw) {
                const parsed = asRemembered(item);
                if (parsed !== undefined) out.push(parsed);
            }
            return out;
        },
    });

/** The mode this device was last left in. Also `device`: a Deck is tiled, a desktop may not be. */
export const windowMode = (application: string): Setting<'windowed' | 'tiled'> =>
    setting({
        path: `window-manager/mode/${application}`,
        hive: 'device',
        fallback: 'windowed',
        description: `Whether ${application} was last shown windowed or tiled, on this device.`,
        parse: asOneOf(['windowed', 'tiled'] as const),
    });

export interface PersistenceOptions {
    readonly manager: WindowManager;
    readonly registry: Registry;
    readonly application: string;
    /** How long to wait after a change before writing. A drag is hundreds of moves. */
    readonly debounceMs?: number;
    readonly onError?: (error: unknown) => void;
}

export interface WindowPersistence {
    /**
     * Read the saved geometry.
     *
     * Awaited, and that is the point: the kernel restores at boot step 9 and starts Applications at
     * step 10, so a window comes back where it was rather than appearing at a default position and
     * jumping once the hive answers.
     */
    restore(): Promise<readonly RememberedWindow[]>;
    /** Start writing changes back. Returns a dispose function. */
    watch(): () => void;
    save(): Promise<void>;

    /** Change the mode, refusing with `SettingLocked` when policy holds it. */
    setMode(next: WindowMode): Promise<void>;

    /**
     * Whether the mode may be changed here — roadmap A2.7.
     *
     * **There is no locking mechanism.** The window manager reads a setting; a locked deployment
     * writes that setting as `system` policy, and the setting is then one nobody can change. So
     * "switching is a privilege" needs no new concept, no flag on the manager and no special case:
     * it is the registry's ordinary answer to *may this page write here*
     * (spec/storage-and-registry.md §2, spec/README §6).
     *
     * A signal, so a shell can hide or disable the control rather than offering one that fails.
     */
    readonly modePolicy: ReadonlySignal<{ readonly locked: boolean; readonly reason?: string }>;
}

export const DEFAULT_DEBOUNCE_MS = 400;

export function windowPersistence(options: PersistenceOptions): WindowPersistence {
    const { manager, registry, application } = options;
    const geometry = windowGeometry(application);
    const mode = windowMode(application);
    const onError = options.onError ?? (() => {});
    const debounce = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const save = async (): Promise<void> => {
        try {
            // Saved back-to-front, so restoring in order rebuilds the stacking without storing a
            // separate z-index that could disagree with it.
            const windows = manager.stacked().map((w): RememberedWindow => ({
                view: w.view,
                x: Math.round(w.rect.x),
                y: Math.round(w.rect.y),
                width: Math.round(w.rect.width),
                height: Math.round(w.rect.height),
                state: w.state,
            }));

            await registry.write(geometry, windows);
            await registry.write(mode, manager.mode());
        } catch (error) {
            // A preference that could not be saved must not take the page down, and must not throw
            // out of a signal effect — that would tear down the shell's own paint.
            onError(error);
        }
    };

    return {
        modePolicy: computed(() => {
            const resolved = registry.resolution(mode)();
            return resolved.locked
                ? { locked: true, ...(resolved.reason === undefined ? {} : { reason: resolved.reason }) }
                : { locked: false };
        }),

        async restore() {
            await registry.ready(geometry);
            await registry.ready(mode);
            manager.setMode(registry.read(mode)());
            return registry.read(geometry)();
        },

        /**
         * Change the mode, if this page may.
         *
         * Refuses rather than silently doing nothing, because a toggle that appears to work and
         * does not is worse than one that says why — and the reason is available, so the shell can
         * say it.
         */
        async setMode(next) {
            const policy = registry.resolution(mode)();
            if (policy.locked) {
                throw new SettingLocked(mode.path, policy.from ?? 'system', policy.reason);
            }
            manager.setMode(next);
            await registry.write(mode, next);
        },

        watch() {
            let first = true;

            // The effect body only *reads and schedules* — it does no storage work itself. The
            // write is debounced because a drag is hundreds of moves, and it happens on a timer
            // rather than in the effect so a slow or failing provider cannot sit on the paint path.
            const dispose = effect(() => {
                manager.windows();
                manager.order();
                manager.mode();

                // The first run is the subscription, not a change. Saving here would write the
                // defaults straight over whatever was just restored.
                if (first) { first = false; return; }

                if (timer !== undefined) clearTimeout(timer);
                timer = setTimeout(() => void save(), debounce);
            });

            return () => {
                if (timer !== undefined) clearTimeout(timer);
                timer = undefined;
                dispose();
            };
        },

        save,
    };
}
