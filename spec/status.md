# Where everything stands

Written 2026-09-02. This is the handoff: what exists, what was decided, what is still open, and what
the next person (or the next session) should pick up.

The design lives in five documents. This one is the index and the state of play.

| document | covers |
| --- | --- |
| [README](./README.md) | The model: processes, views, windows, view state |
| [storage-and-registry](./storage-and-registry.md) | Providers, hives, settings, policy |
| [hosting](./hosting.md) | The builder, the CDN, hostnames, multi-tenancy, the proxy |
| [auth](./auth.md) | Tickets, validation, passkeys, roles, organizations |
| [service-modules](./service-modules.md) | How the three server halves are structured |
| **[roadmap](./roadmap.md)** | **The checklist — UI, CDN and API, ordered, with milestones** |

This document is the state. [`roadmap.md`](./roadmap.md) is the work: every item to get the UI
framework, the CDN and the API where they are meant to be, marked with what blocks it.

---

## 1. The repositories

| repo | branch | head | state |
| --- | --- | --- | --- |
| **mesh** | master | `1cb54e5` | Clean. v2.1.0 tagged. Nothing open. |
| **mesh-api** | `spec/13-applications-and-extensions` | `5d558de` | Clean, but on a stale branch — see below. |
| **mesh-web** | master | this | 182 tests, typecheck 0, build 0. Pushed. |
| **surfdns** | master | `cece581` | Clean, green, **still contains all the UI**. |
| **surfdns-console** | master | `772cdef` | Staged files only. **Does not build.** |

Both new repositories are private on GitHub:
- https://github.com/FLYBYME/mesh-web
- https://github.com/FLYBYME/surfdns-console

### mesh-api is on a branch that should be abandoned

`spec/13-applications-and-extensions` holds PR #6, which was **closed unmerged** — its shell-profile
model was superseded (the workbench is an Extension over a real window manager, not a mode baked into
the framework). The branch still exists locally. Nothing on it is worth keeping except the task
switcher findings, which were filed separately as mesh-api issue #7.

**mesh-api PR #5** (`tony/33-slotted-surfaces`) is still open and green. Its fix has already been
carried into mesh-web, so merging it only matters if surfdns keeps consuming
`@flybyme/mesh-api/runtime` in the meantime.

---

## 2. What is code, and what is only design

**Code, working, tested:**

- The browser runtime, moved whole out of mesh-api — reactivity, DOM and 13 components, router,
  manifest, app host and compositor, SSE event-bridge client. 182 tests.
- The contribution layer's **types**: `Application`, `Extension`, capabilities, provider tokens,
  `constructApplication` / `constructExtension`. Type-level guarantees verified with
  `@ts-expect-error` and checked in CI.
- `tsconfig.json` sets `types: []` so a node import in `src/` is a compile error.

**Design only, no code:**

- Every capability except `state`. `net`, `events`, `commands`, `keys`, `menus`, `notifications`,
  `models`, `windows`, `storage`, `log` are declarations.
- The entire window manager. Nothing tiles, floats, moves, resizes or persists geometry.
- The registry, all providers, hives, policy.
- The builder and the CDN. mesh-web has no server half at all yet.
- mesh-identity. Does not exist.

**Known wrong in the code, per the specs:**

1. `Application.surfaces` is **required** and must become optional — a headless Application is a
   background process ([README](./README.md) §1). The `constructApplication` guard that checks for it
   goes too.
2. `WindowPreferences` sits on `Application`. If a window holds a view, defaults belong per view.
3. `ScopedStorage.get<T>(key, fallback): T` is synchronous and cannot be backed by anything remote
   ([storage](./storage-and-registry.md) §6).
4. `LayoutConfig.regions` and the window manager describe the same thing and must merge.
5. The task switcher hotkey is compared against the literal `` 'ctrl+`' ``, so any other configured
   binding silently never fires. mesh-api issue #7, moved here with the runtime. **Now a blocker**,
   because there are two hotkeys.
6. mesh-web's README still says the package is "everything that runs in a tab". It is also a server
   process ([hosting](./hosting.md) §1).

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

## 4. Open — the ones that block work

**Decides a constructor signature, so wants answering first**

- **Assignment granularity** ([service-modules](./service-modules.md) §3). surfdns's runtime exists
  because units must be individually assignable; a ServiceModule bundles them. Either a module mounts
  a subset chosen from its assignment, or assignment moves to module granularity for these three.

**Five recommendations awaiting one word each** ([README](./README.md) §8)

1. Headless Application is distinct from an Extension — *recommend yes*
2. `tile` is a split tree with named nodes — *recommend both*
3. One view instance per window; two windows means two instances — *recommend no sharing*
4. Conflict policy on a setting declaration, defaulting to `reject` — *recommend yes*
5. Three lock levels (`locked` / `privileged` / `open`) — **superseded**: it is a policy value plus
   who may write the path ([storage](./storage-and-registry.md) §2)

**Genuinely undecided**

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
- **Whether mesh-api's exposure is a collection or the deployment descriptor**
  ([service-modules](./service-modules.md) §2).
- **Whether mesh-web's server half lives in this repository**, given `types: []`.

---

## 5. Pending work, not started

**surfdns-console** is a copy, not a package. No `package.json`, no tsconfig, no CI, and every import
still points into the surfdns monorepo. It was deliberately left there: the screens use `defineApp`
and place themselves into `LayoutConfig` regions, and both are being replaced, so wiring it now means
porting the screens twice.

Its blocking question: the screens import four response schemas — `WhoamiOutputSchema`,
`MembersOutputSchema`, `NodeStatusOutputSchema`, `roleSatisfies` — across what is about to become a
network boundary. Three options, none chosen: the client declares its own shapes; surfdns publishes
a schema package; or a generated typed client (surfdns issue #15).

**surfdns still has all its UI.** Nothing was removed. The removal is a coordinated change across
surfdns, surfdns-console and whatever replaces the serving layer.

**mesh-api still has `src/runtime/`.** The move to mesh-web was a copy. Deleting it breaks surfdns
until surfdns switches its imports and its import map (`@flybyme/mesh-api/runtime` →
`@flybyme/mesh-web`, in both `SHARED_MODULES` and `IMPORT_MAP_BASE`).

**Nobody has seen the console's header and footer render.** agy's Playwright install failed and the
Chrome extension was disconnected. Everything typechecks and builds; nothing was witnessed.

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
