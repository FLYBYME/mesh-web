import type { ReactiveScope, IDisposableContainer } from './types.js';
import { getActiveScopeContext, setActiveScopeContext } from './context.js';

/**
 * ReactiveScopeImpl: owns a collection of reactive effects and resources.
 *
 * When an App or component unloads, its entire scope is disposed at once,
 * freeing subscriptions and aborting in-flight work without manual bookkeeping.
 */
class ReactiveScopeImpl implements ReactiveScope, IDisposableContainer {
    private disposables: Set<() => void> = new Set();
    private isDisposed = false;
    private parentScope: IDisposableContainer | null = null;

    constructor() {
        this.parentScope = getActiveScopeContext();
        if (this.parentScope !== null) {
            this.parentScope.addDisposable(() => this.dispose());
        }
    }

    addDisposable(dispose: () => void): void {
        if (this.isDisposed) {
            try {
                dispose();
            } catch {
                // continue
            }
            return;
        }
        this.disposables.add(dispose);
    }

    removeDisposable(dispose: () => void): void {
        this.disposables.delete(dispose);
    }

    run<T>(fn: () => T): T {
        if (this.isDisposed) {
            throw new Error('Cannot run within a disposed ReactiveScope');
        }
        const prev = setActiveScopeContext(this);
        try {
            return fn();
        } finally {
            setActiveScopeContext(prev);
        }
    }

    dispose(): void {
        if (this.isDisposed) return;
        this.isDisposed = true;

        if (this.parentScope !== null) {
            this.parentScope.removeDisposable(() => this.dispose());
        }

        const items = Array.from(this.disposables);
        this.disposables.clear();

        let firstError: unknown = null;
        for (const item of items) {
            try {
                item();
            } catch (err) {
                if (firstError === null) {
                    firstError = err;
                }
            }
        }

        if (firstError !== null) {
            throw firstError;
        }
    }
}

/**
 * Creates a ReactiveScope owned by whatever scope is currently running.
 *
 * That parenting is usually what you want — a scope created inside an effect dies with it — but see
 * `createDetachedScope` for the case where it is exactly wrong.
 */
export function createScope(): ReactiveScope {
    return new ReactiveScopeImpl();
}

/**
 * Creates a ReactiveScope owned by **nobody**.
 *
 * For the case where a caller is handed an explicit `dispose()` and is therefore the owner. Handing
 * something a dispose function while also disposing it yourself is not two owners, it is a bug that
 * looks like a reactivity failure:
 *
 *   1. a shell mounts a view inside an effect that paints windows
 *   2. the view's scope silently becomes that effect's child
 *   3. the user clicks the window, focus changes, the paint effect re-runs
 *   4. re-running disposes its children first — so the view is now dead, still on screen, and
 *      updating nothing
 *
 * That is a real report from the first person to use the harness: "when I click new post I only see
 * it after I open a second window". The second window was a *fresh* mount reading current state; the
 * first had been disposed by the effect that created it.
 *
 * The renderer already solves the same problem internally, where `when` and `each` build their
 * content under an explicit owner rather than under the reconciling effect. This is that rule at the
 * public boundary: an explicitly-disposed thing must not be implicitly owned.
 */
export function createDetachedScope(): ReactiveScope {
    const previous = setActiveScopeContext(null);
    try {
        return new ReactiveScopeImpl();
    } finally {
        setActiveScopeContext(previous);
    }
}
