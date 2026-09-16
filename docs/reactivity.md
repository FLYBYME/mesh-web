# Reactivity System

`@flybyme/mesh-web` features an in-house, fine-grained reactive dependency tracking engine located in [`src/reactivity/`](file:///home/ubuntu/code/mesh-web/src/reactivity/). It operates independently of any UI library (such as React or Vue), executing fine-grained updates without virtual DOM trees or reconciliation loops.

---

## Core Primitives

### 1. `signal<T>(initial)` ([`src/reactivity/signal.ts`](file:///home/ubuntu/code/mesh-web/src/reactivity/signal.ts))

A signal is a mutable reactive value container:

```ts
import { signal } from '@flybyme/mesh-web';

const count = signal(0);

// Reading (registers dependency if called within an effect or computed):
console.log(count()); // 0

// Non-tracking read:
console.log(count.peek()); // 0

// Writing:
count.set(1);

// Updating via transformer:
count.update(n => n + 1);
```

- **Reference Equality**: Writing the identical value (`Object.is(prev, next)`) is a no-op and does not trigger downstream subscribers.
- **Version Tracking**: Every mutation increments an internal version counter, enabling computeds to detect changes without re-evaluating dependencies.

---

### 2. `computed<T>(fn)` ([`src/reactivity/computed.ts`](file:///home/ubuntu/code/mesh-web/src/reactivity/computed.ts))

A computed value is a lazily evaluated derived signal that tracks its dependencies:

```ts
import { signal, computed } from '@flybyme/mesh-web';

const first = signal('Ada');
const last = signal('Lovelace');

const fullName = computed(() => `${first()} ${last()}`);

console.log(fullName()); // "Ada Lovelace"
```

#### Lazy Evaluation & Tri-State Graph
The engine uses a tri-state versioning model:
- `NodeState.CLEAN (0)`: Up-to-date; returns cached value immediately.
- `NodeState.CHECK (1)`: Upstream dependency changed; checks whether dependency versions actually increased before re-evaluating.
- `NodeState.DIRTY (2)`: Must re-evaluate on the next read.

If an upstream signal changes to an identical value or a computed's own output does not change, downstream dependents are spared from re-executing.

#### Cycle Protection
If computed A reads computed B which reads computed A, the engine detects the recursive cycle and throws:
```
Cycle detected in computed graph
```

---

### 3. `effect(fn)` ([`src/reactivity/effect.ts`](file:///home/ubuntu/code/mesh-web/src/reactivity/effect.ts))

An effect executes immediately, tracks all signals read during execution, and re-runs whenever any dependency changes:

```ts
import { signal, effect } from '@flybyme/mesh-web';

const count = signal(0);

const dispose = effect(() => {
    console.log(`Count is: ${count()}`);
    
    // Optional cleanup callback:
    return () => {
        console.log('Cleaning up previous run');
    };
});

count.set(1);
// Logs: "Cleaning up previous run"
// Logs: "Count is: 1"

// Stop the effect:
dispose();
```

---

## Batching and Execution Control ([`src/reactivity/batch.ts`](file:///home/ubuntu/code/mesh-web/src/reactivity/batch.ts))

### `batch(fn)`
Coalesces multiple signal updates into a single notification pass:

```ts
import { signal, effect, batch } from '@flybyme/mesh-web';

const a = signal(1);
const b = signal(2);

effect(() => console.log(a() + b())); // Runs once (prints 3)

batch(() => {
    a.set(10);
    b.set(20);
}); // Effect runs once at the end of the batch (prints 30)
```

### `untrack(fn)`
Executes code without registering any read signals as dependencies in the current reactive context:

```ts
import { signal, effect, untrack } from '@flybyme/mesh-web';

const a = signal(1);
const b = signal(2);

effect(() => {
    const valA = a(); // Tracked
    const valB = untrack(() => b()); // NOT tracked
    console.log(valA, valB);
});

b.set(99); // Does NOT trigger the effect
a.set(5);  // Triggers the effect (reads fresh b = 99)
```

### `flushSync()`
Flushes any pending microtask effect queue synchronously. Used during testing and immediate DOM measurements.

---

## Async Data: `resource<T>(fetcher)` ([`src/reactivity/resource.ts`](file:///home/ubuntu/code/mesh-web/src/reactivity/resource.ts))

Wraps asynchronous data fetching in a set of reactive signals:

```ts
import { resource } from '@flybyme/mesh-web';

const user = resource(async () => {
    const res = await fetch('/api/user');
    return res.json();
});

// Reading states:
user();            // User | undefined (convenience getter for data)
user.data();       // User | undefined
user.loading();    // boolean
user.error();      // Error | null

// Manual operations:
await user.refetch();
user.mutate(newUser);
user.patch(curr => ({ ...curr, name: 'New Name' }));
user.dispose();
```

---

## Reactive Scope Management ([`src/reactivity/scope.ts`](file:///home/ubuntu/code/mesh-web/src/reactivity/scope.ts))

When building long-running single-page applications, memory leaks occur when effects outlive the views that created them. `@flybyme/mesh-web` solves this with hierarchical [`ReactiveScope`](file:///home/ubuntu/code/mesh-web/src/reactivity/types.ts#L28):

```ts
import { createScope, effect } from '@flybyme/mesh-web';

const scope = createScope();

scope.run(() => {
    effect(() => {
        // This effect is bound to `scope`
    });
});

// Disposing the scope tears down all child effects and computeds:
scope.dispose();
```

### Detached Scopes
- `createDetachedScope()`: Creates a root-level scope uncoupled from any active parent scope.
- `runDetached(fn)`: Executes `fn` in a temporary detached scope, ensuring effects spawned inside do not attach to an outer component's lifecycle.
