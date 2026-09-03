# Storage and the registry

> "an abstract storage system that can be switched out for a remote provider vs local provider"
> "a global setting or registry would be nice. like on windows NT"

**Status.** Design. **Decided** is settled. **Proposed** is mine and needs a yes or no — most of this
document is Proposed, because two sentences of requirement imply a lot of structure and the
inferences should be visible rather than buried. **Open** is not answered.

Companions: [the model](./README.md) · [hosting](./hosting.md) · [authentication](./auth.md) ·
[service modules](./service-modules.md).

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

### Where `system` policy comes from — **Proposed**

> "in theory the use who loaded the page in their browser. this might be where a smart build process
> and strip down the page and lock it. I'm not really sure."

The first instinct is right and the second sentence is the answer it leads to.

In a browser there is **no machine administrator distinct from the person at the keyboard**. The
browser is the machine and its owner is whoever opened the tab. So a `system` hive administered
*from the browser* is incoherent — anyone with devtools is its administrator. That is not a hole to
plug; it is a fact about the medium, and the design has to route around it rather than pretend.

So policy has two legitimate origins, neither of them the running page:

**1. The build.** Values frozen into the bundle. No provider, no write path, not changeable at
runtime — a constant, not a setting. This is how a blog gets locked, and it is the same pass that
strips the floating-window code the model doc already permits removing. A feature that is absent is
a stronger guarantee than a feature that is disabled, and it is smaller.

**2. The server.** A remote provider, administered through the API, carrying the API's own
authorization. This is how a console or a multi-tenant deployment does it, where policy has to
change without a redeploy.

They compose, build first, because a build constant is not something a later layer can outvote:

**build policy → `system` (remote) policy → `user` → `device` → schema default**

### Locking the UI is not access control — **Decided by implication, stated here because it must be**

Build-time policy and a stripped bundle are **product decisions, not security boundaries**. A person
with devtools can do anything they like to a page running on their own machine, including restoring
a mode the build removed. Nothing in this section changes that and nothing should be built as though
it does.

What actually protects anything is the API refusing the request, server-side, every time. This is
the existing rule — the API is the only way into the cluster — and the registry does not get an
exception. A locked blog is locked because it is not worth shipping the code, not because the lock
would survive an attacker. Any setting whose value must be trusted is enforced at the API, and the
page's copy is a hint.

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
    readonly capabilities: ProviderCapabilities;

    read(namespace: string, path: string): Promise<StoredValue | undefined>;
    write(namespace: string, path: string, value: unknown, expect?: string): Promise<StoredValue>;
    delete(namespace: string, path: string): Promise<void>;

    stat(namespace: string, path: string): Promise<EntryStat | undefined>;
    list(namespace: string, prefix: string): Promise<readonly EntryStat[]>;

    /** Atomic multi-key write, where the provider can offer it. See `capabilities.atomicBatch`. */
    batch?(namespace: string, writes: readonly BatchWrite[]): Promise<void>;

    /** Change notification, where the provider can offer it. Remote does this over SSE. */
    watch?(namespace: string, prefix: string, onChange: (path: string) => void): DisposeFn;

    usage(namespace?: string): Promise<Usage>;
    metrics(): ProviderMetrics;
}
```

Async throughout, including for the local provider. A synchronous local interface and an
asynchronous remote one are not swappable — every caller would have to know which it had, which
defeats the entire purpose.

### `unknown` stops here — **Decided**

`write(..., value: unknown)` and `StoredValue.value: unknown` are **correct at this layer and wrong
one layer up**, and the boundary has to be stated or it will leak.

A provider stores opaque values. It does not know what a draft is, it must not parse one, and a
provider that type-checked its contents could not be swapped for one that stores bytes in IndexedDB.
`unknown` here is honest: it says *this layer does not know*.

> **The provider interface is the only place in the storage system where a value is `unknown`.
> Nothing above it accepts or returns one.**

The typed layer sits directly on top and gets its types from declarations — §5 for settings, §6 for
data — so no caller ever holds an `unknown` and no caller supplies a type parameter the framework
cannot check ([type-safety §2](./type-safety.md)).

Concretely, one place does the conversion: reads parse against the declared schema, and a value that
fails **falls back to the default loudly** rather than being cast into the caller's hopes. That is
also the only defence against a stored value written by an older version of the same Application,
which is a case that will happen and cannot be prevented.

### Per-entry metadata — **Proposed**

```ts
interface EntryStat {
    readonly path: string;
    readonly size: number;          // serialized bytes
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly version: string;       // etag; see below
    readonly provider: string;      // which provider answered — hives can be re-bound
}

