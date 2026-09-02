# Storage and the registry

> "an abstract storage system that can be switched out for a remote provider vs local provider"
> "a global setting or registry would be nice. like on windows NT"

**Status.** Design. **Decided** is settled. **Proposed** is mine and needs a yes or no — most of this
document is Proposed, because two sentences of requirement imply a lot of structure and the
inferences should be visible rather than buried. **Open** is not answered.

Companion to [the model](./README.md).

---

## 1. Two things, not one — **Proposed**

The registry and the storage system are related but should not be the same interface.

| | **Registry** | **Storage** |
| --- | --- | --- |
| holds | settings | data |
| size | small values | anything, up to large |
| typed | yes, by schema, with defaults | by the owner, opaque to the framework |
| layered | yes — policy over user over device | no |
| who writes | often an administrator | the owning contributor |
| reactive | always — a changed setting updates the UI live | on request |
| example | `window-manager/mode`, `theme` | a draft post, a cached query, an offline queue |

Conflating them gets the worst of both: settings with no schema and no defaults, and data dragged
through layering and policy machinery it has no use for. NT keeps this split too — the registry is
settings; files are files.

Both sit on the **same provider abstraction** (§4). That is where "switched out for a remote
provider vs local provider" is actually answered, once for both.

---

## 2. Hives — **Proposed**

NT's real contribution is not the key/value store, it is the **hives**: the same setting means
different things at different scopes, and the scope is part of the address.

| hive | scope | follows | default provider |
| --- | --- | --- | --- |
| `system` | the deployment | everyone | remote, read-only to non-administrators |
| `user` | the person | across devices | remote |
| `device` | this browser | nothing | local |
| `session` | this tab | nothing | memory |

`device` earns its place: window geometry is arguably per-screen, not per-person. A layout that
follows you from a 32-inch monitor to a laptop and puts a window off-screen is the wrong behaviour,
and having the hive available means that is a choice rather than an accident.

### Resolution order — **Proposed**

Reading a setting walks: **`system` policy → `user` → `device` → schema default.** First hive with a
value wins.

The important one is `system` **policy**. A value written there as policy is not a default that a
user can override — it wins, and the setting is reported as locked with the reason. That is NT's
Group Policy, and it is exactly what [the model](./README.md) §6 needs:

> in a locked down mode the blog can never look like anything but the blog

**A locked blog is `system` policy on `window-manager/mode`.** No separate locking mechanism, no
special case in the window manager — the window manager reads a setting, and the setting happens to
be one nobody can change. The three levels proposed in the model doc (`locked` / `privileged` /
`open`) become "is there a policy value, and who may write to this path".

This also means a UI that shows a setting can show *why* it is greyed out, which is the thing every
settings screen gets wrong.

---

## 3. Addresses — **Proposed**

```
<hive>:/<namespace>/<path>
user:/mesh/window-manager/mode
device:/mesh/window-manager/geometry/blog.header
system:/mesh/window-manager/mode
user:/app/surfdns.console/active-organization
```

`mesh/` is the framework's own namespace. Everything else is namespaced by contributor id, and a
contributor may only write inside its own namespace unless it holds an administrative capability.
Namespacing by id rather than by convention is what makes "two extensions both wanted `theme`" not
a problem anyone has to think about.

---

## 4. Providers — the swappable part — **Proposed**

A provider is the backing store. Hives are **bound** to providers by configuration, so "local vs
remote" is a deployment decision, not a code change:

```
system  → RemoteProvider   (the API, read-only unless administrator)
user    → RemoteProvider   (the API, cached locally)
device  → LocalProvider    (IndexedDB, localStorage fallback)
session → MemoryProvider
```

Any binding is legal. A single-user local install can bind `user` to the local provider and never
talk to a server. A kiosk can bind `device` to remote so a replaced machine keeps its layout.

### The provider interface — **Proposed**

```ts
interface StorageProvider {
    readonly id: string;
    read(namespace: string, path: string): Promise<unknown | undefined>;
    write(namespace: string, path: string, value: unknown): Promise<void>;
    delete(namespace: string, path: string): Promise<void>;
    list(namespace: string, prefix: string): Promise<readonly string[]>;
    /** Change notification, where the provider can offer it. Remote does this over SSE. */
    watch?(namespace: string, prefix: string, onChange: (path: string) => void): DisposeFn;
}
```

