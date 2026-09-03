# Roadmap: the checklist

> "i need a check list of things to get the ui framework where i want it and the same with the cdn
> and api"

Written 2026-09-02. Three tracks — **UI**, **CDN**, **API** — plus the decisions that gate them and
the surfdns migration that trails them.

This is the *work* list. [`status.md`](./status.md) is the *state* list: what exists today and what
was decided. The five design documents are the reasoning. Nothing here invents new design; every
item points at the section that specifies it, and where a spec says **Open**, the item is marked
blocked rather than guessed at.

**Sizes** are rough: **S** under a day, **M** a few days, **L** a week or more. **⛔** means blocked
on a decision. **★** means it unblocks several other items and should go early.

---

## Track 0 — Decisions that gate code

Six questions. Five have a recommendation and want one word; one is genuinely undecided and decides
a constructor signature. Nothing in Track C can start without D1, and Track A's window manager wants
D2–D4.

- [ ] **D1 ★ Assignment granularity** — a ServiceModule mounts a subset chosen at construction, or
      assignment moves to module granularity for these three.
      *Recommend: subset at construction* — it keeps surfdns's per-unit placement and costs one
      constructor parameter. [service-modules §3](./service-modules.md)
- [ ] **D2 Headless Application distinct from Extension** — *recommend yes*. [README §8](./README.md)
- [ ] **D3 `tile` is a split tree with named nodes** — *recommend both*: named nodes for authors,
      unnamed for dragged splits. [README §8](./README.md)
- [ ] **D4 One view instance per window** — *recommend no sharing*. [README §8](./README.md)
- [ ] **D5 Conflict policy on a setting declaration, defaulting to `reject`** — *recommend yes*.
      [README §8](./README.md) · [storage §7](./storage-and-registry.md)
- [ ] **D6 Does mesh-web's server half live in this repository?** — the `tsconfig.json` sets
      `types: []` precisely so a node import in `src/` fails to compile. Two packages in one repo, or
      two repos. *Recommend: one repo, two packages* — they share the manifest and deployment types
      and nothing else. [service-modules §4](./service-modules.md) · [hosting §1](./hosting.md)

Deferred, because nothing is blocked on them yet: caching and offline writes
([storage §7](./storage-and-registry.md)), settings schema migration
([storage §9](./storage-and-registry.md)), per-tenant quotas ([hosting §3](./hosting.md)), ticket
lifetime and cache TTL ([auth §9](./auth.md)), `/api/me/...` shape, whether platform scope is a third
surface, whether the org model is absent or present-and-unused.

---

## Track A — The UI framework

Where it is: the runtime is real and tested (182 tests); the contribution layer is types only; every
capability except `state` is a declaration; nothing tiles, floats, moves or resizes.

### A1 — Correct what is already known wrong

Six items, all from [status §2](./status.md). Cheap, and they stop later work being built on a shape
that is already retracted.

- [ ] **A1.1 `Application.surfaces` becomes optional**, and `constructApplication`'s guard for it
      goes. A headless Application is a background process. **S** · [README §1](./README.md)
- [ ] **A1.2 Move `WindowPreferences` off `Application` and onto the view.** A window holds a view, so
      defaults belong per view, not per process. **S** · [README §2](./README.md)
- [ ] **A1.3 Make `ScopedStorage` async.** `get<T>(key, fallback): T` cannot be backed by anything
      remote; it must return a signal or a promise. **S** · [storage §6](./storage-and-registry.md)
- [ ] **A1.4 Fix the hotkey parser.** `setupTaskSwitcher` compares the configured binding against the
      literal `` 'ctrl+`' ``, so any other binding silently never fires. **Now a blocker** — there are
      two hotkeys (mode switch, application switch). **S** · mesh-api issue #7
- [ ] **A1.5 Merge `LayoutConfig.regions` into the window manager.** They describe the same thing;
      a tiled layout is windows arranged as tiles. Do this *as* A2, not before it. **M** ·
      [README §3](./README.md)
- [ ] **A1.6 README correction** — already done, listed for completeness. ✅

### A2 — The window manager ★

The largest single piece, and the one everything visual waits on. Nothing here exists.

- [ ] **A2.1 Geometry model and store.** `WindowGeometry`, `WindowState`, z-order, per-window mode.
      Owned by the window manager, not the Application. **M** · [README §4](./README.md)
