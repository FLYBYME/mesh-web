# Dispatch 12 Report: Internal Context vs Published API

## 1. Executive Summary

Dispatch 12 resolves the architectural coupling between an Application's views and its published interface identified in `spec/components.md` §5.

### The Problem
Previously, an Application's `start()` returned a single value: `ApiOf<TProvides>`. This object served two completely different masters:
1. **The published interface**: what external parts receive from `cx.use(TOKEN)`.
2. **The view's state path**: what a view's `render(vx)` received via `vx.app`.

Because `vx.app` was a view's **only** route to its own state, every signal, draft field, and private helper a view needed had to be exposed on the public API. Measured across existing parts:
- `workbench`: **32** members published (including 8 raw mutable `Signal<T>` handles and 10 forwarding methods to `cx.chrome`)
- `kanban`: **28** members published
- `notes`: **24** members published
- `clock`: **23** members published

Temporary revision counters (`filterRevision`, `docRevision`) created to work around an A7.0 `Input` bug—a bug fixed in kernel 0.11—became frozen as permanent public API because views depended on them through `vx.app`.

### The Solution: Two Objects, Not One
The kernel (v0.14.0) decouples what an Application provides to other parts from what its own views read:
- **An internal context (`vx.internal`)**: this process instance's own state (raw writable signals, drafts, private actions), handed directly to this part's own views, scoped to the instance `pid`, and never published to the provider graph.
- **The published API (`vx.app` / `use(TOKEN)`)**: what another part receives from `use(TOKEN)`. Intentionally minimal, and exposing `ReadonlySignal<T>` where it exposes state.
- **`vx.app` keeps working**: views that legitimately invoke the public surface can still access `vx.app`. It is simply no longer the *only* route to state.

### Verification Status
- **Typecheck**: `npm run typecheck` clean (0 errors).
- **Unit Tests**: **371 / 371 tests passing** across 20 test files. All 19 existing test files pass without a single line modified.
- **New Tests (`test/internal-context.test.ts`)**: Proves a mounted part renders from internal state, that the published API does not expose it at runtime, that reactive updates to internal state re-render views, and that TypeScript's type system refuses external access via `@ts-expect-error`.
- **Additive Compatibility**: Read-only verification against the 15 live parts across `mesh-demos` (11 parts) and `mesh-core` (4 parts) compiles 100% clean with zero errors against the v0.14.0 distribution.
- **Kernel Version Bump**: Bumped to minor **`0.14.0`** in `package.json`.
- **Specs Updated**: `spec/components.md` §5 updated from problem statement to active specification; `spec/application.md` §6 updated with `ViewContext` description.

---

## 2. The Shape Chosen vs What Was Rejected

### The Chosen Shape

#### 1. `ViewContext<TParams, TApi, TInternal>`
```ts
export interface ViewContext<
    TParams = Record<string, never>,
    TApi = unknown,
    TInternal = never,
> {
    readonly params: TParams;
    readonly app: TApi;
    readonly internal: TInternal;
    setTitle(title: string): void;
    close(): void;
    onDispose(fn: () => void): void;
}
```
`TInternal` defaults to `never`. For existing parts that do not opt in, `vx.internal` is typed as `never` (attempting to access fields on `vx.internal` is rejected by TypeScript), while `vx.app` remains typed as `TApi`. When a part opts in, `vx.internal` is typed as `TInternal`.

#### 2. `ViewDecl<TParams, TApi, TInternal>`
```ts
export interface ViewDecl<
    TParams = Record<string, never>,
    TApi = unknown,
    TInternal = never,
> {
    readonly id: string;
    readonly title: string;
    readonly tile?: string;
    readonly instances?: 'one' | 'many';
    readonly closable?: boolean;
    readonly defaultSize?: { readonly width?: number; readonly height?: number };
    readonly minSize?: { readonly width?: number; readonly height?: number };
    render(vx: ViewContext<TParams, TApi, TInternal>): DescriptionNode;
}
```
Because `render` is declared using TypeScript method syntax (`render(vx: ...): DescriptionNode`), **method bivariance** applies. In `Declarations`:
```ts
readonly views?: readonly ViewDecl<never, never, never>[];
```
Because `never` is the bottom type, `ViewContext<never, never, never>` is assignable to any concrete `ViewContext<P, A, I>`. Under method bivariance, any concrete `ViewDecl<P, A, I>` is assignable to `ViewDecl<never, never, never>` with zero casts.