Async throughout, including for the local provider. A synchronous local interface and an
asynchronous remote one are not swappable — every caller would have to know which it had, which
defeats the entire purpose.

### Reads are signals, not promises — **Proposed**

This is the piece that makes an async provider usable in a UI without every call site awaiting:

```ts
const mode = registry.get(WindowMode);      // ReadonlySignal<'tiled' | 'windowed'>
mode();                                     // the default, immediately
                                            // then the stored value when it arrives
```

The signal has a value straight away — the schema default, or a cached one — and updates when the
provider answers and again whenever the value changes underneath. Nothing in the UI awaits a
setting, and a remote registry does not make the first paint wait on the network.

`set` stays a promise, because a caller writing a value usually does want to know it landed.

---

## 5. The registry interface — **Proposed**

Settings are declared, not addressed by bare string, for the same reason provider tokens exist: the
declaration carries the type.

```ts
const WindowMode = setting({
    path: 'mesh/window-manager/mode',
    schema: z.enum(['tiled', 'windowed']),
    default: 'tiled',
    hive: 'user',              // where a write goes; reads still walk the whole order
    policy: true,              // may be locked by system policy
    description: 'How views are arranged.',
});

registry.get(WindowMode);              // ReadonlySignal<'tiled' | 'windowed'>
registry.set(WindowMode, 'windowed');  // Promise<void>; rejects if locked by policy
registry.locked(WindowMode);           // ReadonlySignal<PolicyLock | undefined>
```

A declared setting gets a schema, a default, a documented description and a known hive — which is
what lets a settings UI be *generated* rather than hand-written, and what lets a value that fails
its schema fall back to the default loudly instead of poisoning the app.

---

## 6. Storage interface — **Proposed**

For data rather than settings. Namespaced per contributor, bound to a hive, no layering.

```ts
const store = cx.storage.open('device');    // or 'user', 'session'
await store.set('draft/123', { title, body });
store.get<Draft>('draft/123');              // ReadonlySignal<Draft | undefined>
await store.list('draft/');
```

This replaces the current `ScopedStorage`, whose synchronous `get<T>(key, fallback): T` cannot be
backed by anything remote.

---

## 7. Caching and offline — **Open**

Named rather than solved, because it is the part that will actually be hard.

A remote provider needs a local cache or every read is a round trip. That brings the full set of
questions: does a write go through immediately or queue; what happens to a queued write when the tab
closes; how is a conflict resolved when the same setting changed on two devices; is the cache
authoritative while offline.

The signal-based read (§4) makes the *common* case fine — show cached, update on arrival. The hard
cases are writes and conflicts, and they should not be designed on the way past.

**Proposed for a first cut:** read-through cache, write-through with no queue, and a write that
fails while offline reports failure rather than pretending. Optimistic offline writes are a separate
feature and a large one.

---

## 8. What this settles elsewhere

- **[Model](./README.md) §4** — view state now has a home: `device:/mesh/window-manager/geometry/*`
  for position, size and z-order, `user:` for mode. Whether geometry is per-device or per-user
  becomes configuration rather than an argument.
- **[Model](./README.md) §6** — locked mode is `system` policy, not a separate mechanism.
- **`ScopedStorage`** in `src/contribution/capabilities.ts` is superseded by §6 and must change; its
  synchronous signature cannot survive a remote provider.
- **A `registry` capability** joins the capability map, and writing outside your own namespace, or
  to the `system` hive, needs an administrative one.

---

## 9. Open

- **Does the registry live in mesh-web or mesh-api?** The interface and the local provider are
  browser-side. The remote provider is an API, which means contracts, which means a server-side
  owner. The likely answer is that mesh-web owns the abstraction and the local provider, and the
  remote provider is a thin client over contracts that mesh-api exposes.
- **Who administers `system`?** It needs an authorisation model, and surfdns issue #26 — nobody can
  currently be a platform operator — is the same gap seen from another angle.
- **Schema migration.** A setting whose schema changes needs its stored value migrated or discarded.
  NT's answer was "nothing, good luck". Ours should be better, and a version plus a migrate function
  on the declaration is probably enough.
- **Does a headless Application get a registry?** Almost certainly yes — it has configuration like
  anything else — which is another argument that headless Applications are processes rather than a
  special case.
