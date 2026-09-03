# Where everything stands

Written 2026-09-02. This is the handoff: what exists, what was decided, what is still open, and what
the next person (or the next session) should pick up.

This one is the index and the state of play.

| document | covers |
| --- | --- |
| [README](./README.md) | The model: processes, views, windows, view state |
| **[kernel](./kernel.md)** | **What boots, what hands out capabilities, the process table** |
| **[extension](./extension.md)** | **The Extension contract, providers, activation, lifecycle** |
| **[application](./application.md)** | **The Application contract, the manifest, instances, routing** |
| **[view-layer](./view-layer.md)** | **Descriptions not DOM, components, events, tiles** |
| **[input](./input.md)** | **Intents, the focus graph, modality, bindings, window mechanics** |
| **[network](./network.md)** | **Typed calls, events and collections — the link to the mesh** |
| **[testing](./testing.md)** | **What is pure, what needs fakes, what needs a browser** |
| **[type-safety](./type-safety.md)** | **The standard the rest complies with. Read before writing an interface.** |
| [storage-and-registry](./storage-and-registry.md) | Providers, hives, settings, policy |
| [hosting](./hosting.md) | The builder, the CDN, hostnames, multi-tenancy, the proxy |
| [auth](./auth.md) | Tickets, validation, passkeys, roles, organizations |
| [service-modules](./service-modules.md) | How the three server halves are structured |
| **[roadmap](./roadmap.md)** | **The checklist — UI, CDN and API, ordered, with milestones** |

[README](./README.md) is the model in one piece and the place to start. The three documents under it
are the contracts in detail: **kernel** is the part that cannot be replaced by what it loads,
**extension** and **application** are the two things it loads.

This document is the state. [`roadmap.md`](./roadmap.md) is the work: every item to get the UI
framework, the CDN and the API where they are meant to be, marked with what blocks it.

---

## 1. The repositories

| repo | branch | state |
| --- | --- | --- |
| **mesh** | master `1cb54e5` | Clean. v2.1.0 tagged. Nothing open. **Untouched by the reset.** |
| **mesh-api** | master | **Emptied.** Every file deleted. |
| **mesh-web** | master | **Emptied except `spec/` and `demo/`.** The spec is the repository. |
| **surfdns** | master `cece581` | Clean and green, but **requires complete rework**. |
| **surfdns-console** | master `772cdef` | Staged files only. Does not build. Superseded by the reset. |

Both new repositories are private on GitHub:
- https://github.com/FLYBYME/mesh-web
- https://github.com/FLYBYME/surfdns-console

### The reset — 2026-09-02

mesh-web's runtime and contribution layer (120 files, ~20k lines) and the whole of mesh-api
(168 files, ~28.5k lines) were deleted. **Nothing was ported.** What remains of two repositories is
this `spec/` directory.

This is not a loss of information — every deleted line is in git history on both remotes, and the
branches are untouched. It is a decision about what to build *from*. The runtime carried the previous
generation's model in its bones: `defineApp` and a module-level registry, `LayoutConfig.regions`
alongside a window manager that would have replaced it, `Application.surfaces` required on a contract
that had already been retracted, a synchronous `ScopedStorage` that no remote provider could back.
Porting it forward meant carrying those decisions into the rewrite and then arguing them back out
one at a time.

So the specs lead and the code follows them, which is the order [hosting](./hosting.md) §1 already
stated for mesh-api and is now simply true of both.

**Consequence, accepted:** surfdns requires complete rework. Five of its packages depend on
`github:FLYBYME/mesh-api`, which resolves to that repository's default branch — so surfdns's install
breaks the moment mesh-api's empty master is pushed. Its console imports
`@flybyme/mesh-api/runtime`, which no longer exists. Neither is a regression to fix; both are the
rework.