#### 3. `Application<TNeeds, TConsumes, TProvides, TApi, TInternal>`
```ts
export interface ApplicationInstance<TPublic = unknown, TInternal = unknown> {
    readonly api?: TPublic;
    readonly internal: TInternal;
}

export type ApplicationStartResult<TPublic = unknown, TInternal = never> = [TInternal] extends [never]
    ? TPublic
    : [TPublic] extends [void]
      ? { readonly internal: TInternal; readonly api?: void }
      : unknown extends TPublic
        ? { readonly internal: TInternal; readonly api?: unknown }
        : { readonly api: TPublic; readonly internal: TInternal };

export interface Application<
    TNeeds extends readonly CapabilityName[],
    TConsumes extends ProviderTokens = readonly [],
    TProvides extends ProviderToken<unknown> | undefined = undefined,
    TApi = Api<Record<string, never>>,
    TInternal = never,
> extends Declarations {
    readonly needs: TNeeds;
    readonly consumes?: TConsumes;
    readonly provides?: TProvides;
    readonly singleton?: boolean;
    start(cx: Context<TNeeds, TConsumes, TApi>): Promise<ApplicationStartResult<ApiOf<TProvides>, TInternal>>;
    stop?(): Promise<void>;
}
```

This conditional return type satisfies four distinct use cases:
1. **Unmigrated / legacy parts** (`TInternal = never`): `ApplicationStartResult` collapses to `TPublic` (`ApiOf<TProvides>`). Existing applications returning their API directly compile without modification.
2. **Parts with both public API and internal context**: When `TProvides` is a `ProviderToken<PublicApi>`, `TPublic` is `PublicApi`. `ApplicationStartResult` evaluates to `{ readonly api: PublicApi; readonly internal: TInternal }`. Both properties are required by TypeScript.
3. **Parts with internal context but no public API** (`TProvides = undefined`): `TPublic` is `void`. `ApplicationStartResult` evaluates to `{ readonly internal: TInternal; readonly api?: void }`. The `api` property is optional, allowing `return { internal }`.
4. **Erased dispatch in the Kernel**: In `Kernel.start()`, `isApplicationInstance(startResult)` tests for `'internal' in startResult && startResult.internal !== undefined` without any type casts (`as any` or `as never`). If present, `entry.api = startResult.api` and `entry.internal = startResult.internal`. If absent, `entry.api = startResult` and `entry.internal = undefined`. `entry.api` is registered into `#providers` for `cx.use()`; `entry.internal` remains instance-private and is forwarded to `mountView`.

---

### What Was Rejected

1. **Naming Conventions on a Single Return Object (`_private` / `$state` fields)**
   - *Rejected because*: Returning a single object means everything returned is physically attached to the object placed in `#providers`. Any outside caller holding the `ProviderToken` could reflect over or mutate those fields at runtime. Conventions do not produce isolation boundaries.
2. **Capability Redesign (e.g. `cx.internalState` capability)**
   - *Rejected because*: Capabilities (`cx.mesh`, `cx.state`, `cx.windows`) provide host and operating system services to a process. An Application's domain state (e.g. cart items, note draft text) is the Application's own concern, not a host capability. Furthermore, the dispatch instructions explicitly stated: *"Do not redesign the capability system."*
3. **Module-Local Variables / Singletons in `views/<view>.ts`**
   - *Rejected because*: Module closures break multi-instance execution (`spec/application.md` §3). If an Application supports multiple instances (two note editor windows, two document preview windows with different `pid`s), module-scoped state is shared across instances, causing cross-window data corruption. State must be scoped to the running process instance.
4. **`TInternal = unknown` as Default Type Argument**
   - *Rejected because*: If `TInternal` defaulted to `unknown`, `ViewDecl<never, never, unknown>` would require `ViewContext<never, never, unknown>`. Because `unknown` is the top type, it is not assignable to concrete types like `NotesInternal`. Under TypeScript method bivariance, assigning a concrete view to `Declarations.views` would fail typechecking. Using `never` (the bottom type) allows method bivariance to succeed cleanly.
5. **Naming the Property `vx.state` or `vx.context`**
   - *Rejected because*: `cx.state` is the `StateCapability` in `start(cx)` (`cx.state.signal()`). Calling the view property `vx.state` could create confusion about whether it was a capability to create signals (which views must never do) or application state. Naming it `vx.context` produces stuttering (`ViewContext.context`). `vx.internal` is concise, unambiguous, and pairs naturally with `vx.app`.

---

## 3. Enforcement of `ReadonlySignal` in Published APIs

### Can `ReadonlySignal` Be Enforced, or Only Encouraged?

Today in TypeScript, `Signal<T>` extends `ReadonlySignal<T>`:
```ts
export interface ReadonlySignal<T> {
    (): T;
    peek(): T;
}

export interface Signal<T> extends ReadonlySignal<T> {
    set(value: T): void;
    update(fn: (prev: T) => T): void;
}
```

Because `Signal<T>` is a subtype of `ReadonlySignal<T>`, any writable signal created with `cx.state.signal(val)` is automatically assignable to `ReadonlySignal<T>`.

