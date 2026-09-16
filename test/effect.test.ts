import { describe, expect, it, vi } from 'vitest';
import {
    computed,
    effect,
    flushSync,
    signal,
    untrack,
} from '../src/reactivity/index.js';

// ---------------------------------------------------------------------------
// 1. effect() basics
// ---------------------------------------------------------------------------

describe('effect() basics', () => {
    it('runs immediately upon creation', () => {
        const spy = vi.fn();
        effect(spy);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('re-runs when a dependency signal changes', () => {
        const count = signal(0);
        const spy = vi.fn();

        effect(() => {
            spy(count());
        });

        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy).toHaveBeenLastCalledWith(0);

        count.set(1);
        flushSync();

        expect(spy).toHaveBeenCalledTimes(2);
        expect(spy).toHaveBeenLastCalledWith(1);
    });

    it('does NOT re-run when signal is set to the same value (Object.is)', () => {
        const val = signal('hello');
        const spy = vi.fn();

        effect(() => {
            spy(val());
        });

        expect(spy).toHaveBeenCalledTimes(1);

        val.set('hello'); // same value — Object.is returns true
        flushSync();

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not re-run after dispose() is called', () => {
        const count = signal(0);
        const spy = vi.fn();

        const dispose = effect(() => {
            spy(count());
        });

        expect(spy).toHaveBeenCalledTimes(1);

        dispose();

        count.set(99);
        flushSync();

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('dispose() is idempotent — calling it multiple times does not throw', () => {
        const dispose = effect(() => {});
        expect(() => {
            dispose();
            dispose();
            dispose();
        }).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// 2. effect cleanup callbacks
// ---------------------------------------------------------------------------

describe('effect cleanup callbacks', () => {
    it('cleanup is called before the next re-run, not just on dispose', () => {
        const src = signal(0);
        const order: string[] = [];

        effect(() => {
            src(); // track
            order.push('run');
            return () => {
                order.push('cleanup');
            };
        });

        expect(order).toEqual(['run']);

        src.set(1);
        flushSync();

        // cleanup from first run must fire before second run
        expect(order).toEqual(['run', 'cleanup', 'run']);
    });

    it('cleanup is called on dispose even if the effect was never re-run', () => {
        const cleanupSpy = vi.fn();

        const dispose = effect(() => {
            // No tracked dependencies — this effect never re-runs on its own
            return cleanupSpy;
        });

        expect(cleanupSpy).not.toHaveBeenCalled();

        dispose();

        expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });

    it('cleanup throwing does not prevent subsequent re-runs', () => {
        const src = signal(0);
        const runSpy = vi.fn();
        let throwOnCleanup = false;

        effect(() => {
            src(); // track
            runSpy();
            return () => {
                if (throwOnCleanup) {
                    throw new Error('cleanup error');
                }
            };
        });

        expect(runSpy).toHaveBeenCalledTimes(1);

        // Next re-run cleanup will throw
        throwOnCleanup = true;
        src.set(1);
        // Should not throw — errors in cleanup are swallowed so the effect re-runs
        expect(() => flushSync()).not.toThrow();

        expect(runSpy).toHaveBeenCalledTimes(2);

        // And yet another re-run still works
        src.set(2);
        flushSync();
        expect(runSpy).toHaveBeenCalledTimes(3);
    });

    it('two consecutive cleanup registrations run in expected order', () => {
        // First effect creates one cleanup; second effect creates another.
        // Both should be called independently in order on their own dispose.
        const order: string[] = [];

        const disposeA = effect(() => {
            return () => order.push('A-cleanup');
        });

        const disposeB = effect(() => {
            return () => order.push('B-cleanup');
        });

        disposeA();
        disposeB();

        expect(order).toEqual(['A-cleanup', 'B-cleanup']);
    });
});

// ---------------------------------------------------------------------------
// 3. signal basics
// ---------------------------------------------------------------------------

describe('signal basics', () => {
    it('peek() reads the current value without tracking as a dependency', () => {
        const a = signal(10);
        const effectSpy = vi.fn();

        effect(() => {
            // Use peek() — should NOT create a dependency
            effectSpy(a.peek());
        });

        expect(effectSpy).toHaveBeenCalledTimes(1);
        expect(effectSpy).toHaveBeenLastCalledWith(10);

        // Change the signal — effect must NOT re-run because it only peeked
        a.set(20);
        flushSync();

        expect(effectSpy).toHaveBeenCalledTimes(1);
    });

    it('update(fn) applies a transformation and notifies dependents', () => {
        const count = signal(5);
        const effectSpy = vi.fn();

        effect(() => {
            effectSpy(count());
        });

        expect(effectSpy).toHaveBeenCalledTimes(1);
        expect(effectSpy).toHaveBeenLastCalledWith(5);

        count.update((prev) => prev + 1);
        flushSync();

        expect(effectSpy).toHaveBeenCalledTimes(2);
        expect(effectSpy).toHaveBeenLastCalledWith(6);
    });

    it('writing the same value does NOT bump the version or notify dependents', () => {
        const val = signal(42);
        const spy = vi.fn();

        // Capture initial version via a computed that tracks version indirectly through reads
        const reads: number[] = [];
        effect(() => {
            reads.push(val()); // track
        });

        expect(reads).toEqual([42]);

        // Set same value
        val.set(42);
        flushSync();

        // Effect must NOT have re-run
        expect(reads).toEqual([42]);

        // Now change to a genuinely new value
        val.set(100);
        flushSync();
        expect(reads).toEqual([42, 100]);
    });

    it('throws when written to inside a computed', () => {
        const src = signal(1);
        const bad = computed(() => {
            src.set(99); // illegal write inside computed
            return 0;
        });

        expect(() => bad()).toThrow('Cannot write to a signal inside a computed');
    });
});

// ---------------------------------------------------------------------------
// 4. nested effects
// ---------------------------------------------------------------------------

describe('nested effects', () => {
    it('child effect created inside outer effect is disposed when outer re-runs', () => {
        const outer = signal(0);
        const inner = signal(0);
        const innerSpy = vi.fn();

        effect(() => {
            outer(); // track outer
            // Create a new child effect each time outer runs
            effect(() => {
                innerSpy(inner());
            });
        });

        // Initial run: outer ran once, child ran once
        expect(innerSpy).toHaveBeenCalledTimes(1);

        // inner changes — child responds
        inner.set(1);
        flushSync();
        expect(innerSpy).toHaveBeenCalledTimes(2);

        // outer changes — child is disposed, and a new child is created
        outer.set(1);
        flushSync();
        // The old child is gone; the new child ran once with current inner value (1)
        // innerSpy call count: 2 (prev) + 1 (new child initial run) = 3
        expect(innerSpy).toHaveBeenCalledTimes(3);

        // The OLD child must be dead; changing inner should only trigger ONE new child
        inner.set(2);
        flushSync();
        expect(innerSpy).toHaveBeenCalledTimes(4); // only 1 live child responds
    });

    it('child effect disposed independently does not double-dispose or throw', () => {
        const outer = signal(0);
        let childDispose: (() => void) | null = null;

        const cleanupSpy = vi.fn();

        effect(() => {
            outer(); // track
            childDispose = effect(() => {
                return cleanupSpy;
            });
        });

        expect(cleanupSpy).not.toHaveBeenCalled();

        // Manually dispose child
        childDispose!();
        expect(cleanupSpy).toHaveBeenCalledTimes(1);

        // Re-run outer — should handle the already-disposed child gracefully
        outer.set(1);
        expect(() => flushSync()).not.toThrow();

        // Cleanup is NOT called again for the already-disposed child;
        // a new child was created by the re-run and its cleanup has not fired yet
        expect(cleanupSpy).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// 5. effects and computed interaction
// ---------------------------------------------------------------------------

describe('effects and computed interaction', () => {
    it('effect only re-runs when the computed output value changes, not just when its inputs change', () => {
        const num = signal(1);
        // isOdd changes only when the parity flips (1 -> 2 changes parity; 2 -> 4 does not)
        const isOdd = computed(() => num() % 2 !== 0);
        const effectSpy = vi.fn();

        effect(() => {
            effectSpy(isOdd());
        });

        expect(effectSpy).toHaveBeenCalledTimes(1);
        expect(effectSpy).toHaveBeenLastCalledWith(true);

        // 1 -> 3: isOdd remains true — effect must NOT re-run
        num.set(3);
        flushSync();
        expect(effectSpy).toHaveBeenCalledTimes(1);

        // 3 -> 4: isOdd becomes false — effect MUST re-run
        num.set(4);
        flushSync();
        expect(effectSpy).toHaveBeenCalledTimes(2);
        expect(effectSpy).toHaveBeenLastCalledWith(false);

        // 4 -> 6: isOdd stays false — effect must NOT re-run
        num.set(6);
        flushSync();
        expect(effectSpy).toHaveBeenCalledTimes(2);
    });

    it('effect reading a computed chain A->B->C does NOT re-run when intermediate node absorbs the change', () => {
        // A is a raw signal.
        // B = computed that returns Math.abs(A) — so -5 and 5 produce the same output.
        // C = computed that doubles B.
        // The effect reads C.
        const a = signal(5);
        const b = computed(() => Math.abs(a()));
        const c = computed(() => b() * 2);
        const effectSpy = vi.fn();

        effect(() => {
            effectSpy(c());
        });

        expect(effectSpy).toHaveBeenCalledTimes(1);
        expect(effectSpy).toHaveBeenLastCalledWith(10); // abs(5)*2

        // Change a from 5 to -5: b stays 5, c stays 10 — effect must NOT re-run
        a.set(-5);
        flushSync();
        expect(effectSpy).toHaveBeenCalledTimes(1);

        // Change a to 3: b becomes 3, c becomes 6 — effect MUST re-run
        a.set(3);
        flushSync();
        expect(effectSpy).toHaveBeenCalledTimes(2);
        expect(effectSpy).toHaveBeenLastCalledWith(6);
    });
});

// ---------------------------------------------------------------------------
// 6. flush depth guard
// ---------------------------------------------------------------------------

describe('flush depth guard', () => {
    it('throws "Maximum reactive flush depth exceeded" when effects loop infinitely', () => {
        const ping = signal(0);
        const pong = signal(0);

        effect(() => {
            ping.set(pong() + 1);
        });

        effect(() => {
            pong.set(ping() + 1);
        });

        expect(() => flushSync()).toThrow('Maximum reactive flush depth exceeded');
    });
});