interface StoredValue {
    readonly value: unknown;
    readonly stat: EntryStat;
}
```

`version` is the piece that earns its keep beyond diagnostics. A write may pass `expect: version`
and be rejected if the entry changed underneath — which is how the conflict question in §7 gets an
answer rather than a shrug. Without it, last-write-wins is not a decision anyone made, it is just
what happens.

`list` returning stats rather than bare paths means a UI can show sizes and dates without N round
trips, which is the difference between a storage inspector being possible and being a stub.

### Usage and quota — **Proposed**

```ts
interface Usage {
    readonly bytes: number;
    readonly entries: number;
    readonly quota?: number;        // undefined when the provider cannot say
    readonly pressure?: 'ok' | 'nearing' | 'exceeded';
}
```

Not optional in practice. `localStorage` dies at roughly 5MB, IndexedDB has a soft eviction policy
the browser decides, and a remote provider has whatever the deployment set. A provider that cannot
report usage is one where an application discovers the limit by failing a write, in front of a
person, having already destroyed their draft.

`quota` is optional because some providers genuinely do not know. `pressure` is the useful signal
either way, and a provider that cannot compute a ratio can still report `exceeded` after the fact.

### What a provider can actually do — **Proposed**

Providers differ, and a caller that needs live updates should be able to ask rather than discover:

```ts
interface ProviderCapabilities {
    readonly watch: boolean;
    readonly atomicBatch: boolean;
    readonly conditionalWrite: boolean;   // whether `expect` is honoured
    readonly maxValueBytes?: number;
    readonly durability: 'session' | 'device' | 'replicated';
}
```

`durability` is the honest one. Memory loses everything on reload; device storage survives reload
and dies with the machine; replicated survives the machine. An Application storing something that
matters should be able to find out which it has, and refuse rather than silently keep a draft
somewhere it will evaporate.

### Operational metrics — **Proposed**

```ts
interface ProviderMetrics {
    readonly reads: number;
    readonly writes: number;
    readonly errors: number;
    readonly cacheHits: number;
    readonly cacheMisses: number;
    readonly p50LatencyMs: number;
    readonly p99LatencyMs: number;
}
```

Cheap to keep, and the thing that makes a remote provider debuggable. "The console feels slow" is
unactionable; "the user hive is at 400ms p99 with a 12% cache hit rate" is a bug report. This is
also what a built-in process manager would display, which is one of the reasons that process was
named as built-in in the first place.

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

An earlier draft of this section had `store.get<Draft>('draft/123')`, which is exactly the pattern
[type-safety §2](./type-safety.md) bans: the caller supplies a type nothing verifies, and the
compiler then vouches for whatever happens to be on disk — including something written by a previous
version of the same Application.

So **a store is declared, like a setting**, and for the same reason: the declaration carries the
type.

```ts
const Drafts = store({
    name: 'drafts',
    hive: 'device',
    schema: z.object({ title: z.string(), body: z.string(), savedAt: z.number() }),
});

const drafts = cx.storage.open(Drafts);

await drafts.set('123', { title, body, savedAt: Date.now() });   // checked against the schema
drafts.get('123');            // ReadonlySignal<Draft | undefined> — no type parameter
await drafts.list();          // ReadonlySignal<readonly EntryStat[]>
await drafts.remove('123');
```

Four things follow, and the third is the one that matters most in practice:

- **No type parameter anywhere.** `Draft` comes from the declaration.
- **Writes are validated**, so a bug cannot persist a malformed record that breaks the next read.
- **Reads that fail the schema fall back loudly** rather than being cast. This is the version-skew
  case: a user who ran last month's build has last month's shape on disk, and no amount of care at
  the call site would have caught it.
- **The store appears in the manifest**, so what an Application persists — and in which hive — is
  visible without reading its code.

This replaces the earlier `ScopedStorage`, whose synchronous `get<T>(key, fallback): T` was wrong
twice over: synchronous, so nothing remote could back it
([roadmap A1.3](./roadmap.md)), and caller-typed.

**Migration is still open** (§9). A declared schema makes the problem *visible* — the read that
fails is the moment you learn the shape changed — but it does not migrate anything.

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

### Conflicts reject. One way, no per-setting choice. — **Decided**

> "yes reject. we do this one way."

`EntryStat.version` plus a conditional write (§4) detects the conflict; the second writer is told the
entry moved rather than silently winning. **And that is the only behaviour.** There is no `conflict`
field on a setting declaration, no last-write-wins option, and no per-setting choice — which was the
earlier proposal and is now withdrawn.

**The case that argued against this dissolves on inspection.** The reason for wanting last-write-wins
was window geometry: two devices both move a window, and rejecting means the window snaps back, which
would be maddening.

But **geometry belongs in the `device` hive**, and the device hive is not shared. There is no
cross-device conflict to resolve because there is no cross-device value.

And that is right for its own reasons, not just for this one. A Steam Deck and a desktop have
different screens; syncing window positions between them would be actively wrong, not merely
unnecessary. **View state is device-scoped**, and any part of the design that assumed geometry lived
in `user` was wrong ([README §4](./README.md), [roadmap A2.5](./roadmap.md)).

So the settings that *are* shared — the ones in `user` — are exactly the ones where a silent
overwrite would lose someone's intent. Rejecting is correct for all of them, which is why one rule
covers the whole surface.

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
- **Who administers a *remote* `system` hive?** — answered in principle:

  > "I think this is who ever has control of the cdn/builder/API they all work together"

  Administrative authority over a site is **control of its deployment**, not a role inside the
  running application. That is a different axis from the org-scoped `admin` role, and it means the
  remote `system` hive is administered by whoever can rebuild and redeploy the site — which is the
  same authority that could have frozen the value at build time anyway. Consistent, and it means
  the two origins of policy in §2 are one authority reached two ways.

  What remains open is how a CDN node *verifies* it. See [hosting](./hosting.md) §7. For a locked
  site it does not arise, because policy is a build constant.
- **Schema migration.** A setting whose schema changes needs its stored value migrated or discarded.
  NT's answer was "nothing, good luck". Ours should be better, and a version plus a migrate function
  on the declaration is probably enough.
- **Does a headless Application get a registry?** Almost certainly yes — it has configuration like
  anything else — which is another argument that headless Applications are processes rather than a
  special case.
