# Storage Capability (A3.9) Implementation Report

## 1. The Isolation Mechanism and Boundary Verification

The `storage` capability replaces ad-hoc access to underlying storage providers with a strictly brokered, namespaced capability.

### How Isolation Works
1. **Broker-Enforced Namespace**:
   When a contributor declares `needs('storage')`, the capability broker constructs `cx.storage` using `makeStorage(declaredBy, id, services, cleanups)`. The `namespace` parameter is bound to `declaredBy` (the contributor ID, e.g. `theme` or `blog`). The contributor never provides, configures, or modifies this namespace prefix.
2. **Provider Key Prefixing**:
   Every entry key in the underlying `StorageProvider` is prefixed as:
   ```
   ${namespace}/${store.name}/${key}
   ```
   The contributor is completely isolated within this sub-tree of the hive provider.
3. **Strict Validation and Namespace Partitioning**:
   - Store names are validated at creation: must match `^[a-zA-Z0-9_-]+$`. Any attempt to include slashes (`/`), backslashes (`\`), directory traversals (`..`), null bytes, or whitespace throws an `Error`.
   - Record keys are validated at every operation (`get`, `set`, `remove`, `ready`, `stat`) via `validateKey`: must be non-empty strings and cannot contain the provider's `KEY_SEPARATOR` (`\0`).
   - At the provider boundary, `keyOf(namespace, path)` isolates partitions via `${namespace}\0${path}`. Because the namespace is injected by the broker from `declaredBy` and keys cannot inject null bytes, a part's keyspace is strictly quarantined to `${contributor}\0${store.name}/${key}`. Path manipulation like `../other` in a key remains trapped inside the contributor's namespace prefix and can never resolve across to another contributor's data.
   - Keys returned by `list()` strictly filter against `${decl.name}/` and strip the prefix before returning, so one store cannot discover another store's keys.
4. **Hive Access Control**:
   Each hive binding specifies whether it is `writable`. Writes (`set`, `remove`) to read-only hives (such as `system`) reject immediately with an `Error`.

### Verification
In `test/storage.test.ts`:
- Two contributors declaring stores with the same name (`drafts`) are proven isolated: contributor B cannot observe or overwrite contributor A's data.
- Attempts to escape via traversal patterns (`../part-a/drafts/secret`) in keys remain quarantined inside contributor B's namespace and cannot affect contributor A.
- Invalid store names with slashes, paths, traversals, or null characters are rejected at declaration time.

---

## 2. What "Falls Back Loudly" Turned Out to Mean

Under `spec/storage-and-registry.md` §6, reads that encounter malformed or schema-incompatible data must not be cast (preventing version-skew bugs where stale or incompatible shapes crash call sites).

### Implementation
- When reading an existing entry, raw provider data is validated using `schema.safeParse(raw)`.
- If parsing succeeds, the validated value is published to the signal.
- If parsing fails (`result.success === false`):
  1. A warning is logged to the kernel log service:
     `{ level: 'warn', source: id, message: \`Storage value failed schema validation for key "${key}" in store "${store.name}"\`, data: result.error }`
  2. The store returns its configured `fallback` value (which defaults to `undefined`).
  3. The signal publishes this fallback value.

### Rationale
- **Why not throw synchronously on read?** Throwing inside a signal getter or reactive subscriber breaks the reactive computation tree and can crash unaffected UI elements.
- **Why not silently return `undefined`?** Silently swallowing corrupt data hides version-skew and schema-drift bugs, misleading developers and operators into thinking a record does not exist.
- **Loud Fallback**: Logging a structured warning with the exact key, store, and schema parsing error while safely returning the fallback value allows the application to proceed without crashing while alerting operators and developers.
- On writes (`set`), schemas are validated upfront: invalid payloads throw synchronously before anything reaches the hive.

---

## 3. What in §6 Did Not Survive Contact

### Awaiting `list()` and Thenable Signals
In §6 line 347, the example usage is:
```ts
await drafts.list(); // ReadonlySignal<readonly EntryStat[]>
```
In JavaScript and Promise/A+ semantics, if an object returned from a promise resolution implements `.then` (i.e. is a thenable), the promise machinery attempts to recursively unwrap it by calling `.then(resolve, reject)`. If a signal is augmented with a naive `.then` that resolves with itself, this triggers infinite recursion and fatal out-of-memory crashes.

However, in TypeScript and ECMAScript:
- `await x` on a non-thenable object evaluates directly to `x`.
- `drafts.list(): ReadonlySignal<readonly EntryStat[]>` populates asynchronously and emits fine-grained reactive updates upon completion.
- When an application author writes `const entries = await drafts.list();`, it evaluates cleanly to `ReadonlySignal<readonly EntryStat[]>`, completely avoiding thenable traps.

---

## 4. Manifest Integration: Straightforward vs Awkward

Adding `StoreDecl` to `Declarations` and `Manifest` was clean:
- Added `stores?: readonly StoreDecl[]` to `Declarations` in `src/contribution/contract.ts`.
- Merged and validated in `src/kernel/manifest.ts`, detecting collision errors if a contributor declares duplicate store names.
- Manifest entries can be statically audited by CLI, packaging tools, and descriptors without executing code.

**Awkwardness**:
- Currently, the kernel manifest merge is only actively consulted at runtime for commands (`contract.ts:implement`).
- `cx.storage.open(store)` takes the direct `Store<T>` reference created with `store(...)`. Checking whether that store was declared in the manifest at runtime would require passing manifest state down through `createContext` into `createStorage`.
- For now, manifest declaration serves static auditing and permission analysis, fulfilling the §6 requirement that persisted stores are visible in declarations.

---

## 5. Reader Audit Findings (Written and Never Read)

During the implementation across `broker.ts`, `manifest.ts`, `providers.ts`, and `registry.ts`, the following mechanisms were found to be written but never read:

1. **`ContextIdentity.id` vs `ContextIdentity.declaredBy` documentation**:
   `broker.ts:261` states:
   > *"capabilities are scoped per instance — two blog windows must not share a storage namespace or a log source"*
   
   In reality, scoping storage per instance (`id`, such as `p1`, `p2`) would make reload persistence impossible, because a reload allocates fresh process IDs. Persistence requires scoping storage to `declaredBy` (the contributor ID), while scoping runtime log messages to `id`.
2. **Unread Manifest Categories**:
   `manifest.bindings`, `manifest.menus`, `manifest.apis`, `manifest.layouts`, `manifest.settings`, `manifest.stores`, and `manifest.views` are merged into the `Manifest` object, but no kernel system currently reads them at runtime except `manifest.commands`.
3. **Uncalled Provider Methods**:
   `provider.metrics()`, `provider.usage()`, and `provider.batch()` are defined on `StorageProvider` and implemented in `memoryProvider` and `localProvider`, but no callers in the kernel or capabilities ever invoke them.
4. **`SettingDecl.description` / `StoreDecl.description`**:
   Accepted in declarations and stored on the declaration objects, but never surfaced or inspected.

---

## 6. Migration Note for `mesh-demos`

The `theme` Extension in `mesh-demos` currently imports `localProvider` directly from `@flybyme/mesh-web/registry/providers.js` and writes un-namespaced keys.

With `@flybyme/mesh-web@0.8.0`, `theme` should be migrated to:
1. Declare `needs('storage')`.
2. Declare `stores: [{ name: 'theme', hive: 'device', description: 'Active theme preference' }]` in its manifest.
3. Define the store using `store({ name: 'theme', hive: 'device', schema: z.enum(['light', 'dark']), fallback: 'light' })`.
4. Open via `const themeStore = cx.storage.open(ThemeStore)` and persist via `await themeStore.set('active', mode)`.
5. Remove the direct import of `localProvider`.
