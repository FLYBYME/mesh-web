import { describe, expect, it, vi } from 'vitest';
import {
    batch,
    computed,
    createDetachedScope,
    createScope,
    effect,
    flushSync,
    resource,
    runDetached,
    signal,
    untrack,
} from '../src/reactivity/index.js';

describe('reactivity system', () => {
    describe('computed signals', () => {
        it('is lazily evaluated on first read', () => {
            const spy = vi.fn(() => 42);
            const c = computed(spy);

            expect(spy).not.toHaveBeenCalled();
            expect(c()).toBe(42);
            expect(spy).toHaveBeenCalledTimes(1);

            // Cached on subsequent reads
            expect(c()).toBe(42);
            expect(spy).toHaveBeenCalledTimes(1);
        });

        it('dynamically adapts dependencies when branches switch', () => {
            const condition = signal(true);
            const branchA = signal('A');
            const branchB = signal('B');

            const runs = vi.fn();
            const c = computed(() => {
                runs();
                return condition() ? branchA() : branchB();
            });

            expect(c()).toBe('A');
            expect(runs).toHaveBeenCalledTimes(1);

            // While condition is true, changing branchB should NOT invalidate c
            branchB.set('B-updated');
            expect(c()).toBe('A');
            expect(runs).toHaveBeenCalledTimes(1);

            // Changing branchA should invalidate and recompute
            branchA.set('A-updated');
            expect(c()).toBe('A-updated');
            expect(runs).toHaveBeenCalledTimes(2);

            // Switch to branchB
            condition.set(false);
            expect(c()).toBe('B-updated');
            expect(runs).toHaveBeenCalledTimes(3);

            // Now branchA should no longer trigger c
            branchA.set('A-again');
            expect(c()).toBe('B-updated');
            expect(runs).toHaveBeenCalledTimes(3);
        });

        it('detects circular dependencies in computed graph and throws', () => {
            let compA: ReturnType<typeof computed>;
            let compB: ReturnType<typeof computed>;

            compA = computed(() => compB(), 'compA');
            compB = computed(() => compA(), 'compB');

            expect(() => compA()).toThrow(/Cycle detected in computed: compA -> compB -> compA/);
        });

        it('solves diamond dependencies without glitching or redundant runs', () => {
            const root = signal(1);
            const leftRuns = vi.fn();
            const rightRuns = vi.fn();
            const bottomRuns = vi.fn();

            const left = computed(() => {
                leftRuns();
                return root() * 2;
            }, 'left');

            const right = computed(() => {
                rightRuns();
                return root() + 10;
            }, 'right');

            const bottom = computed(() => {
                bottomRuns();
                return left() + right();
            }, 'bottom');

            expect(bottom()).toBe(2 + 11); // 13
            expect(leftRuns).toHaveBeenCalledTimes(1);
            expect(rightRuns).toHaveBeenCalledTimes(1);
            expect(bottomRuns).toHaveBeenCalledTimes(1);

            // Update root
            root.set(2);
            expect(bottom()).toBe(4 + 12); // 16
            expect(leftRuns).toHaveBeenCalledTimes(2);
            expect(rightRuns).toHaveBeenCalledTimes(2);
            expect(bottomRuns).toHaveBeenCalledTimes(2);
        });

        it('does not bump version or trigger subscribers if output value is identical', () => {
            const num = signal(5);
            const isPositive = computed(() => num() > 0);
            const effectSpy = vi.fn();

            effect(() => {
                effectSpy(isPositive());
            });

            expect(effectSpy).toHaveBeenCalledTimes(1);
            expect(effectSpy).toHaveBeenLastCalledWith(true);

            // Changing num to 10 still leaves isPositive() === true
            num.set(10);
            flushSync();

            // isPositive re-evaluated internally, but value didn't change, so effect does not run again
            expect(effectSpy).toHaveBeenCalledTimes(1);

            // Changing num to -1 toggles isPositive
            num.set(-1);
            flushSync();
            expect(effectSpy).toHaveBeenCalledTimes(2);
            expect(effectSpy).toHaveBeenLastCalledWith(false);
        });
    });

    describe('batch & untrack', () => {
        it('coalesces multiple updates into a single effect execution', () => {
            const a = signal(0);
            const b = signal(0);
            const results: number[] = [];

            effect(() => {
                results.push(a() + b());
            });

            expect(results).toEqual([0]);

            batch(() => {
                a.set(1);
                b.set(2);
                a.set(10);
            });

            expect(results).toEqual([0, 12]);
        });

        it('resets batch depth when an error is thrown inside batch', () => {
            const a = signal(1);
            const spy = vi.fn();

            effect(() => {
                spy(a());
            });

            expect(() => {
                batch(() => {
                    a.set(2);
                    throw new Error('boom');
                });
            }).toThrow('boom');

            // Subsequent set and effects should continue functioning normally
            a.set(3);
            flushSync();
            expect(spy).toHaveBeenCalledWith(3);
        });

        it('untrack reads signals without subscribing to them', () => {
            const a = signal(1);
            const b = signal(10);
            const spy = vi.fn();

            effect(() => {
                const valA = a();
                const valB = untrack(() => b());
                spy(valA, valB);
            });

            expect(spy).toHaveBeenCalledWith(1, 10);

            // Updating b does NOT re-trigger effect
            b.set(20);
            flushSync();
            expect(spy).toHaveBeenCalledTimes(1);

            // Updating a DOES re-trigger effect and reads current b
            a.set(2);
            flushSync();
            expect(spy).toHaveBeenCalledTimes(2);
            expect(spy).toHaveBeenLastCalledWith(2, 20);
        });
    });

    describe('scope management', () => {
        it('disposing a parent scope disposes nested effects and computeds', () => {
            const scope = createScope();
            const val = signal(1);
            const cleanupSpy = vi.fn();
            const effectSpy = vi.fn();

            scope.run(() => {
                effect(() => {
                    effectSpy(val());
                    return cleanupSpy;
                });
            });

            expect(effectSpy).toHaveBeenCalledWith(1);

            val.set(2);
            flushSync();
            expect(effectSpy).toHaveBeenCalledWith(2);
            expect(cleanupSpy).toHaveBeenCalledTimes(1);

            scope.dispose();
            expect(cleanupSpy).toHaveBeenCalledTimes(2);

            // Further updates must be inert
            val.set(3);
            flushSync();
            expect(effectSpy).toHaveBeenCalledTimes(2);
        });

        it('createDetachedScope does not attach to outer parent scope', () => {
            const parentScope = createScope();
            let detachedScope!: ReturnType<typeof createDetachedScope>;
            const val = signal('init');
            const detachedEffectSpy = vi.fn();

            parentScope.run(() => {
                detachedScope = createDetachedScope();
                detachedScope.run(() => {
                    effect(() => {
                        detachedEffectSpy(val());
                    });
                });
            });

            expect(detachedEffectSpy).toHaveBeenCalledWith('init');

            // Disposing parent scope does not dispose detached scope
            parentScope.dispose();

            val.set('still-alive');
            flushSync();
            expect(detachedEffectSpy).toHaveBeenCalledWith('still-alive');

            // Disposing detached scope cleans it up
            detachedScope.dispose();
            val.set('dead');
            flushSync();
            expect(detachedEffectSpy).toHaveBeenCalledTimes(2);
        });

        it('runDetached executes callback in an isolated detached scope', () => {
            const parent = createScope();
            const spy = vi.fn();

            parent.run(() => {
                const result = runDetached(() => {
                    return 42;
                });
                spy(result);
            });

            expect(spy).toHaveBeenCalledWith(42);
        });
    });

    describe('resource', () => {
        it('fetches initial data and tracks loading/error signals', async () => {
            const res = resource(async () => {
                return 'hello resource';
            });

            expect(res.loading()).toBe(true);
            expect(res.data()).toBeUndefined();
            expect(res.error()).toBeNull();

            const result = await res.refetch();

            expect(result).toBe('hello resource');
            expect(res.loading()).toBe(false);
            expect(res.data()).toBe('hello resource');
            expect(res()).toBe('hello resource');
            expect(res.peek()).toBe('hello resource');
            expect(res.error()).toBeNull();

            res.dispose();
        });

        it('automatically refetches when reactive dependencies change', async () => {
            const id = signal(1);
            let fetchCount = 0;

            const res = resource(async () => {
                const currentId = id();
                fetchCount++;
                return `item-${currentId}`;
            });

            await flushSync();
            // Wait for initial fetch
            await vi.waitFor(() => expect(res.data()).toBe('item-1'));
            expect(fetchCount).toBe(1);

            // Change signal dependency
            id.set(2);
            await flushSync();

            await vi.waitFor(() => expect(res.data()).toBe('item-2'));
            expect(fetchCount).toBe(2);

            res.dispose();
        });

        it('discards out-of-order stale responses', async () => {
            const id = signal(1);
            const resolvers: ((val: string) => void)[] = [];

            const res = resource(async () => {
                const currentId = id();
                return new Promise<string>((resolve) => {
                    resolvers[currentId] = resolve;
                });
            });

            await flushSync();
            expect(res.loading()).toBe(true);

            // Trigger second request before first finishes
            id.set(2);
            await flushSync();

            // Resolve request 2 first
            resolvers[2]!('result-2');
            await vi.waitFor(() => expect(res.data()).toBe('result-2'));
            expect(res.loading()).toBe(false);

            // Now resolve stale request 1: must be discarded
            resolvers[1]!('stale-result-1');
            await flushSync();

            expect(res.data()).toBe('result-2');
            res.dispose();
        });

        it('deduplicates concurrent in-flight refetch calls', async () => {
            let fetchCount = 0;
            let resolveFetch!: (v: string) => void;

            const res = resource(async () => {
                fetchCount++;
                return new Promise<string>((resolve) => {
                    resolveFetch = resolve;
                });
            });

            await flushSync();
            expect(fetchCount).toBe(1);

            // Call refetch() while fetch is already in flight
            const p1 = res.refetch();
            const p2 = res.refetch();

            resolveFetch('done');
            const [v1, v2] = await Promise.all([p1, p2]);

            expect(v1).toBe('done');
            expect(v2).toBe('done');
            expect(fetchCount).toBe(1);

            res.dispose();
        });

        it('handles synchronous and asynchronous errors and preserves previous data', async () => {
            let shouldFail = false;
            let count = 0;

            const res = resource(async () => {
                count++;
                if (shouldFail) {
                    throw new Error(`fetch failed on try ${count}`);
                }
                return `success ${count}`;
            });

            await vi.waitFor(() => expect(res.data()).toBe('success 1'));
            expect(res.error()).toBeNull();

            // Next fetch fails
            shouldFail = true;
            await res.refetch();

            expect(res.loading()).toBe(false);
            expect(res.error()?.message).toBe('fetch failed on try 2');
            // Data is preserved from previous successful run
            expect(res.data()).toBe('success 1');

            res.dispose();
        });

        it('allows direct mutation and patching', async () => {
            const res = resource(async () => {
                return { count: 10, name: 'mesh' };
            });

            await vi.waitFor(() => expect(res.data()).toEqual({ count: 10, name: 'mesh' }));

            // patch
            res.patch((curr) => ({ ...curr, count: curr.count + 5 }));
            expect(res.data()).toEqual({ count: 15, name: 'mesh' });

            // mutate with value
            res.mutate({ count: 20, name: 'mesh' });
            expect(res.data()).toEqual({ count: 20, name: 'mesh' });

            // mutate with functional mutator
            res.mutate((prev) => (prev ? { ...prev, count: prev.count + 1 } : undefined));
            expect(res.data()).toEqual({ count: 21, name: 'mesh' });

            res.dispose();
        });

        it('auto-disposes when created inside an active ReactiveScope', async () => {
            const scope = createScope();
            let res!: ReturnType<typeof resource<string>>;
            let fetchCount = 0;
            const param = signal('a');

            scope.run(() => {
                res = resource(async () => {
                    fetchCount++;
                    return `data-${param()}`;
                });
            });

            await vi.waitFor(() => expect(res.data()).toBe('data-a'));
            expect(fetchCount).toBe(1);

            // Dispose outer scope
            scope.dispose();

            // Changing param after scope disposal must not trigger fetch
            param.set('b');
            await flushSync();
            expect(fetchCount).toBe(1);

            // Refetch on disposed resource returns undefined
            const result = await res.refetch();
            expect(result).toBeUndefined();
        });
    });
});
