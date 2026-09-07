import type { ReactiveScope, IDisposableContainer } from './types.js';
import {
    getActiveComputedStack, getActiveScopeContext, popActiveComputed, pushActiveComputed,
    setActiveScopeContext, setCurrentSubscriber, type IComputedNode,
} from './context.js';

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

/**
 * Run something with **no owner, no subscriber and no computed above it**.
 *
 * The same rule as `createDetachedScope`, applied to a value rather than to a scope: *an
 * explicitly-disposed thing must not be implicitly owned*. A lazily-created object inherits
 * whatever happened to be evaluating at the moment of first use, and "whoever read it first" is
 * never a sensible owner — it is an accident of render order.
 *
 * Found through a signed-out console still showing the previous user's rows. A collection's default
 * query is created on first read; in that console the first read was inside a `computed` deriving
 * an error message, so the query's session effect became owned by that computed — and was disposed
 * the moment the computed re-evaluated, which the first successful fetch guaranteed. From then on
 * the collection had rows, no effects, and no way to hear about a sign-out. Constructing it also
 * *threw* `Cannot write to a signal inside a computed`, since the effect writes `loading` as it
 * starts, and that throw was swallowed by the caller.
 *
 * All three are cleared, because all three do damage: the scope makes ownership wrong, the
 * subscriber makes the reader depend on internals it never asked about, and the computed stack
 * makes any write during construction an error.
 */
export function runDetached<T>(fn: () => T): T {
    const previousScope = setActiveScopeContext(null);
    const previousSubscriber = setCurrentSubscriber(null);

    // Unwound and restored in order, because a computed evaluating inside another computed is
    // ordinary and the stack has to come back exactly as it was.
    const unwound: IComputedNode[] = [];
    while (getActiveComputedStack().length > 0) {
        const popped = popActiveComputed();
        if (popped === undefined) break;
        unwound.push(popped);
    }

    try {
        return fn();
    } finally {
        for (let i = unwound.length - 1; i >= 0; i -= 1) {
            const node = unwound[i];
            if (node !== undefined) pushActiveComputed(node);
        }
        setCurrentSubscriber(previousSubscriber);
        setActiveScopeContext(previousScope);
    }
}