- [ ] **A2.2 Windowed mode: move, resize, focus, z-order, min/max/restore.** The GIMP case. **L**
- [ ] **A2.3 Tiled mode as a split tree**, nodes optionally named. Layout-defined geometry, no
      min/max affordances. The website case. **L** · ⛔ D3
- [ ] **A2.4 Mode switching with no remount.** The whole point of separating view state from
      application state: a switch re-parents DOM and reassigns geometry, and the Application never
      learns it happened — scroll positions, form contents and open connections survive.
      **M** · [README §4](./README.md)
- [ ] **A2.5 Geometry persistence** per (site, user, application), through the registry, so windowed
      mode remembers position, size and z-order across a mode switch and across a reload.
      **S** · ⛔ A4.2
- [ ] **A2.6 The `windows` capability implemented** against the above — `open`, `close`, `focus`,
      `handle`. **M**
- [ ] **A2.7 Switching is a privilege.** Mode switch is gated on policy; a locked deployment can strip
      floating mode from the build. **S** · [README §5](./README.md)
- [ ] **A2.8 Two separately-bound hotkeys** — mode switch (dev/admin) and application switch
      (ordinary). **S** · ⛔ A1.4

### A3 — The capabilities

Ten declared, one implemented. Each is an interface that already exists in
`src/contribution/capabilities.ts`; the work is the implementation behind it plus tests.

- [ ] **A3.1 `net`** — the HTTP abstraction over a site's API. Base URL from the deployment
      descriptor, ticket attached by the auth Extension, not by each caller. **M** ·
      [hosting §4](./hosting.md)
- [ ] **A3.2 `events`** — the SSE bridge, already coded but **untested here**: its only coverage
      (`events.test.ts`) stayed in mesh-api because it stands up a real express server. Needs a test
      that does not. **S**
- [ ] **A3.3 `commands`** — registration, invocation, argument typing, the palette's data source. **M**
- [ ] **A3.4 `keys`** — binding registration and resolution, sharing one parser with A1.4. **S**
- [ ] **A3.5 `menus`** — menubar, window, status and `context:*` targets. **M**
- [ ] **A3.6 `notifications`** — baked in, identical for a blog, a console and an IDE. Info, warning,
      error, progress, actions, and a handle that can be updated and dismissed. **M**
- [ ] **A3.7 `models`** — typed collections over a site's CRUD contracts, reactive. **L**
- [ ] **A3.8 `windows`** — see A2.6.
- [ ] **A3.9 `storage`** — see A4.
- [ ] **A3.10 `log`** — scoped, level-filtered, and shippable. **S**

### A4 — Registry and storage

The NT-style part. All design, no code. [storage-and-registry.md](./storage-and-registry.md).

- [ ] **A4.1 The provider interface** — async throughout, with `stat`, `usage`, `ProviderCapabilities`
      (including `durability: session | device | replicated`), `EntryStat.version` for conditional
      writes, and `ProviderMetrics`. **M** · [storage §4](./storage-and-registry.md)
- [ ] **A4.2 ★ Hives and resolution** — `system`, `user`, `device`, `session`, resolved build policy →
      system policy → user → device → schema default. **M** · [storage §2](./storage-and-registry.md)
- [ ] **A4.3 Reads return signals**, so a remote provider never makes first paint wait on the network.
      **S** · [storage §4](./storage-and-registry.md)
- [ ] **A4.4 Local providers** — memory, `localStorage`, IndexedDB — bound to hives by configuration.
      **M**
- [ ] **A4.5 A remote provider** over `net`, which is what makes the abstraction worth having. **M**
- [ ] **A4.6 Setting declarations** with schema, default and `conflict` policy. **S** · ⛔ D5
- [ ] **A4.7 Build-time policy injection** — policy originates at the build or the server, never the
      running page. A locked blog is a policy value, not a mechanism. **S** ·
      [storage §2](./storage-and-registry.md) · ⛔ B2

### A5 — The contribution layer, made real

The types are settled and checked. Nothing constructs anything yet, and the *old* model is still in
the tree beside the new one.

- [ ] **A5.1 ★ Retire `defineApp` and `src/app/registry.ts`.** The module-level registry is the exact
      pattern the contribution layer exists to replace, and it is still exported from `src/index.ts`.
      Two models in one runtime is the thing to not ship. **M** · [README](../README.md)