### The Problem With "Encouraged"
If an API contract declares `readonly count: ReadonlySignal<number>`, TypeScript prevents a consumer from calling `api.count.set(1)`. However, if the author publishes the raw `Signal<T>` object directly, the `.set` method is still physically attached to the JavaScript function object at runtime. Any consumer in JavaScript, or TypeScript with a type assertion, can call `.set()`.

Even worse: if an API author declares `readonly count: Signal<number>` on their public interface, TypeScript permits it without objection. As measured in `mesh-demos`, `WorkbenchApi` published eight raw `Signal<T>` handles.

### What Would Enforce It?

To turn this from an "encouraged convention" into an architectural guarantee, the platform can enforce it at three levels:

#### 1. Compile-Time Interface Constraint (`ProviderToken` Validation)
We can constrain the `TApi` type parameter of `ProviderToken<TApi>` so that any interface containing a writable signal is rejected at compile time:

```ts
type HasWritableSignal<T> = {
    [K in keyof T]: T[K] extends { set(value: any): void } ? K : never;
}[keyof T];

type AssertNoWritableSignals<T> = HasWritableSignal<T> extends never
    ? T
    : { ERROR: 'Published API must expose ReadonlySignal, never Signal'; offendingKeys: HasWritableSignal<T> };

export function provider<T extends AssertNoWritableSignals<T>>(id: string): ProviderToken<T>;
```

If an interface declares `readonly count: Signal<number>`, `provider<BadApi>('bad')` will produce a compile error pointing directly at `count`.

*Why not applied globally today?*
Applying this hard constraint immediately would break `mesh-demos` (`workbench`, `notes`, `kanban`, `clock`), which are live on six sites. Once those parts adopt internal context, this type constraint can be enabled project-wide.

#### 2. Runtime Defensive Stripping in Kernel `#providers`
When `Kernel.start()` registers `entry.api` into `#providers`:
```ts
if (contribution.provides !== undefined && entry.api !== undefined) {
    this.#providers.set(contribution.provides.id, securePublishedApi(entry.api));
}
```
Where `securePublishedApi(api)` inspects enumerable function properties:
- If a property `fn` is a Signal (`typeof fn === 'function' && 'set' in fn && 'peek' in fn`), the kernel wraps it in a readonly facade:
  ```ts
  const readonlyView = Object.assign(() => fn(), { peek: () => fn.peek() });
  ```
- Any attempts by outside consumers to invoke `.set()` or `.update()` fail with `TypeError: undefined is not a function`, because those methods do not exist on the object returned by `cx.use()`.

#### 3. Summary: The Path from Encouraged to Enforced
1. **Now (v0.14.0)**: The kernel provides `TInternal` and `vx.internal`. The views no longer force the published API to expose raw signals.
2. **Migration phase**: Rewrite demo parts (`notes`, `workbench`) to keep raw signals in `internal` and expose only `ReadonlySignal` on `api`.
3. **Enforcement phase**: Turn on runtime signal stripping in `Kernel.boot` / `Kernel.start` and add `AssertNoWritableSignals` to `ProviderToken`.

---

## 4. Adoption for a Real Part: `notes`

`notes` currently publishes **24 members** in `mesh-demos/src/notes/contract.ts`:

### Before (Current Live Shape — 24 Members)
```ts
export interface NotesApi {
    // 7 raw writable signals
    readonly notes: Signal<readonly Note[]>;
    readonly filterText: Signal<string>;
    readonly filterRevision: Signal<number>; // workaround for 0.11 bug
    readonly selectedId: Signal<string | null>;
    readonly selectedNote: () => Note | null;
    readonly draftTitle: Signal<string>;
    readonly draftBody: Signal<string>;
    readonly draftRevision: Signal<number>; // workaround for 0.11 bug

    // 4 computed getters
    readonly filteredNotes: () => readonly Note[];
    readonly totalCount: () => number;
    readonly filteredCount: () => number;
    readonly totalWords: () => number;

    // 13 mutation methods
    createNote(title: string, body: string): void;
    updateNote(id: string, title: string, body: string): void;
    deleteNote(id: string): void;
    selectNote(id: string | null): void;
    setFilter(textVal: string): void;
    clearFilter(): void;
    setDraftTitle(titleVal: string): void;
    setDraftBody(bodyVal: string): void;
    save(): void;
    newNote(): void;
    clearAll(): void;
    addSample(): void;
}
```

### After (With Internal Context — 5 Members Published)