The abandoned mesh-api branches (`spec/13-applications-and-extensions`, holding closed PR #6, and
`tony/33-slotted-surfaces`, holding open PR #5) are moot. Nothing on either is worth carrying
forward except mesh-api issue #7, the task switcher hotkey bug, which is recorded in
[roadmap](./roadmap.md) A1.4 as a thing not to reintroduce.

---

## 2. What is code, and what is only design

**Code: the floor, as of 2026-09-03.** `npm run build`, `npm run typecheck` and `npm test` all pass.

| | |
| --- | --- |
| `src/reactivity/` | signals, computeds, effects, resources, scopes, batching. **Recovered from history** (`git show 4cd801d^`), not rewritten — it had no design defect against it. 990 lines. |
| `src/description/` | **new.** The node tree an Application produces: elements, text, `when`, `each`, intents, actions, the handler table. Plain data throughout. |
| `src/description/flatten.ts` | the test renderer — resolves every reactive value and expands control flow into a static tree. Also the server-rendering path. |
| `src/render/` | **the DOM renderer.** Components to elements, fine-grained binding, `when` on comment markers, keyed `each`, device events to intents, scoped disposal. |
| `src/contribution/` | the two contracts — `Extension`, `Application`, capabilities, provider tokens, `needs()`, `consumes()`, and `construct()`, which checks a bundle before trusting it. |
| `src/kernel/` | **the kernel.** The capability broker, the provider graph, manifest merge with load-time conflict detection, the process table, lifecycle and fault containment. |
| `src/window/` | **the window manager.** Pure geometry, z-order, move/resize/maximise/restore, the view host that renders a declared view, and the sink joining `windows` to it. |
| package, tsconfig, vitest, CI | `types: []` on the browser build, so a node import will not compile. |

**The path is joined end to end.** `test/endtoend.test.ts` boots a site, reads its manifest before
anything starts, starts an Application, has it refuse a command while signed out, signs in, opens a
window through a declared capability, renders the view's description into the DOM, clicks a row to
run a command through the kernel, mutates application state and watches one row update in place,
drags the window without re-rendering anything, and stops the process to see its windows and handlers
disposed.

Boot steps **3–7 and 10** of [kernel §3](./kernel.md) are real. Steps 1, 2, 8, 9 and 11 need the
deployment descriptor, the registry, auth, view state and the router — none of which exist.

**123 tests.** 95 need no DOM at all — the property the description layer and the kernel both exist
to give ([testing §2](./testing.md)) — and 28 run under jsdom.

### Two bugs the end-to-end test found that 95 unit tests could not

Worth recording, because they are the argument for writing it.

Both live in one blind spot: **a list row whose key survives while its contents change.** The unit
tests added, removed and reordered rows — cases where a row is created fresh or destroyed — and used
static text inside them. A row that is *kept* while its data changes was never exercised.

1. **`each`'s `render` received the item by value**, so a reused row closed over the object it was
   built with. Editing a post in place left the old text on screen. `render` now receives an
   accessor.
2. **Rows and `when` branches were built inside the reconciling effect.** An effect disposes the
   effects it created before it re-runs, so every row went dead after the first list change — nodes
   still on screen, updates silently stopped. It looks like a reactivity bug and is an ownership bug.
   Content is now built under the surrounding render's scope.

The regression test for both is in `test/render.test.ts`, with a note saying why the neighbouring
tests could not have caught it.

**What the renderer's tests actually assert**, since "it renders" is not the claim:

- an update changes **one text node**, and the element and text node are the *same objects*
  afterwards. No VDOM, no diffing, nothing recreated ([view-layer §4](./view-layer.md)).
- a reorder of a keyed list **moves the same `<li>` elements**, checked by identity.
- a removed `when` branch has its effects **disposed** — writing to a signal it read does not call
  back into it.
- a click and `Enter` both arrive as `activate`, and the Application sees an intent rather than a
  device event ([input §2](./input.md)).
- a handler action reaches the renderer as an **id**; the renderer never calls the function.

**The limit, and what now covers it:** jsdom is not a browser. [testing §4](./testing.md) is right
that layout, focus, real input devices and anything measured need one. The renderer's jsdom tests
cover reconciliation, binding, disposal and intent mapping — logic that happens to touch a DOM — and
a second vitest project (`npm run test:browser`) covers what jsdom cannot, rather than repeating
them. Eight tests in real Chromium: declared sizes in actual pixels, rows that stack, a drag that
keeps receiving moves after the pointer leaves its handle, `minSize` enforced by real layout, a
trusted click becoming a command, and `Enter` reaching a row with no pointer involved.

**Still no code:** the window manager, real input, the registry and hives, the network client, the
component vocabulary as designed, `net`/`events`/`keys`/`menus`/`models`/`storage` as capabilities,
and all four server modules.

Two guards in `test/boundaries.test.ts`, and both were **verified to fail when violated** rather than
assumed: nothing in `src/` imports node, and nothing in `src/description/` names a DOM type. Adding a
file with `HTMLElement` in it turns the second red.

**Design: everything else.** The documents beside this one, and the checklist in
[roadmap](./roadmap.md).

**One exception, and it is not the framework:** [`demo/`](../demo) holds an Extension, two
Applications and a declarations-only `mesh-web.d.ts` so they typecheck. Nothing behind it runs —
every function in the `.d.ts` is a signature with nothing on the other side. It exists to show the
shape and to prove the type-level guarantees hold, including a `rejected.ts` whose
`@ts-expect-error` assertions fail the build if the narrowing ever widens.

That is the entire state, and it is worth stating that plainly rather than in a table, because it is
the one fact that changes how everything else here should be read. Nothing below is describing
something you can run.

### What the deleted code had settled

Deleting the implementation does not delete what writing it established. These held up and should be
rebuilt, not rediscovered:

- **A bundle `export default`s a class; the host constructs it.** No `define*`, no module-level
  registry. The type-level narrowing worked: `needs: [...] as const` produced a
  `CapabilityContext<TNeeds>` on which an undeclared capability was a compile error, and
  `@ts-expect-error` assertions in CI failed the build if the narrowing ever widened.
- **Provider tokens carry a type across a boundary neither side imports over** — a `unique symbol`
  phantom on `ProviderToken<T>`, with `provides` checked against `activate`'s return type.
- **Erased contexts stay assignable** through method bivariance, so the host can hold heterogeneous
  contributors without a cast. This was verified: the `as unknown as` cast the first draft needed
  turned out to be unnecessary.
- Three interface faults that only a typechecker finds: `needs?: TNeeds` rejects `as const` tuples
  and wants `Readonly<TNeeds>`; an erased return type must not demand a full capability map; and
  `implements` against an all-optional interface silently hits TypeScript's weak-type check.

### What the deleted code had wrong

The reason it was not worth porting. Each is now a roadmap item rather than a defect:

1. `Application.surfaces` was **required**, on the argument that a destination appearing nowhere is
   not a destination. That argument was wrong — an Application is a process, and a headless one is
   ordinary ([README](./README.md) §1). → roadmap A1.1
2. `WindowPreferences` sat on `Application`. A window holds a view, so defaults belong per view.
   → A1.2
3. `ScopedStorage.get<T>(key, fallback): T` was synchronous and could not be backed by anything
   remote ([storage](./storage-and-registry.md) §6). → A1.3
4. `LayoutConfig.regions` and the window manager described the same thing. → A1.5
5. The task switcher compared the configured hotkey against the literal `` 'ctrl+`' ``, so any other
   binding silently never fired. mesh-api issue #7. **A blocker by the time there are two hotkeys.**
   → A1.4
6. `defineApp` and a module-level app registry were still exported beside the contribution layer
   built to replace them — two models in one runtime. Deletion resolves this one outright. → A5.1

---

## 3. Decided

Condensed. Each links to the reasoning.

**The model**
- An abstract operating system in a browser. An Application is a **process**; it may be headless and
  reached only through its API. An Extension is a **capability**, singleton, spans everything.
- A bundle `export default`s a class. **No `define*`, no registry** — that pattern is how mesh
  contracts work and it does not transfer to screens.
- **Regions and windows are the same thing.** A tiled layout is windows arranged as tiles.
- **Views do not nest. Below a view are components.** The window manager sees views and nothing
  under them. This deletes most of nested tiling.
- **View state is not application state.** The window manager owns geometry, z-order and mode; the
  Application owns scroll, forms and connections. A mode switch touches only the first, which is what
  makes switching dynamic with no remount.
- Tiled is website mode: layout-defined geometry, no min/max controls. Windowed is GIMP. The console
  in tiled mode may look funky and must still work.
- Two separately-bound hotkeys: mode switch (dev/admin) and application switch (ordinary).
- Switching is a privilege. Locked deployments may strip floating mode from the build entirely.

**Storage and the registry**
- Two interfaces over one provider abstraction: a **registry** for settings, **storage** for data.
- NT-style **hives**: `system`, `user`, `device`, `session`. Resolution walks build policy → system
  policy → user → device → schema default.
- **A locked blog is a policy value**, not a locking mechanism.
- Providers are async throughout, bound to hives by configuration. **Reads return signals**, so a
  remote registry never makes first paint wait on the network.
- Policy originates at **the build** or **the server**, never the running page — in a browser there
  is no machine administrator distinct from the person at the keyboard.
- **Locking the UI is not access control.** The API enforces; the page's copy is a hint.

**Hosting**
- mesh-web is a browser framework **and** a server process: the builder and the CDN.
- **A site is a hostname.** Any CDN node asked to serve it can. Ten CDNs and ten APIs, all
  interchangeable because all are nodes on one mesh.
- **Addressing is a deployment choice.** A process may have its own URL; a load balancer is one
  option, not the architecture. Nothing may assume sticky routing, and nothing may require a load
  balancer either.
- **Never serve two tenants from one hostname** — the origin is the isolation boundary.
- Both servers are plain HTTP containers behind the surfdns proxy. No TLS, no certificates.
- A repo declares its environments, its API, its exposure list and its build config. **The site's own
  team owns what it exposes and to whom.**
- **mesh-api as it exists is not a fixed point.** mesh-web leads; mesh-api adapts.

**Auth**
- Not Kerberos. A **ticket issuing service** plus **the API as the validation step**.
- **Validate on first sight, cache, invalidate by event.** One mesh call per (ticket, instance), not
  per request. Revocation is near-immediate, not bounded by expiry. Tickets can be opaque, so there
  is **no signing key** to distribute or rotate.
- A **passkey** identifies a person. The browser holds no long-lived credential.
- API keys are fine because they are revocable.
- The API is the gatekeeper. **No internal bypass. No god token.**
- **Roles are CRUD records**, not an enum. `public` is a role. Grants are additive, deny by default,
  and name **patterns**. Role scope is explicit, which makes surfdns #26's ambiguity impossible.
- **`:organizationId` in the path**, never inferred. One `organizationId` per record, no ACL array.
  Membership is a join. Scoping applied by the layer that parsed the path.
- **Teams group people; they do not scope resources.**

**Service modules**
- All three server halves are mesh `ServiceModule`s in the paas layout: contract file, schema file, a
  service class that only mounts, one file per action under `tools/`.
- Three components: **mesh-identity** issues, **mesh-api** gatekeeps, **mesh-web** builds and serves.
  Three repos or one is not decided and does not change the design.

---

## 4. What needs you

Written 2026-09-03 at the end of a working session. **Track 0 is closed — all six decisions are
made** and none of the framework decisions below block starting work.

### One thing waiting on a yes

- **mesh-api's deletion is committed and not pushed.** The repository is empty locally and `ahead 1`.
  Pushing it breaks surfdns's `npm install` immediately: five of its packages depend on
  `github:FLYBYME/mesh-api`, which resolves to that default branch. surfdns needs complete rework
  regardless, so this is timing rather than an objection — but it is a one-way door on a shared
  remote and it is the only thing held back for a decision.

### The honest risk, now partly closed

- **The code runs in a real browser.** [A0.5a](./roadmap.md) is done: eight tests in real Chromium
  (`npm run test:browser`), driving real pointer and keyboard input through CDP. A window has the
  size its view declared, in pixels; a drag survives leaving its handle; a trusted click becomes a
  command that changes application state and the DOM follows. That is the claim the deleted runtime
  could never make at 182 green tests ([testing §6](./testing.md)).
- **A human still has not looked at it.** Headless Chromium is a browser; it is not eyes. There is a
  harness at `browser/index.html` for exactly that — `npm run harness`, then open
  <http://localhost:8080/browser/>. It is one Application in a window you can drag and resize, with
  an activity log of every command the kernel runs. Nobody has sat in front of it yet, and
  [testing §6](./testing.md) is specifically about the difference.

### Worth reading, because they say something about the design

- **The two bugs the end-to-end test found**, §2 above. Both were invisible to 95 unit tests because
  those tests were written from the same mental model that produced the bugs. If the framework has
  more of this, it will show up the same way — by combining pieces, not by testing them apart.
- **[application §11](./application.md): which instance owns a command's implementation.** Found
  while building the kernel. Commands are declared by the *Application* and implemented by a running
  *instance*; with two blog windows open, which one does the palette's "Blog: New Post" run? Today
  the first to start owns it. Defensible, probably not final.

### Small, and want a word when convenient

- **Who owns `artifact`** ([service-modules §2](./service-modules.md)). The builder writes it, the
  CDN reads it constantly. *Recommend `cdn`*, so the read path has no extra hop.
- **Whether mesh-api's exposure is a collection or the deployment descriptor**
  ([service-modules §2](./service-modules.md)). The descriptor is where the site team owns it, which
  argues for it being the source and the collection a resolved cache.

### Where I would pick up

1. ~~**A browser test**~~ — done, [A0.5a](./roadmap.md). Open `npm run harness` and look at it, which
   is the part a test cannot do for you.
2. **`net`, and the generated client** ([network.md](./network.md), roadmap A3.1a). It is the
   capability everything real needs, and the generator is the piece the whole type story rests on.
3. **A7.1, the component vocabulary** — now on the critical path, and gated on the focus graph
   because every primitive must satisfy "every action has a non-pointer path".

---

## 4a. Genuinely undecided, and not blocking

- **Caching and offline writes** for remote providers ([storage](./storage-and-registry.md) §7).
  Reads are easy; writes and cross-device conflicts are not.
- **Schema migration** for settings ([storage](./storage-and-registry.md) §9).
- **Where the hostname → site mapping lives** ([hosting](./hosting.md) §7). The only shared, mutable,
  cross-node state; [service-modules](./service-modules.md) §2 proposes it be an ordinary `site` CRUD
  collection on the mesh, which is probably the answer.
- **Per-tenant quotas and abuse handling** ([hosting](./hosting.md) §3). A per-node limit is ten times
  the limit; a global one is a shared counter in the hot path.
- **Ticket lifetime and cache TTL** ([auth](./auth.md) §9). Two numbers.
- **Delivery guarantees on the revocation event** ([auth](./auth.md) §9). §3 depends on at-least-once
  and ordered; the mesh's actual guarantees need checking rather than assuming.
- **`/api/me/...`** — the user-scoped surface for passkeys and personal settings. It must exist; its
  shape is undecided.
- **Whether platform scope is a third surface** or the `cluster` role scope on ordinary routes.
- **Whether the org model is absent by default or present and unused**, for projects with users and
  no organizations.
- ~~**Whether mesh-web's server half lives in this repository.**~~ **Decided** (D6): one repository,
  several packages — `@flybyme/mesh-web` for the browser, `@flybyme/mesh-cdn`,
  `@flybyme/mesh-builder`, and a types-only `@flybyme/mesh-web-protocol`. Drawn so an Application
  author imports one package and never sees the other ([hosting §0](./hosting.md)).

---

## 5. Pending work

All of it. [`roadmap.md`](./roadmap.md) is the list; this is what specifically changed shape when the
code was deleted.

**mesh-web starts from nothing.** No `package.json`, no tsconfig, no CI. The first commits are
scaffolding, and the constraints that scaffolding must re-establish are worth writing down now
because they were load-bearing and are easy to omit: `types: []` in the browser package's
`tsconfig.json`, so importing a node builtin is a compile error rather than a runtime surprise; and
the rule that **the browser never joins the mesh** — it speaks HTTP to a node's API, and does not run
a `MeshApp` over a WebSocket transport in a tab.

**mesh-api starts from nothing**, and is rebuilt against [service-modules](./service-modules.md) §2
rather than ported.

**surfdns requires complete rework**, which is accepted rather than scheduled — see §1. Its five
packages depend on `github:FLYBYME/mesh-api` and its console imports
`@flybyme/mesh-api/runtime`; neither survives.

**surfdns-console** is still a copy of screens written against `defineApp` and `LayoutConfig`
regions. Both are now deleted rather than deprecated, so the port is a rewrite. Its blocking
question survives the reset unchanged: four response schemas — `WhoamiOutputSchema`,
`MembersOutputSchema`, `NodeStatusOutputSchema`, `roleSatisfies` — cross what is about to become a
network boundary, and none of the three options is chosen.

**Nobody has ever seen the console render.** agy's Playwright install failed and the Chrome
extension was disconnected. It typechecked and built; it was never witnessed, and now the thing that
built it is gone. Worth remembering as a standard to hold to next time — typechecks passing is not
the same as having looked at it.

---

## 6. Open issues elsewhere

**surfdns** — #3 contracts boundary check, #4 vitest projects, #9 package map, #11 placement,
#15 generated client degrades to `unknown` when zod is duplicated, #16 resolver has no EDNS0 or TCP
fallback, #21 mesh-api CI, #26 **nobody can be a platform operator** (blocks the `admin` role),
#29 orphaned organization, #31 fixed test ports, #35 `node.status` is public and leaks
`bootstrapCredential`, #36 console naming and three hand-maintained seams.

**mesh-api** — #7 the task switcher, moved here with the runtime. PR #5 open and green.

**mesh** — nothing open.

The two that touch this design directly are **surfdns #26** (blocks the `admin` role in
[auth](./auth.md) §5) and **surfdns #35** (`bootstrapCredential` reported to anonymous callers is the
node-credential bootstrapping problem in [auth](./auth.md) §9, already visible).