- [ ] **A5.2 The host constructs bundles** — load a module, `constructApplication` /
      `constructExtension` its default export, build the narrowed `CapabilityContext` from its
      `needs`, and refuse anything undeclared at runtime as well as at compile time. **M**
- [ ] **A5.3 Provider wiring** — `provides` collected from `activate`'s return, `consumes` restricting
      `cx.use`, resolution ordered by dependency, and a real error for a missing provider. **M**
- [ ] **A5.4 Lifecycle** — Extensions activate once and span everything; Applications start, stop and
      restart, N instances possible, and appear in the process table. **M** · ⛔ D2
- [ ] **A5.5 Multiple Applications loaded, one foreground.** The switcher, and what "running but not
      shown" means for a view's DOM. **M**

### A6 — The built-ins

Shipped with the framework rather than installed. These are also the proof the contracts are usable,
because they are written against the same interfaces an outside author gets.

- [ ] **A6.1 Process manager** — built in, per the original instruction. Lists Applications, their
      instances and their state; stops and restarts them. **M** · ⛔ A5.4
- [ ] **A6.2 Application switcher** — the ordinary hotkey. **S** · ⛔ A2.8
- [ ] **A6.3 The workbench as an Extension.** The load-bearing test of the whole design: if the IDE
      shell cannot be written as an ordinary Extension over the window manager, the capability split
      is wrong and better to learn it here. **L** · ⛔ A2, A3
- [ ] **A6.4 Auth Extension** — holds the session, attaches the ticket, handles sign-in and the
      revocation event. One per site. **M** · ⛔ C2
- [ ] **A6.5 Notification host** — the surface `notifications` renders into, themed per site. **S**
- [ ] **A6.6 Command palette** over `commands` and `keys`. **S**

### A7 — Components and theme

- [ ] **A7.1 Audit the 13 components** against what a blog, a console and an IDE each need. Everybody
      uses the same form component with different styles — that is the rule to hold.
      **M** · [README §2](./README.md)
- [ ] **A7.2 Theme tokens as registry values**, so a site restyles without forking components.
      **S** · ⛔ A4
- [ ] **A7.3 The missing components** the audit names. **L**

---

## Track B — The CDN and the builder

mesh-web's server half. **None of it exists** — no server, no builder, no `web` ServiceModule.
[hosting.md](./hosting.md).

- [ ] **B0 ★ Settle the repo shape** and create the server package. **S** · ⛔ D6
- [ ] **B1 The `web` ServiceModule**, paas layout: `web.contract.ts`, `web.schema.ts`,
      `web.service.ts` as a mount-only class, one file per action under `tools/`.
      CRUD `site`, `build`, `artifact`; tools `site_resolve`, `build_start`, `build_status`,
      `artifact_get`; events `web.build_started` / `_completed` / `_failed` / `web.site_changed`.
      **L** · ⛔ D1 · [service-modules §2](./service-modules.md)
- [ ] **B2 ★ The builder.** Takes a repo, produces artifacts. The one hard requirement, stated
      explicitly: **the code must not have to be local to the server** — that was the defect in the
      previous generation. Fetch, build, publish. **L** · [hosting §6](./hosting.md)
- [ ] **B3 Build policy injection** — the build is where `system` hive policy and lock decisions are
      baked in. **S** · ⛔ B2, A4.7
- [ ] **B4 The CDN server** — plain HTTP, no TLS, no certificates, behind the surfdns proxy. Resolve
      hostname → site, serve that site's artifacts. **M** · [hosting §1, §2](./hosting.md)
- [ ] **B5 Hostname resolution.** `site` as an ordinary CRUD collection on the mesh — the answer that
      avoids building a second distributed system beside the one already running — with a local cache
      invalidated by `web.site_changed`. **M** · [hosting §7](./hosting.md)
- [ ] **B6 Never serve two tenants from one hostname.** The origin *is* the isolation boundary, so
      this is a serving-layer invariant with a test, not a convention. **S** ·
      [hosting §3](./hosting.md)
- [ ] **B7 Any node can serve any site.** Ten CDNs, interchangeable because all are nodes on one mesh.
      Nothing may assume sticky routing; nothing may require a load balancer either. **M** ·
      [hosting §4](./hosting.md)
- [ ] **B8 The deployment descriptor** — a repo declares its environments, its production host, its
      API, its exposure list and its build config, and the site's own team owns what it exposes and to
      whom. **M** · [hosting §5](./hosting.md)