#### 1. The Published API (`NotesApi` — 5 Members)
What other parts (e.g. an omni-search palette, a global shortcut provider, or an AI assistant) actually want from a Notes part:
```ts
export interface NotesApi {
    /** Read-only collection of saved notes. */
    readonly notes: ReadonlySignal<readonly Note[]>;
    /** Read-only total note count. */
    readonly totalCount: ReadonlySignal<number>;

    /** Create a new note from outside. Returns the new note id. */
    createNote(title: string, body: string): string;
    /** Retrieve a note by id. */
    getNote(id: string): Note | undefined;
    /** Delete a note by id. */
    deleteNote(id: string): boolean;
}
```
**Published member count drops from 24 to 5 (an 79% reduction).**
- Raw `Signal<T>` handles are replaced with `ReadonlySignal<T>`.
- Workaround revision counters (`filterRevision`, `docRevision`) are completely deleted.
- Window and editor specific draft/filter states are removed from the public API.

#### 2. The Internal Context (`NotesInternal`)
Handed to `views/notes.ts`, `views/editor.ts`, and `views/stats.ts` via `vx.internal`:
```ts
export interface NotesInternal {
    // Writable signals for view bindings
    readonly notes: Signal<readonly Note[]>;
    readonly filterText: Signal<string>;
    readonly selectedId: Signal<string | null>;
    readonly selectedNote: () => Note | null;
    readonly draftTitle: Signal<string>;
    readonly draftBody: Signal<string>;

    // Computeds for view display
    readonly filteredNotes: () => readonly Note[];
    readonly filteredCount: () => number;
    readonly totalWords: () => number;

    // View-driven user interactions
    selectNote(id: string | null): void;
    setFilter(text: string): void;
    clearFilter(): void;
    setDraftTitle(title: string): void;
    setDraftBody(body: string): void;
    save(): void;
    newNote(): void;
    clearAll(): void;
    addSample(): void;
}
```

#### 3. In `NotesApp`:
```ts
export default class NotesApp implements Application<
    typeof NEEDS,
    readonly [],
    typeof NOTES,
    Api<Record<string, never>>,
    NotesInternal
> {
    readonly needs = NEEDS;
    readonly provides = NOTES;
    readonly views = [
        {
            id: 'notes',
            title: 'Notes List',
            render(vx: ViewContext<Record<string, never>, NotesApi, NotesInternal>) {
                return renderNotesListView(vx);
            },
        },
        // ...
    ];

    async start(cx: Context<typeof NEEDS, readonly []>): Promise<{
        readonly api: NotesApi;
        readonly internal: NotesInternal;
    }> {
        // Build internal signals and methods...
        const internal: NotesInternal = { ... };

        // Build thin published facade...
        const api: NotesApi = {
            notes: internal.notes,
            totalCount: cx.state.computed(() => internal.notes().length),
            createNote(title, body) { /* ... */ },
            getNote(id) { /* ... */ },
            deleteNote(id) { /* ... */ },
        };

        return { api, internal };
    }
}
```

---

## 5. Reader Audit Findings

1. **`exactOptionalPropertyTypes: true` on `Declarations.provides`**:
   In `src/contribution/contract.ts`, `Declarations` had:
   ```ts
   readonly provides?: ProviderToken<unknown>;
   ```
   When `Application` extends `Declarations` with `TProvides extends ProviderToken<unknown> | undefined = undefined`, consumers configured with `exactOptionalPropertyTypes: true` (such as `mesh-demos`) flagged an error when `TProvides` was `undefined`: `undefined` was not assignable to `ProviderToken<unknown>`. Explicitly defining `readonly provides?: ProviderToken<unknown> | undefined;` resolved this type violation across all consumers.

2. **Method Bivariance vs Bottom Type `never` in Erased Arrays**:
   In `Declarations.views`, method bivariance is required to allow concrete view arrays (`ViewDecl<Record<string, never>, NotesApi, NotesInternal>[]`) to be assigned to the manifest declaration. The type parameter for `render` must be `never`, not `unknown`, because function parameter bivariance checks if `TargetParam` is assignable to `SourceParam`. Because `never` is the bottom type, `ViewContext<never, never, never>` is assignable to every concrete `ViewContext<P, A, I>`. If `TInternal` had defaulted to `unknown`, assigning concrete views to `Declarations` would have failed.

3. **Vitest JSDOM Test Environment Requirement**:
   Unit tests executing `start({ ... })` mount DOM elements via `doc.createElement('div')`. Vitest runs in Node.js by default unless marked with `/** @vitest-environment jsdom */` at the top of the test file.

4. **Elimination of Zombie Workaround Signals**:
   Examining `WorkbenchApi` and `NotesApi` revealed `filterRevision` and `docRevision` published as public API members. These signals were workarounds for an input synchronization defect fixed in kernel 0.11. Decoupling internal context from public APIs ensures that temporary internal workarounds never pollute published platform contracts.