- [ ] **B9 Artifact storage and cache invalidation** across nodes. **M**
- [ ] **B10 Build triggers** — push, manual, promotion between environments. **M**
- [ ] **B11 Per-tenant quotas and abuse handling.** ⛔ genuinely open: a per-node limit is ten times
      the limit; a global one is a shared counter in the hot path. **M** ·
      [hosting §3](./hosting.md)
- [ ] **B12 `web` module operational surface** — what this node is serving, which builds are current,
      what failed. **S**

---

## Track C — The API and identity

Two components. **mesh-identity does not exist.** mesh-api exists and is explicitly not a fixed
point: mesh-web leads and mesh-api adapts. [auth.md](./auth.md).

### C1 — mesh-identity

- [ ] **C1.1 ★ The `identity` ServiceModule.** CRUD `user`, `organization`, `membership`, `team`,
      `role`, `grant`, `apiToken`, `ticket`. **L** · ⛔ D1 ·
      [service-modules §2](./service-modules.md)
- [ ] **C1.2 Ticket issue / validate / revoke.** Tickets are **opaque**, which is the whole point:
      nothing is signature-verified, so **there is no signing key** to distribute or rotate. **M** ·
      [auth §1, §3](./auth.md)
- [ ] **C1.3 Passkey registration and challenge.** A passkey identifies a person; the browser holds no
      long-lived credential. **L** · [auth §4](./auth.md)
- [ ] **C1.4 API tokens** — issue and revoke. Fine to hold precisely because they are revocable.
      **S** · [auth §4](./auth.md)
- [ ] **C1.5 Roles and grants as records**, not an enum. `public` is a role. Grants are additive, deny
      by default, and name patterns. **M** · [auth §5](./auth.md)
- [ ] **C1.6 Explicit role scope.** This is what makes surfdns #26's `admin` ambiguity structurally
      impossible, so it is not optional polish. **S** · [auth §5](./auth.md)
- [ ] **C1.7 Organizations, memberships, teams.** One `organizationId` per record, no ACL array;
      membership is a join; teams group people and do not scope resources. **M** ·
      [auth §6](./auth.md)
- [ ] **C1.8 Revocation events** — `identity.ticket_revoked`, `identity.principal_suspended`,
      `identity.grant_changed`. **S**
- [ ] **C1.9 ⛔ Check the mesh's actual delivery guarantees** for those events. C2 depends on
      at-least-once and ordered; that needs verifying in `mesh`, not assuming. **S** ·
      [auth §9](./auth.md)
- [ ] **C1.10 mesh-identity stands alone.** It is a foundation for any project needing an API and a
      web front with identity — no surfdns import, ever. Enforce with a dependency check in CI.
      **S** · [auth §2](./auth.md)

### C2 — The API as gatekeeper

- [ ] **C2.1 ★ Validate on first sight, cache, invalidate by event.** One mesh call per
      (ticket, instance), not per request. Revocation stays near-immediate rather than bounded by
      expiry. **M** · [auth §3](./auth.md)
- [ ] **C2.2 Cache invalidation wired to C1.8**, with a cold-start path and a bounded cache. **M**
- [ ] **C2.3 Authorization is two questions** — may this principal do this action, and is this record
      in scope — and both are always asked. **M** · [auth §6](./auth.md)
- [ ] **C2.4 `:organizationId` in the path, never inferred**, and scoping applied by the layer that
      parsed the path. **M** · [auth §6](./auth.md)
- [ ] **C2.5 No internal bypass. No god token.** No trusted-caller exemption by IP, network origin or
      shared-secret header. A test that asserts an unauthenticated internal-looking call is refused.
      **S** · [auth §5](./auth.md)
- [ ] **C2.6 Public contracts are explicitly public.** Deny by default; `public` is a role like any
      other. **S**

### C3 — mesh-api adapted

- [ ] **C3.1 The `api` ServiceModule** and the `exposure` collection. **M** · ⛔ D1
- [ ] **C3.2 ⛔ Decide whether exposure is a collection or the deployment descriptor.** The descriptor
      is where the site team owns it, which argues for descriptor as source and collection as resolved
      cache. **S** · [service-modules §2](./service-modules.md)
- [ ] **C3.3 REST from contracts** — already the thing mesh-api does; it needs to read exposure rather
      than a hand-maintained list. **M** · [hosting §4](./hosting.md)
- [ ] **C3.4 SSE from events**, which the browser's `events` client already expects. **M**
- [ ] **C3.5 WebSockets**, the third named interface. **M**
- [ ] **C3.6 Addressing is a deployment choice.** A process may have its own URL; nothing may assume
      sticky routing or require a load balancer. **S** · [hosting §4](./hosting.md)
- [ ] **C3.7 Delete `src/runtime/`** once surfdns has switched imports. **S** · ⛔ Track D
- [ ] **C3.8 Abandon `spec/13-applications-and-extensions`** — the branch of closed PR #6. Its shell
      profiles are superseded; only issue #7 was worth keeping. **S**
- [ ] **C3.9 Land or close PR #5** (`tony/33-slotted-surfaces`). Open and green; its fix is already
      carried into mesh-web, so it only matters while surfdns still consumes
      `@flybyme/mesh-api/runtime`. **S**
- [ ] **C3.10 Generated typed client** — surfdns #15, and the third option for the surfdns-console
      schema boundary. **M**

---

## Track D — surfdns and the console

Trails the three tracks. Nothing here should start before A5 and A2, because the screens would be
ported twice.

- [ ] **D.1 Decide the schema boundary** for surfdns-console: the client declares its own shapes /
      surfdns publishes a schema package / a generated typed client. Four symbols
      (`WhoamiOutputSchema`, `MembersOutputSchema`, `NodeStatusOutputSchema`, `roleSatisfies`) cross
      what is about to become a network boundary. *Recommend: generated client (C3.10), with declared
      shapes as the interim.* **S**
- [ ] **D.2 Make surfdns-console a real package** — `package.json`, tsconfig, CI. **S**
- [ ] **D.3 Port the six screens** off `defineApp` and `LayoutConfig` regions onto Applications and
      views. **M** · ⛔ A5.1, A2
- [ ] **D.4 Console deployment descriptor** — production host, production API, other environments.
      **S** · ⛔ B8
- [ ] **D.5 Remove the UI from surfdns.** A coordinated change across surfdns, surfdns-console and the
      serving layer. **M**
- [ ] **D.6 Switch surfdns's imports and import map** — `@flybyme/mesh-api/runtime` →
      `@flybyme/mesh-web`, in both `SHARED_MODULES` and `IMPORT_MAP_BASE`. **S**
- [ ] **D.7 Actually look at it.** Nobody has ever seen the console's header and footer render.
      Everything typechecks and builds; nothing has been witnessed. **S**
- [ ] **D.8 surfdns #26** — nobody can be a platform operator. Blocks the `admin` role. **M**
- [ ] **D.9 surfdns #35** — `node.status` is public and leaks `bootstrapCredential`. This is the
      node-credential bootstrapping problem from [auth §9](./auth.md), already visible in production
      code. **S**

---

## Milestones

Four checkpoints, each a thing you can look at rather than a percentage.

**M1 — A window you can drag.**
A1 · A2.1 · A2.2 · A2.6 · A5.1 · A5.2
*One Application, constructed from a class, in a window that moves and resizes.* This is the first
point where the design stops being prose.

**M2 — Two modes, no remount.**
A2.3 · A2.4 · A2.5 · A2.7 · A2.8 · A3.4 · A4.1–A4.4 · A6.2
*A blog in tiled mode; hit the hotkey; the header, sidebar and footer become windows; scroll position
survives.* This is the demo that proves the central claim.

**M3 — A site served from a hostname.**
B0 · B1 · B2 · B4 · B5 · B6 · B8 · C1.1 · C1.2 · C2.1 · A3.1 · A6.4
*Push a repo, mesh-web builds it, `console.surfdns.net` serves it from any CDN node, and signing in
issues a ticket the API validates once and caches.* End to end, one site.

**M4 — The framework proves itself.**
A3 (all) · A6.1 · A6.3 · A7 · B7 · B9–B12 · C1 (all) · C2 (all) · C3 · Track D
*The workbench written as an Extension; the console ported; surfdns's UI deleted; many sites, many
owners, ten CDNs and ten APIs.*

---

## What this list does not cover

- **The IDE.** "VS Code for general web pages" is what the framework is *for*; A6.3 is the test that
  it can be built, not the building of it.
- **mesh itself.** Nothing here needs new framework in `mesh` except C1.9, which is a question rather
  than a change.
- **The crypto trading platform**, or anything else that comes later. If the framework is right, they
  are Applications.
