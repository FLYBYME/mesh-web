# Roadmap: the checklist

> "i need a check list of things to get the ui framework where i want it and the same with the cdn
> and api"

Written 2026-09-02. Three tracks — **UI**, **CDN**, **API** — plus the decisions that gate them and
the surfdns migration that trails them.

This is the *work* list. [`status.md`](./status.md) is the *state* list: what exists today and what
was decided; it indexes the design documents that are the reasoning. Nothing here invents new design;
every item points at the section that specifies it, and where a spec says **Open**, the item is
marked blocked rather than guessed at.

**Sizes** are rough: **S** under a day, **M** a few days, **L** a week or more. **⛔** means blocked
on a decision. **★** means it unblocks several other items and should go early.

---

## Track 0 — Decisions that gate code

**All six decided.** Two of them changed shape rather than being answered: D1 dissolved once the
`web` module split, and D5 turned out to have no cost once geometry was recognised as device-scoped.

Worth recording one failure mode: D3 and D4 had been settled inside
[application §6](./application.md) while still listed as open here. **A decision made in the document
where the work is happening does not propagate back to the list of open questions by itself.**

**Nothing in any track is blocked on a decision.** What remains open is listed below and none of it
gates starting.

- [x] **D1 Assignment granularity — dissolved, not answered.** **Four modules: `identity`, `api`,
      `cdn`, `builder`.** Splitting `web` makes the module boundary and the deployment boundary the
      same line, so there is no subset to mount, no assignment in a constructor, and no partial-mount
      machinery to build. All four may share one process; splitting them is configuration.
      **M3 can therefore be a single process.** [service-modules §3](./service-modules.md)
- [x] **D2 Headless Application distinct from Extension — yes.** The deciding reason is volume: a
      handful of Extensions will ever be written and many Applications, so the contract used by the
      many gets the real lifecycle, instances and process table. Corollary recorded in
      [kernel §2](./kernel.md): **the bias is toward Extension** — the kernel earns each row by being
      unable to do otherwise. [README §8](./README.md)
- [x] **D3 `tile` is a split tree with named nodes** — **decided: both.** An Application declares a
      layout; `tile` names a node; dragged splits create unnamed ones. And a tile is a *slot*, not a
      view — several views target one tile over an Application's life.
      [application §6](./application.md)
- [x] **D4 One view instance per window** — **decided: no sharing.** Two windows means two instances
      over one application state; identity is the view id plus a key from its params.
      [application §6](./application.md)
- [x] **D5 Conflicts reject. One way, no per-setting field.** The `conflict` declaration is
      withdrawn. The case that argued for last-write-wins was window geometry — and geometry lives in
      the **`device` hive**, which is not shared, so it never conflicts. That is right for its own
      reasons: a Deck and a desktop have different screens and syncing window positions between them
      would be wrong. [storage §7](./storage-and-registry.md)
- [x] **D6 One repository, several packages.** `@flybyme/mesh-web` (browser), `@flybyme/mesh-cdn`,
      `@flybyme/mesh-builder`, and a types-only `@flybyme/mesh-web-protocol`. Drawn so **an
      Application author imports one package and never sees the other** — no subpath exports, because
      an editor autocompleting `mesh-web/server` into an Application is a mistake worth making
      impossible rather than discouraging. [hosting §0](./hosting.md)

Raised by [kernel.md](./kernel.md) and not yet weighed: **real isolation** — an iframe per
Application would give each its own origin, at the cost of putting a postMessage boundary under every
capability call and making tiled layout much harder. Today's answer is one realm, written down as a
limit rather than chosen as a design. Also **whether the kernel is replaceable at build time**, which
is [stripping floating mode from a locked build](./README.md) §6 taken further and risks two kernels
that drift.

Deferred, because nothing is blocked on them yet: caching and offline writes
([storage §7](./storage-and-registry.md)), settings schema migration
([storage §9](./storage-and-registry.md)), per-tenant quotas ([hosting §3](./hosting.md)), ticket
lifetime and cache TTL ([auth §9](./auth.md)), `/api/me/...` shape, whether platform scope is a third
surface, whether the org model is absent or present-and-unused.

---

## Track A — The UI framework

Where it is: **nothing.** The repository is `spec/` and a `.git`. Everything below is written from
zero, which is the point of the reset — see [status §1](./status.md).

### A0 — Scaffolding

- [x] **A0.1 The browser package** — `package.json`, `tsconfig.json` with `types: []`, vitest, CI.
      Done 2026-09-03.
- [x] **A0.2 The boundary is stated and guarded.** `src/index.ts` carries both rules;
      `test/boundaries.test.ts` checks that nothing in `src/` imports node and nothing in
      `src/description/` names a DOM type. Verified to fail when violated.
- [x] **A0.3 Reactivity** — recovered from history rather than rewritten. 990 lines.
- [x] **A0.4 ★ The description layer** — elements, text, `when`, `each`, intents, actions, the
      handler table, and `flatten()` as the test renderer. Plain data throughout; a full render
      asserts with no DOM. [view-layer §2](./view-layer.md)
- [x] **A0.5 ★ The renderer** — description → DOM, signals bound fine-grained at construction, no
      VDOM and no diffing. `when` anchored on comment markers so it introduces no wrapper element;
      `each` keyed so a reorder moves the same nodes; device events mapped to intents; disposal by
      reactive scope. Asserted by node identity, not by markup.
      [view-layer §4](./view-layer.md)
- [x] **A0.5a Browser tests for the renderer.** jsdom covers reconciliation, binding, disposal and
      intent mapping. It does not cover layout, focus, real input devices or anything measured, and
      [testing §4](./testing.md) says that is where the risk is.
      **Done** as a second vitest project (`npm run test:browser`, `vitest.browser.config.ts`):
      Vite serves `src/` to a real Chromium, the test runs inside the page, and input arrives
      through CDP rather than `dispatchEvent`. Eight tests, each one a claim jsdom cannot evaluate —
      declared sizes in real pixels, rows that stack, a drag that survives leaving its handle,
      `minSize` enforced against real layout, a trusted click becoming a command, and `Enter`
      reaching a row without a pointer. Playwright uses the system Chrome (`channel: 'chrome'`), so
      CI needs a browser rather than a 400MB download.
- [x] **A0.5a-i The browser suite was testing a build nobody had made.** *(fixed 2026-09-04)*
      `test:browser` ran vitest directly, and the harness tests load the *compiled*
      `browser/dist/harness.js`. Nothing rebuilt it, so the suite tested whatever was last left on
      disk. A3.11 found it the loud way: the rename typechecked clean in four projects and 309 unit
      tests, then 11 browser tests failed against yesterday's JavaScript, which still called
      `cx.net`. **The dangerous direction is the other one** — a green suite proving nothing about
      the code just written, which is what it had been doing for however long. `test:browser` now
      runs `build:browser` first, and `harness` shares the same script rather than repeating it.
- [ ] **A0.5b Extend the browser project to the rest of §4** — focus in the DOM beyond one
      `activeElement` check, text entry and IME, pen and touch. Gated on A8 for the input adapters
      and on A7.1 for the focus graph. **M** · [testing §4](./testing.md)
- [ ] **A0.6 Router** — routing, scoped routers, scroll and focus restoration. **M**

A0.3 and A0.6 are parts of the deleted runtime with no design defect against them — deleted because
the repository was emptied, not because they were wrong, and history is the reference
(`git show 4cd801d^:src/reactivity/…`). **A0.4 and A0.5 are not:** the old DOM layer handed views
`HTMLElement` and exported `h()` to Applications, which is exactly what
[view-layer.md](./view-layer.md) exists to prevent. Rebuild those two, do not port them.

### A1 — The retractions, so they are not rebuilt

Six shapes the deleted code had wrong ([status §2](./status.md)). None is a fix any more — each is a
constraint on writing the replacement, which is cheaper than the second round of arguing them out.

- [ ] **A1.1 `Application.surfaces` is optional.** A headless Application is a background process,
      and there is no construct-time guard demanding a view. **S** · [README §1](./README.md)
- [ ] **A1.2 `WindowPreferences` belongs to the view, not the Application.** A window holds a view, so
      defaults belong per view, not per process. **S** · [README §2](./README.md)
- [ ] **A1.3 `ScopedStorage` is async.** A synchronous `get<T>(key, fallback): T` cannot be backed by
      anything remote. **S** · [storage §6](./storage-and-registry.md)
- [x] **A1.4 One hotkey parser, and bindings are data.** The old task switcher compared the configured
      binding against the literal `` 'ctrl+`' ``, so any other binding silently never fired. mesh-api
      issue #7 — the single most concrete thing carried out of the deleted code.
      **Done in `src/input/keys.ts`:** one function normalises a declaration, one normalises an event,
      and they produce the same form — so `Shift+Ctrl+P`, `ctrl+shift+p` and a real keypress are one
      value, and there is no string left to compare against a literal. The manifest normalises too,
      so two Applications spelling one shortcut differently *collide* instead of both believing they
      own it. Closes mesh-api #7.
- [ ] **A1.5 There is no `LayoutConfig.regions`.** Regions and windows are one concept; a tiled layout
      is windows arranged as tiles. This is A2.3, not a separate migration. **—** ·
      [README §3](./README.md)
- [ ] **A1.6 No `defineApp`, no module-level app registry.** Resolved by deletion; listed so it is not
      reintroduced as a convenience. **—** · A5

### A2 — The window manager ★

The largest single piece, and the one everything visual waits on. Nothing here exists.

- [x] **A2.1 Geometry model and store.** `WindowGeometry`, `WindowState`, z-order, per-window mode.
      Owned by the window manager, not the Application. Pure functions — `move`, `resize`,
      `clampSize`, `constrainToViewport`, `maximize`, `cascade`, `raise` — so the sign errors are
      cheap to find. [README §4](./README.md)
- [x] **A2.2 Windowed mode: move, resize, focus, z-order, min/max/restore.** The GIMP case. Verified
      in real Chromium, not only jsdom: a drag that survives leaving its handle, `minSize` enforced
      against real layout, and a window that moves without re-rendering its view.
- [x] **A2.3 Tiled mode as a split tree**, nodes named. `tiles()` declares it, `tileRects()` places
      it — pure functions over plain data, so a fraction that does not add up is caught without a
      browser. Fixed sizes are taken before fractions are divided (a 40px header stays 40px on a
      phone), and a layout naming one tile twice is refused when it is *written*, because a tile is
      an address. `layout` is in the manifest, not built in `start()` — the kernel needs the tile
      names before step 9. [application §6](./application.md)
- [x] **A2.4 Mode switching with no remount.** `WindowManager` gains a mode; `rectOf()` answers from
      the tile in tiled mode and from the record in windowed, and **a window's own rect is never
      overwritten** — which is what lets a switch back put everything where the user had it. A tile
      holds one view at a time, most recently focused; the others are *hidden*, never disposed.
      Verified in a real browser, because scroll position is a rendering fact jsdom cannot have.
      **Corrected the spec while building it** ([README §4](./README.md)): a scroll offset cannot
      survive a resize as a *number*, and a shell must reposition rather than re-parent, because
      moving a node between parents resets its scroll.
- [x] **A2.5 Geometry persistence** per (site, application) in the **`device` hive** — not `user`,
      because a Deck and a desktop have different screens. Position, size, state, stacking order and
      the mode, saved debounced (a drag is hundreds of moves) and restored *awaited*, so a window
      comes back where it was rather than appearing at a default and jumping. One corrupt entry drops
      itself rather than the whole layout, and a hive that refuses a write is reported, never thrown
      out of the effect that would tear down the shell's paint.
- [x] **A2.6 The `windows` capability implemented** against the above — `open`, `close`, `focus`,
      `handle`. A view opening under a name its Application never declared is caught at the sink,
      and stopping a process closes every window it owns.
- [x] **A2.7 Switching is a privilege.** **There is no locking mechanism**, which is the whole point:
      the window manager reads a setting, a locked deployment writes that setting as build policy or
      `system`, and it becomes a setting nobody can change. `modePolicy` is the registry's ordinary
      answer to *may this page write here*, and the refusal carries the registry's own reason — so a
      toast says "Frozen into this build." rather than "not allowed".
      Verified through the **hotkey**, not the button: a disabled control is a *presentation* of the
      policy, and the binding still resolves, so the refusal has to live where the decision is.
      [README §5](./README.md) · [storage §2](./storage-and-registry.md)
- [x] **A2.8 The mode-switch hotkey**, separately bound, resolving through the manifest's table. The
      Application *declares* the command; the **shell implements it**, because the blog cannot switch
      modes and cannot see which one it is in. Verified in a real browser: `alt+t` tiles,
      `alt+shift+n` does not fire `alt+n`.
- [ ] **A2.8b The application switcher hotkey** — the other of the two. Needs more than one
      Application loaded, which is A5.9. **S** · ⛔ A5.9

### A3 — The capabilities

Ten capabilities, none implemented and none declared any more — the interfaces went with everything
else. Their shapes are in history (`git show 4cd801d^:src/contribution/capabilities.ts`) and were
sound; each item below is the interface *and* the implementation behind it.

- [x] **A3.1 ★ `net`** — the HTTP abstraction over a site's API. Done 2026-09-04, when the last two
      clauses were built: the base URL comes from the deployment descriptor (`MESH_API` → the build →
      `createServices({ apiOrigin })`), and the ticket is attached by the auth Extension through the
      new `credentials` capability rather than by any caller. Fully typed throughout —
      `cx.mesh.call('credential.resolve', { id })` infers input and output as `ctx.call` does.
      [network.md](./network.md) · [hosting §4](./hosting.md)
- [x] **A3.1b The `credentials` capability**, which is what made the sentence in network.md §4 true.
      "The auth Extension attaches the ticket for every caller" had no mechanism: wrapping its own
      `net` attaches to its own calls and nobody else's, and the thing that needs wrapping is how the
      *kernel* builds a client. Declared (so a site can see who holds the seam), singular (a second
      attach throws, naming the first), and read per request (so signing in does not mean restarting
      every Application). [network §4](./network.md)
- [x] **A3.1a-i The shape the generator emits.** `defineApi` / `call<I, O, E>`, `createClient`, the
      `net` capability, and `api` in the manifest. Structural types, no `z.infer` across a package
      boundary, scoped rather than global, and only what the descriptor exposes. Twenty tests, six of
      them `@ts-expect-error` — an unexposed action, a wrong input, another API's action, and a value
      read before its failure was considered all fail to compile.
- [x] **A3.1a-ii ★ The emitter.** Lives in **mesh-api** — this package sets `types: []`, so a
      file-writing generator cannot compile here, and mesh-api owns the descriptor anyway.
      JSON Schema → TypeScript, with one rule: **a schema that cannot be represented fails the
      build**, because an `unknown` in a generated client type-checks everywhere and tells nobody.
      Verified by compiling the emitted file against this package's real `defineApi`/`call` together
      with a usage file whose every assertion is a type assertion.
      Declared errors are emitted as a literal union, so a `switch` on `error.name` is checked.
- [x] **A3.1b Exposure hash checked in CI and reported by the API.** Both halves exist:
      `mesh-api-generate-client --check` fails a build on a stale client, the API reports
      `x-exposure` on every response including refusals, and `createClient` refuses to speak to an
      API serving a different hash. The descriptor verifies its own hash on read, so editing a gate
      from `user` to `public` in the JSON is caught. [network §6](./network.md)
- [x] **A3.1c Errors are part of the type** — a call returns a result naming its failures, and the
      value is only reachable after the check. **Done** with A3.1a-i: `Result<T, E>` as a
      discriminated union, nine named transport failures rather than status codes, and a `declared`
      case carrying the exposure's own error names as literals. `describe()` switches exhaustively
      with no default, so a new failure is a compile error rather than an undefined in a toast.
      [type-safety §5](./type-safety.md)
- [ ] **A3.1d Typed accessors for everything string-keyed** — views, commands, settings, storage,
      actions, events. One mechanism: a literal union of declared keys plus a mapped type to the
      value. **M** · [type-safety §3](./type-safety.md)
- [ ] **A3.1e One escape hatch, made unattractive** — separate surface, returns `unknown`, explicit
      parsing, declared as a capability. `net.get<T>`/`post<T>` do not exist. **S** ·
      [type-safety §7](./type-safety.md)
- [ ] **A3.2 `events`** — the SSE bridge. It was written once and its only coverage lived in mesh-api,
      because the test stood up a real express server. Rebuild it with a test that does not need one.
      **M**
- [ ] **A3.3 `commands` — partial, and the item was misleading.** Registration and invocation are
      **built and in use**: `cx.commands.implement(id, fn)` refuses an id this contribution did not
      declare, `run(id, ...)` invokes anything the kernel knows, the manifest merges declarations
      before anything starts, and A3.4 already answers a command to its bindings. The harness and the
      workbench both run on it.
      What is **not** built: **argument typing** — `CommandImpl` takes `...args: readonly Json[]`, so
      `run('blog.publish', 42)` where a slug was meant is a run-time surprise — and **the palette's
      data source**, which is A6.6's input. **S** (was **M**)
- [x] **A3.4 `keys`** — binding resolution, sharing one parser with A1.4. `bindingTable()` answers
      both directions: a keypress to a command, and a command to its bindings so a menu can show the
      shortcut without anybody writing it twice. **Reserved bindings are enforced here**
      ([input §7.1](./input.md)): the manifest refuses one the host takes first and reports it as a
      load-time conflict, because a binding that fires the command *and* opens a browser window
      looks like it worked. The reserved set is a parameter — a tab loses `ctrl+n`, a kiosk loses
      nothing — not a constant.
- [ ] **A3.5 `menus`** — menubar, window, status and `context:*` targets. **M**
- [ ] **A3.6 `notifications` — partial, and the item was misleading.** Info, warning and error are
      **built**, each returning a handle that updates and dismisses, the list is a signal, dismissing
      removes rather than flags, and A6.5's host renders them — that gap was found the hard way, by a
      capability recording notices nothing displayed.
      What is **not** built: **progress** and **actions** — a notice with a button on it, which is
      how "deploy failed · retry" is written and the reason a console needs this before it can be
      ported. **S** (was **M**)
- [ ] **A3.7 `models`** — typed collections over a site's CRUD contracts, reactive. **L**
- [ ] **A3.8 `windows`** — see A2.6.
- [ ] **A3.9 `storage`** — see A4.
- [ ] **A3.10 `log`** — scoped, level-filtered, and shippable. **S**
- [x] **A3.11 ★ Rename `net` to `mesh`.** *(done 2026-09-04)* `net` read as *the network*, which is
      exactly what it is not — one API, declared in the manifest, typed from that site's exposure
      descriptor, scoped rather than global. Naming it after the network is what made "can I call a
      weather API with it" a reasonable question, and the answer is no.
      `cx.mesh.call('post.list')` says what is on the other end and mirrors `ctx.call`, which
      [network §1](./network.md) makes the whole ergonomic target. Done the same day as A6.8, which
      was the last moment it was free: the package became installable that morning, so this was the
      final hour in which nothing outside the repository could be importing the old name.

      `needs('mesh')`, `cx.mesh`, `MeshClient<A>` and `KernelServices.meshClient`. **`src/net/`
      stayed** — `Transport`, `NetRequest`, `NetResponse` and `fetchTransport` are the HTTP one
      level below the capability, and there the name is accurate. Keeping both, each on its own
      layer, is the §2a distinction stated rather than blurred: `mesh` is a destination, `net` is a
      medium. 309 tests, four typechecks and `check:consumer` all clean after it. **S** ·
      [network §2a](./network.md)
- [ ] **A3.12 `http` — the declared escape.** A separate capability with its own origin allowlist, for
      the page that genuinely must reach a third party. `needs('http')` is *visible in a manifest*,
      which is the whole mechanism: an audit reads "this site talks to its own API, and this one
      Extension also reaches `api.weather.com`" rather than a list that is silently incomplete. The
      same pattern `credentials` and `chrome` already use. Not urgent — the sanctioned path is a
      contract, and this exists so the unsanctioned one is conspicuous rather than invisible. **M** ·
      [network §2a](./network.md)

### A4 — Registry and storage

The NT-style part. All design, no code. [storage-and-registry.md](./storage-and-registry.md).

- [x] **A4.1 The provider interface** — async throughout, with `stat`, `usage`, `ProviderCapabilities`
      (including `durability`), `EntryStat.version` for conditional writes, and `ProviderMetrics`.
      `unknown` stops at this layer and nothing above it holds one.
      [storage §4](./storage-and-registry.md)
- [x] **A4.2 ★ Hives and resolution** — `system`, `user`, `device`, `session`, resolved build policy →
      system → user → device → declared default. **`session` is deliberately not in the order**: a
      tab-scoped value is asked for by name, never silently preferred over a saved choice. A value
      from a hive this page cannot write is reported `locked` *with a reason*, which is the thing
      every settings screen gets wrong. [storage §2](./storage-and-registry.md)
- [x] **A4.3 Reads return signals**, so a remote provider never makes first paint wait on the network.
      `read()` answers immediately with build policy or the declared default and updates in place.
      `ready()` is the escape hatch for the one caller that genuinely must wait — the kernel
      restoring geometry at boot step 9, before a window can appear and jump.
- [x] **A4.4 Local providers** — memory and `localStorage`, bound to hives by configuration. Every
      `localStorage` access is wrapped, because it throws on *access* in a private window and on
      write when full: a registry that took the page down over a preference has the priority
      backwards. Value and version are one envelope, so two tabs cannot write them separately and
      disagree.
- [ ] **A4.4b IndexedDB provider.** `localStorage` is synchronous under an async interface — correct,
      but it caps a hive at a few megabytes and blocks the main thread on a large write. **M**
- [ ] **A4.5 A remote provider** over `net`, which is what makes the abstraction worth having. **M**
- [x] **A4.6 Setting declarations** with a parser and a default. **No `conflict` field** — conflicts
      always reject. `setting()` infers its type from `parse`, so there is no type argument to supply
      and no `get<Draft>(path)` to get wrong ([type-safety §2](./type-safety.md)). A stored value that
      fails its declaration **falls back loudly** rather than being cast — the only defence against a
      value written by an older version of the same Application.
      [storage §7](./storage-and-registry.md)
- [ ] **A4.7 Build-time policy injection** — policy originates at the build or the server, never the
      running page. A locked blog is a policy value, not a mechanism. **S** ·
      [storage §2](./storage-and-registry.md) · ⛔ B2

### A5 — The kernel and the contribution layer

[kernel.md](./kernel.md) · [extension.md](./extension.md) · [application.md](./application.md)

The contribution *types* were settled and type-checked once; the code is gone, and the type-level
guarantees are the part to rebuild deliberately rather than approximate ([status §2](./status.md)).
The kernel around them is new design and has never existed in any form.

- [x] **A5.1 ★ `Application` and `Extension`, capabilities, provider tokens.** `needs(...)`
      narrows `CapabilityContext<TNeeds>` so an undeclared capability is a compile error, with
      `@ts-expect-error` assertions in CI that fail the build if the narrowing widens. **M**
- [x] **A5.2 The host constructs bundles** — load a module, `constructApplication` /
      `constructExtension` its default export, build the narrowed `CapabilityContext` from its
      `needs`, and refuse anything undeclared at runtime as well as at compile time. **M**
- [x] **A5.3 Provider wiring** — `provides` collected from `activate`'s return, `consumes` restricting
      `cx.use`, resolution ordered by dependency, and a real error for a missing provider. **M**
- [x] **A5.4 The capability broker** — one context per contributor, built from its `needs` and
      **scoped to it**, so `log` is tagged, `storage` is namespaced, `windows` knows the owner, and
      disposal is the kernel's job rather than the contributor's. **M** · [kernel §4](./kernel.md)
- [x] **A5.5 Boot sequence** — descriptor, registry, construct all, resolve the graph, activate in
      dependency order, restore view state, start Applications, route. Construction is side-effect
      free and no Extension can run code during another's activation. **M** ·
      [kernel §3](./kernel.md)
- [x] **A5.6 The process table** — `pid` assigned by the kernel, not taken from the bundle;
      `applicationId` + instance; N instances of one Application. **M** · [kernel §5](./kernel.md)
- [x] **A5.7 Lifecycle** — Extensions activate once and are never deactivated; Applications start,
      stop, restart and can rest in `failed`. **M** · [application §4](./application.md)
- [ ] **A5.8 Fault containment** — the kernel catches at every boundary it calls across and nowhere
      else; a failed Extension cascades to its consumers as one error naming the root; a failed
      Application leaves the rest untouched. **M** · [kernel §7](./kernel.md)
- [ ] **A5.9 Multiple Applications loaded, one foreground.** Background Applications stay **mounted
      and hidden** — idle, not stopped — so switching is instant and lossless. **M** ·
      [application §5](./application.md)
- [ ] **A5.10 A kernel with no Extensions is a blank page with a working process table**, and that is
      a real testable state. It is the cheapest possible check that §2's kernel/Extension line is
      actually where the code puts it. **S** · [kernel §8](./kernel.md)
- [x] **A5.11 ★ The manifest** — `layout`, `views`, `commands`, `keys`, `menus`, `settings` read off
      the constructed instance before anything activates or starts. **M** ·
      [application §2](./application.md)
- [x] **A5.12 Manifest merge and conflict resolution at load time** — two Applications claiming
      `ctrl+n` is resolved before either runs, and the palette lists commands of Applications that
      have not started. **M** · [kernel §3](./kernel.md) steps 4–5
- [x] **A5.13 Command implementations checked against declared ids** — `implement` accepts only a
      member of the literal union; a declared command with no implementation fails at start. **S** ·
      [application §2](./application.md)

### A6 — The built-ins

Shipped with the framework rather than installed. These are also the proof the contracts are usable,
because they are written against the same interfaces an outside author gets.

- [ ] **A6.1 Process manager** — built in, per the original instruction. Lists Applications, their
      instances and their state; stops and restarts them. **M** · ⛔ A5.4
- [ ] **A6.2 Application switcher** — the ordinary hotkey. **S** · ⛔ A2.8
- [x] **A6.3 ★ The workbench as an Extension — the answer is yes.** Done 2026-09-04.
      `src/workbench/extension.ts` boots through the ordinary Extension path, declares
      `needs('chrome', 'state', 'commands', 'log')`, provides `PAGE_CHROME`, and returns a
      description with a tab strip above the windows and a status bar below. **There is no `Shell`
      object, no privileged import, no reaching into the kernel and no DOM** — every affordance is a
      declared command dispatched by the page, so a tab is scriptable and bindable rather than only
      clickable, and everything it does an outside author can do.
      Getting there took three things that did not exist, and each was found by trying rather than by
      reading: `needs('chrome')` (A6.3c), a window layer in the package at all (A6.3e), and a surface
      for chrome to draw on (A6.3d). The question was worth asking exactly because the answer was
      *no* three times first.
      9 browser tests, including the two that matter: an Application running beside it declares
      `needs('windows')` and has no name for the workbench, no way to enumerate contributions and no
      path to `chrome`; and a site that installs no workbench gets the window layer at the root with
      two working windows and no chrome at all. [extension §8](./extension.md)
- [x] **A6.3c The `chrome` capability**, and the answer to A6.3's question so far: **no, not with the
      capabilities that existed.** `windows` gives a contribution `open()` and `own()`, so a workbench
      could see its own windows and nobody else's, and tabs for every window is the entire job. The
      wrong repair is handing it the `WindowManager` — that is [kernel §2](./kernel.md)'s `Shell` god
      object one layer down, the thing that gave a blog a docking system. So `needs('chrome')`,
      obeying the rules A3.1b's `credentials` established: declared and therefore visible (observing
      every window is observing every Application), narrow (a stated `ChromeWindow`, never the
      manager's own record), and **mechanics stay in the kernel** — chrome reports a drag, the kernel
      clamps it and applies the view's minimum size. 9 tests. [extension §8](./extension.md)
- [x] **A6.3c-i `closable` was decoration.** Found by the first test that asked chrome to close a
      window declared unclosable: the flag was stored, projected to chrome, and enforced nowhere, so
      any chrome could close it by asking. A flag only well-behaved callers respect is not a flag —
      and it is the exact thing [kernel §2](./kernel.md) says mechanics-in-the-kernel is *for*, since
      a broken or hostile chrome must not be able to do what an Application forbade. `close` now
      refuses; `closeOwnedBy` still does not, because the flag means *the user may not dismiss this*,
      not *this window outlives its Application*.
- [x] **A6.3e ★ The window layer belongs in the package.** Done 2026-09-04. `src/window/shell.ts`:
      `mountShell` owns one host element per window, positioned from the manager, stacked by z-index,
      shown or hidden by mode, with the view mounted once and disposed when the window goes — and
      **repositioned, never re-parented**, because re-parenting resets scroll.
      The split follows [kernel §2](./kernel.md) exactly: mechanics here, *drawing* in a `FrameChrome`
      — a function that builds the title bar, the buttons and the grip and says which elements drag
      what. `defaultFrame` is one, shipped so a site gets a working window without writing chrome and
      **replaceable**, which is the seam A6.3d plugs into.
      The harness lost 130 lines and became what it always claimed to be: a site that uses the
      framework rather than the framework's missing half.
      8 new browser tests, and the argument is made by construction — chrome is swapped for something
      sharing no class name with the default, then for something that wires nothing at all, and in
      both cases windows still move, stack, hide and close. Broken chrome can make a window look
      wrong; it cannot make one unmovable or immortal, because none of that was ever its to do.
- [x] **A6.3d Where chrome draws — built 2026-09-04.** Chrome describes the **whole page**,
      and one node in that description says where the windows go: `cx.chrome.host()`. The kernel
      mounts the window layer inside it, so chrome arranges anything it likes around the windows and
      never touches the DOM or the mounting. The two rejected shapes are recorded in
      [extension §8](./extension.md): a DOM handle (which hands over the thing [kernel §2](./kernel.md)
      says the kernel owns) and named regions like `top`/`activityBar` (which is PR #6's shell
      profiles again — a docking model baked into the framework). No chrome Extension means the
      window layer mounts at the root, which is what keeps chrome optional rather than a mode.
      The host must be unconditional, because inside a `when` it would be recreated and re-parent
      every window — and re-parenting resets scroll, the exact defect the no-remount design exists to
      prevent. A `MutationObserver` watches for exactly that and reports it, because a rule that is
      only written down is a rule someone breaks quietly.
      `mountPage` renders the chrome, finds `[data-mesh-window-host]`, and mounts the shell inside;
      chrome that produced no host is refused at boot, since a site whose chrome forgot the windows
      is broken rather than a site with no windows. The one style the framework insists on is
      `position: relative` on the host, which is mechanism and not look — absolute positioning needs
      a positioned ancestor, or every window would be placed against the viewport and sit under the
      tab strip.
- [ ] **A6.3a The Workspace Extension**, and the split A6.3 was missing. Decided 2026-09-03: **the
      IDE is an Application; the Workspace is an Extension it consumes.** §1's test gives two
      different answers — you quit an IDE and carry on, you kill a workspace and everything consuming
      it breaks — so these are two kinds of thing that this document had been calling by one name.
      The constraint that follows: an Extension is singleton and an Application has N instances, so
      the Workspace Extension **provides** workspaces rather than being one — `provides = WORKSPACE`,
      `activate()` hands back a handle per caller. A driver, not a document. **M** ·
      [extension §8](./extension.md)
- [x] **A6.4 Auth Extension** — done 2026-09-04. Holds the session, attaches the ticket, handles
      sign-in and sign-out. One per site, because the site is the boundary. **Exported, not built
      in** ([extension §7](./extension.md) files it under site-supplied): a blog that signs nobody in
      should not carry a session. A held ticket is a claim and never a session — boot asks the API
      who it belongs to, and drops it if the answer is 401. Sign-out clears locally first, so a
      network failure cannot leave a page believing it is signed in. 12 tests, and the one that
      matters is negative: an Application declaring only `needs('mesh')` sends a ticket it never saw,
      cannot read and cannot replace.
- [ ] **A6.4a The revocation event on the page.** A6.4 handles sign-in, sign-out and restore; it does
      not yet drop the session when the *API* revokes a ticket out from under it. Wants C3.4's SSE
      stream, which already closes on a revoked ticket — so this is reacting to the close, not a new
      channel. **S** · ⛔ C2
- [x] **A6.5 Notification host** — the surface `notifications` renders into, themed per site.
      **Found by a user, not by a test.** The capability worked: an Application called
      `cx.notifications.warn(...)`, the kernel recorded it, and **nothing rendered it** — so a failed
      API call looked exactly like a button that did nothing, and it was only noticed with devtools
      open. `services.notifications` is now a signal rather than a mutated array, because a record
      nothing can react to is a record nothing can show; dismissing *removes* rather than setting a
      flag nobody reads. The host lives in the harness until A6 gives the shell an Extension to put
      it in. **A sink with no surface is a silent failure, and the Application believes it reported.**
- [ ] **A6.6 Command palette** over `commands` and `keys`. **S**

### A7 — Components and theme ★

**Now on the critical path, not a later audit.** If an Application's only vocabulary is components,
then a missing component is a blocked Application — there is no `div` to fall back to
([view-layer §3](./view-layer.md)).

- [ ] **A7.1 ★ The primitive vocabulary** — audit the 13 from the deleted runtime against what a
      blog, a console and an IDE each need, together. Everybody uses the same form component with
      different styles. **M** · [view-layer §11](./view-layer.md) · ⛔ **gated by A8.2**: every
      primitive must satisfy "every action has a non-pointer path"
      ([input §3](./input.md)), which is a constraint on the audit rather than a later fix.
- [ ] **A7.2 Theme tokens as registry values**, so a site restyles without forking components.
      **S** · ⛔ A4
- [ ] **A7.3 The missing primitives** the audit names. **L**
- [x] **A7.4 How an Extension contributes components — decided 2026-09-04: both, for two different
      things.** The question asked "a fourth contract, or a plain function returning a description"
      and the answer is that one word covered two things.
      **Composition** — `Card`, `Toolbar`, a form layout — is a plain function returning a
      description, needs *nothing* from the framework, and is already typed because a function call is
      typed. An Extension hands them out through the token it provides. That is most of what anyone
      calls a component library, and the right answer is that the framework stays out of the way.
      **A new primitive** — a virtualised list (A7.6), a `Surface` (A7.5) — tells the renderer how to
      create and update an element, so it is a real contribution: a `ComponentDefinition`, registered,
      **declared in the manifest** so the kernel knows it before render, and refused at load time if
      two contributors claim one name — which `ComponentRegistry.register` already does. `mountPage`
      registering `windowHostComponent` is the framework doing exactly this today.
      [view-layer §3](./view-layer.md)
- [ ] **A7.4a `components` in the manifest**, for the second kind only. `Declarations` has no such
      field, so a contributed primitive cannot be declared and the kernel cannot know it before
      render — the one rule every other contribution follows. **S** · [view-layer §3](./view-layer.md)
- [ ] **A7.4b Typing a component reached by name.** `element('VirtualList')` compiles whether or not
      anything provides it; you find out at render. Only contributed *primitives* have this problem,
      because only they are reached by a string — composition is a function call and is checked
      already. Same problem as **A3.1d**, and it should be solved once across views, commands,
      settings and components rather than four times. **M** · ⛔ A3.1d
- [ ] **A7.5 The `dom` capability and `Surface`** — the escape hatch for Monaco, canvas and WebGL.
      Needed on day one or the IDE case is blocked, and a contribution declaring it is legibly
      opting out of isolation. **M** · [view-layer §8](./view-layer.md)
- [ ] **A7.6 List virtualisation as a component** the renderer understands. Ten thousand rows cannot
      be ten thousand nodes, and an Application cannot implement windowing if it cannot measure.
      **M** · [view-layer §11](./view-layer.md)
- [ ] **A7.7 Accessibility lives in the primitives.** If apps never write elements, the library owns
      every role, label and focus order — and an Application cannot patch around a mistake. **M**
- [x] **A7.8 ★ An intent carries its value.** *(done 2026-09-04)* **A form was impossible to write.**
      `change` fired an action carrying nothing, so what a person typed never reached the
      Application — no field, no sign-in, no search box, nothing that takes input at all. Every other
      layer was ready: `Input` was in `PRIMITIVES`, `change` was in `IntentName`, and the renderer
      bound the listener. The value simply stopped there.

      Found by A6.7 on its first screen, which is the entire argument for building a real site:
      332 tests, four typechecks and fourteen spec documents did not notice, because nothing in this
      repository had ever needed to type into anything.

      `Dispatcher.dispatch(action, value?)`, and three decisions in it. **The intent decides whether
      there is a value, not the element** — `change` means *this is now the value*, `activate` means
      *act*; a `<button>` has a `value` property that is always `''`, and letting the element decide
      would deliver an empty string to every command a button reaches. **It listens for `input`, not
      `change`** — `change` fires on blur, so a form whose button is clicked straight from a focused
      field never sees the last thing typed, which is the classic dropped password and is invisible
      to any test that dispatches events by hand. **An empty number field is `undefined`, not `0`**,
      because `Number('')` is a number nobody typed.

      Still the value and never the event: a `string`, a `boolean` or a `number`, with nothing on it
      that could reach the DOM, so a description still crosses an isolation boundary. For a command
      the value is appended to the declared arguments — `command('post.rename', slug)` on a field
      arrives as `run(slug, title)` — so a binding that gains a value does not move the arguments the
      author wrote. Six tests. **M** · [input §2](./input.md)

---

### A8 — Input ★

[input.md](./input.md). The framework owns input entirely, because an Application that never sees the
DOM never sees a `PointerEvent`. Target hardware is tablets and Steam Decks alongside desktops, so
none of this is speculative.

- [ ] **A8.1 ★ The intent layer** — `activate`, `context`, `navigate`, `commit`, `dismiss`, `scroll`,
      `zoom`. An Application receives what was meant, never what was pressed. **M** ·
      [input §2](./input.md)
- [ ] **A8.2 ★ Focus graph and directional navigation** — spatial scoring, **groups**, explicit
      overrides. Groups are the part that makes it feel designed rather than computed. **L** ·
      [input §3](./input.md)
- [ ] **A8.3 Modality as a signal** — `pointer | touch | pen | directional`, with hysteresis, so one
      component definition is correct on all of them and a Deck user plugging in a mouse switches
      mid-session. **M** · [input §4](./input.md)
- [ ] **A8.4 The renderer owns interaction feedback** — hover, press, focus movement, scroll momentum,
      drag ghosts, resize previews. None of it reaches the Application, which is also the latency
      answer for a hosted app. **L** · [input §5](./input.md)
- [ ] **A8.5 Window mechanics, including a keyboard/gamepad window-management mode.** Move and resize
      under a d-pad. Kernel, not a decoration Extension. **L** · [input §6](./input.md)
- [ ] **A8.6 Bindings across device classes** — `keys` generalises; one command reachable by chord,
      gamepad button or gesture. Profiles in the `device` hive. **M** · [input §7](./input.md) · ⛔ A4.2
- [ ] **A8.7 Normalized pointer/pen streams** as opt-in data — pressure, tilt, id. Raw input is not
      raw DOM. **M** · [input §2](./input.md)
- [ ] **A8.8 Text entry requested, not assumed** — tablet keyboard and Steam OSK; composition stays
      renderer-side and the Application receives committed text. **M** · [input §8](./input.md)
- [ ] **A8.9 The gamepad poll loop** — only while connected, stopped when hidden, dead zones and
      repeat shaping. It is battery on a handheld. **M** · [input §9](./input.md)

---

## Track B — The CDN and the builder

mesh-web's server half. **None of it exists** — no server, no builder, no `web` ServiceModule.
[hosting.md](./hosting.md).

- [x] **B0 ★ Create the packages** — `@flybyme/mesh-cdn`, `@flybyme/mesh-builder`, and the types-only
      `@flybyme/mesh-web-protocol`, under `server/`, alongside the browser package. Neither side
      depends on the other; both may depend on the protocol package precisely because it has no
      runtime. Its own tsconfig with node types, so the browser package keeps `types: []` and a node
      import there stays a compile error. [hosting §0](./hosting.md)
- [x] **B1a The `cdn` ServiceModule**, paas layout. Done 2026-09-03: domain `cdn`, binds the port in
      `onStart`, owns `site` — `site_resolve`, `site_put`, `site_list`, `site_delete`, `status` — and
      emits `cdn.site_changed`, which every node handles by dropping that hostname. Artifacts are read
      through the builder's published contracts and cached by digest, so the hop is once per file per
      node. `site` is tools rather than `defineCrud` because a collection needs a database and a CDN
      node that will not start without mongo is a worse CDN node — **B5a** is what makes it a
      collection. [service-modules §2](./service-modules.md)
- [x] **B1b The `builder` ServiceModule.** Done 2026-09-03: domain `builder`, **binds nothing**.
      `build_start`, `build_status`, and `artifact_get` / `artifact_blob` as B1c's published contract.
      A failed build is returned, not thrown, because an exception loses the log. Publishing is a call
      to `cdn.site_put` — the builder does not own `site` — and the tenant comes from the caller's
      resolved scope, never from the repository. [service-modules §2](./service-modules.md)
- [x] **B1c Who owns `artifact` — the builder**, reached through a published contract. Decided
      2026-09-03; the rule it produced is now the one all four modules follow: *a module owns what it
      writes and publishes contracts for what others need*. The hop is paid once per artifact per
      node, because an artifact is immutable and cacheable forever.
      The recommendation this replaces was `cdn`, to save the read path a hop; the hop is what a
      boundary *is*, and an immutable artifact makes it cheap. [service-modules §2](./service-modules.md)
- [x] **B2 ★ The builder.** Fetch, build, publish. Both defects the previous generation had are now
      unrepresentable rather than merely avoided: **source is a `SourceRef`**, so a build gets a
      scratch workspace the builder creates and destroys and can therefore run anywhere; and **an
      artifact is content**, files named by their path *inside* the artifact and addressed by digest,
      so nothing names the machine that built it. Both have a test asserting the shape stays that way.
      Cached by input hash over the resolved commit, environment, frozen policy and builder version —
      and it **refuses to hash a branch**, because `main` hashes to itself while the code moves and a
      cache keyed on it serves stale content forever, which is worse than not caching.
      Blobs are shared between artifacts by digest, so a one-file change stores one blob.
      [hosting §6](./hosting.md)
- [ ] **B3 Build policy injection** — the build is where `system` hive policy and lock decisions are
      baked in. **S** · ⛔ B2, A4.7
- [x] **B4 The CDN server** — plain HTTP, no TLS, behind the proxy. Resolve, serve, and nothing else:
      a POST is a 405, because the API is the only security boundary and a CDN accepting writes would
      be a second one. Hashed assets are immutable, entry documents are `no-cache` (or a deploy never
      reaches anyone), and the digest *is* the ETag. A deep link falls back to the entry document so a
      client-routed Application works — but **a missing asset 404s**, because serving HTML for a
      missing `.js` produces "Unexpected token '<'" and nothing that says what happened.
      [hosting §1, §2](./hosting.md)
- [x] **B5 Hostname resolution**, with a local cache. Misses are cached too — otherwise a node asked
      repeatedly for an unconfigured hostname does the mesh's work for whoever is asking — and
      concurrent requests for a cold hostname share one lookup. Invalidated by the deploy event, with
      a TTL behind it, because **the mesh delivers at-most-once** ([auth §3.1](./auth.md)) and that is
      as true here as it was for revocations. The record still needs to be a mesh collection (B5a).
- [x] **B6 Never serve two tenants from one hostname.** Checked on the path that *serves*, not assumed
      by the path that configures, and answered **404 rather than 403**: which tenant owns a hostname
      is not something an anonymous request gets to learn. Found while testing: a node reachable
      directly must not trust `x-forwarded-host`, or the origin becomes the caller's choice — so
      trusting it is a deployment option, not a default. [hosting §3](./hosting.md)
- [x] **B7 Any node can serve any site.** An artifact is fetched once and kept forever, safely,
      because a digest can never name different content. Content this node cannot reach yet is a
      **503, not a 404** — the hostname is configured and the answer exists somewhere, so blaming the
      caller would be wrong. A cold cache is slower, not wrong. [hosting §4](./hosting.md)
- [ ] **B5a `site` as a mesh CRUD collection**, replacing the injected `SiteSource`. The interface is
      the seam; this is the implementation behind it. **S** · [hosting §7](./hosting.md)
- [x] **B8 The deployment descriptor** — done 2026-09-03. `mesh-web.json` in the site's own repo:
      application, environments, and per environment a host, an api, a policy and a build. The builder
      reads it out of the workspace it fetched, so a build says *"production of this ref"* and cannot
      say what production means — the same decision C3.2 made for exposure. Two things are deliberately
      absent: **the tenant**, because a repo that could name its own owner could name someone else's,
      and anything about a filesystem. Consequence: the input hash is not knowable until after the
      fetch, since the policy is in the source. [hosting §5](./hosting.md)
- [ ] **B8b ★ `mesh.json` — the descriptor a whole product declares.** Decided 2026-09-04, and it
      supersedes the shape B8 built the same day. `mesh-web.json` becomes **`mesh.json`**, because a
      repo that contains a service module as well as a UI is not described by a file named after the
      UI. Four changes: **build moves out of the environments** (it was duplicated verbatim across
      `production` and `local` in mesh-web's own descriptor, which is the drift smell appearing in the
      format's first user); **`service` and `ui` are both optional**, so the file grows the way
      [hosting §0a](./hosting.md) says the stack grows; **`service.entry`** finally keeps B8's promise
      about the exposure list, which cannot be JSON because an entry references a real contract — but
      naming the module that declares it lets a build call `describeExposure()` with no cluster
      running; and **`service.domains`** says what the repo provides without running it.
      Explicitly **not** runtime configuration: `api` is the URL the browser calls, not a bind port,
      and the descriptor's defining property is that a *build* reads it with no cluster up. **M** ·
      [hosting §5](./hosting.md)
- [ ] **B8a ★ Serving a production hostname in development.** *A site is a hostname*
      ([hosting §2](./hosting.md)) — which is right, and makes local development awkward in a way
      nothing has yet addressed: a browser on `localhost:8080` sends `Host: localhost:8080`, and
      **nobody controls what hostname a developer's browser sends.** The port is already handled
      (`normalizeHostname` strips it), so `localhost` resolves; what does not work is serving
      *`console.surfdns.net`'s own artifact* locally, which is the thing you actually want to look at.
      Three shapes, and the third is the one to build:
      **A second `local` environment in the descriptor** — what `mesh-web.json` does today. It works
      and it is wrong as a general answer: the production environment is the one under test, and a
      parallel entry is config that drifts from it silently.
      **`trustForwardedHost`** — already exists, and is for the real proxy. Turning it on locally
      makes the origin a caller's choice, which §3 spends a paragraph refusing.
      **A dev alias map on the CDN node** — `{ 'localhost': 'console.surfdns.net' }`. The site record
      stays production's, the descriptor stays honest, and the deviation is one line that names
      itself. It must be **refused when `tenantId` is set** and must never be reachable from a
      deployed node's config, because an alias is by construction a way to serve one hostname's
      content under another — exactly what B6 exists to prevent. **S** · ⛔ nothing
- [ ] **B9 Artifact storage and cache invalidation** across nodes. **M**
- [ ] **B10 Build triggers** — push, manual, promotion between environments. **M**
- [ ] **B11 Per-tenant quotas and abuse handling.** ⛔ genuinely open: a per-node limit is ten times
      the limit; a global one is a shared counter in the hot path. **M** ·
      [hosting §3](./hosting.md)
- [ ] **B12 `web` module operational surface** — what this node is serving, which builds are current,
      what failed. **S**

---

## Track C — The API and identity

Two components, **neither of which exists**. mesh-identity was never written; mesh-api was written
and then deleted rather than ported, because it was never a fixed point — mesh-web leads and mesh-api
is built against these specs. [auth.md](./auth.md).

### C1 — mesh-identity

- [x] **C1.1 ★ The `identity` ServiceModule.** Done 2026-09-03 as a module in its own repo
      (mesh-identity): domain `identity`, **no listener** — an identity module that bound a port
      would be a second front door to the thing everything else authenticates through. Schemas and a
      store for `user`, `organization`, `membership`, `role`, `grant`, `apiToken`, `ticket` and
      `revocation`. Roles are records with a required `scope`, which makes surfdns #26 structurally
      impossible. 36 tests. [service-modules §2](./service-modules.md)
- [ ] **C1.1a CRUD contracts over those collections**, and `team`. C1.1 built the schemas, the store
      and the tools that authentication needs; what is not there is a way for an *operator* to list
      users or add a membership over the mesh, because nothing yet needed one. `defineCrud` wants a
      database, so this arrives with the mongo-backed store rather than the in-memory one. **M**
- [x] **C1.2 Ticket issue / validate / revoke.** Done 2026-09-03. Tickets are **opaque**, which is
      the whole point: nothing is signature-verified, so **there is no signing key** to distribute or
      rotate. Validation reads roles from the *user* rather than the ticket, so a role granted since
      it was issued applies and one removed stops applying — a ticket is identity, not authority.
      Revoking a principal writes one revocation row rather than one per ticket, which also covers a
      ticket issued a moment later. [auth §1, §3](./auth.md)
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
- [x] **C1.9 Checked the mesh's actual delivery guarantees.** Verified 2026-09-04, and **the
      assumption was wrong**: `TCPTransport.publish` writes to peers connected and authenticated at
      that instant, with no acknowledgement, retry, queue or persistence, and `MeshNetwork.publish`
      swallows the failure so the emitter is not told either. **At-most-once**, not at-least-once.
      An instance that was down when a revocation was emitted never receives it.
      Recorded as [auth §3.1](./auth.md), which inverts §3: the TTL is the mechanism and the event is
      a latency optimisation. Fixed by **pull for correctness, push for latency** —
      `identity.revocations_since(epoch)`, polled and on reconnect, which is at-least-once by
      construction and needs no change to `mesh`.
- [ ] **C1.9a `revocations_since(epoch)`** — the monotonic epoch, the change list, and the API-side
      poll. This is what makes revocation correct rather than likely. **M** · [auth §3.1](./auth.md)
- [ ] **C1.10 mesh-identity stands alone.** It is a foundation for any project needing an API and a
      web front with identity — no surfdns import, ever. Enforce with a dependency check in CI.
      **S** · [auth §2](./auth.md)

### C2 — The API as gatekeeper

- [x] **C2.1 ★ Validate on first sight, cache, invalidate by event.** Done 2026-09-03: one mesh call
      per (ticket, instance), not per request, verified against a real mesh-identity rather than a
      validator that recognised a string. **And a poll beside the event**, which is C1.9's finding
      applied — the mesh delivers events at-most-once, so an instance that was down when a ticket was
      revoked never hears about it. `revocations_since(epoch)` cannot be missed, only delayed; the
      event is what makes the common case immediate. [auth §3, §3.1](./auth.md)
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

- [x] **C3.1a The exposure descriptor.** `describeExposure()` turns a site's exposure list into JSON a
      build can read with no cluster running — JSON Schema shapes, a gate per call, and a hash that
      identifies the exposure rather than the file. Six mistakes fail the build: an ungated entry, two
      gates on one entry, an `internal` contract, a duplicate, a route collision, and a schema that
      cannot be described. 14 tests. **This is what A3.1a-ii reads.**
- [x] **C3.1b The `api` ServiceModule itself.** Registers with a real `MeshApp`; `onStart` binds the
      port and validates the exposure, so a bad exposure is a module that failed to start rather than
      a node quietly serving a surface nobody intended. `api.status` and `api.routes` answer over the
      mesh. Ticket validation is a real call to `identity.ticket_validate`, and the resolved scope
      reaches a handler as `ctx.meta.user.tenant_id` and confines its result. Tested against an actual
      MeshApp with a second real ServiceModule beside it — everything before this ran against a `Map`.
- [x] **C3.1c The `exposure` collection** as the resolved cache C3.2 describes. **A row is about a
      process, not an application** — keyed by `(application, nodeID)`, so a rolling deploy is
      *visible* as rows that disagree rather than hidden by whichever instance booted last
      overwriting the others. `exposureConsensus()` turns that into "is this deploy finished?".
      Off by default, because recording needs a database and a listener that will not start without
      mongo is a worse listener; a failed write is logged, never thrown. Verified against a real
      mongo: the row lands, a restart updates rather than duplicates, two instances make two rows.
- [x] **C3.2 Exposure is the site's repo descriptor.** Decided 2026-09-03: the site's repository is
      the source, and the API's `exposure` collection is a resolved cache filled at boot. A list owned
      elsewhere drifts open, because nobody deleting a screen closes the route it used. Consequence:
      the client generator reads a file, needs no running cluster, and changing exposure is a deploy.
      [service-modules §2](./service-modules.md)
- [x] **C3.3 REST from contracts.** One route per exposed contract, and the route comes from the
      contract's own `rest` metadata — so the path the browser calls and the path the server serves
      have one source. Query input is coerced toward what the contract declares, because HTTP has one
      type and contracts have many. A route collision or an ungated entry fails at mount rather than
      per request. [hosting §4](./hosting.md)
- [x] **C3.4 SSE from events.** Done, with spec/network.md §5.1 — scope is declared per event, an
      event that cannot be scoped is delivered to nobody, and a revoked ticket closes the stream.
      The archive delivered an unscopable event to every subscriber in every organization.
- [ ] **C3.5 WebSockets**, the third named interface. **M**
- [ ] **C3.6 Addressing is a deployment choice.** A process may have its own URL; nothing may assume
      sticky routing or require a load balancer. **S** · [hosting §4](./hosting.md)
- [x] **C3.7 Close the stale branches and PRs.** Done 2026-09-03: PR #5 closed with the reason, both
      stale branches deleted. Their commits stay reachable through `refs/pull/N/head`, and #5's
      finding survives as A1.4.
- [x] **C3.8 Generated typed client.** Done as A3.1a-ii — it lives in mesh-api because this package
      sets `types: []` and a file-writing generator cannot compile here. surfdns #15 is answered:
      structural types, no `z.infer` across a package boundary.
- [ ] **C3.9 Keep issue #7 fixed.** The task switcher hotkey bug is the one finding carried out of the
      deleted code; it is A1.4, recorded here so mesh-api's issue can be closed against it. **S**

---

## Track D — surfdns and the console

**surfdns requires complete rework.** Five of its packages depend on `github:FLYBYME/mesh-api`, which
is now an empty repository, and its console imports `@flybyme/mesh-api/runtime`, which is gone. This
is accepted, not a regression to repair — but it means Track D is a rewrite against the finished
framework, and nothing here should start before A5 and A2.

- [x] **D.1 The schema boundary is decided: a generated typed client.** The four symbols
      (`WhoamiOutputSchema`, `MembersOutputSchema`, `NodeStatusOutputSchema`, `roleSatisfies`) come
      from the generated descriptor rather than from surfdns.
      [network §7](./network.md) · depends on A3.1a
- [ ] **D.2 Make surfdns-console a real package** — `package.json`, tsconfig, CI. **S**
- [ ] **D.3 Port the six screens** off `defineApp` and `LayoutConfig` regions onto Applications and
      views. **M** · ⛔ **A3.3 `commands`, A3.5 `menus`, A3.6 `notifications`, A3.7 `models`, A7.1
      the vocabulary** — corrected 2026-09-04. It previously read `⛔ A5.1, A2`, both of which are
      done, so this looked startable. It is not: a console is exactly the thing that needs the
      capabilities M4 has not built, and starting it early would mean writing six screens against a
      vocabulary that is about to be audited.
- [ ] **D.4 Console deployment descriptor** — production host, production API, other environments.
      **S** · ⛔ B8
- [ ] **D.5 Remove the UI from surfdns.** No longer a coordinated migration — the thing it imported is
      deleted, so this is removal, not a cutover. **M**
- [ ] **D.6 Repoint surfdns's five packages** off `github:FLYBYME/mesh-api`. They will not install
      until this is done and mesh-api is rebuilt. **M**
- [ ] **D.7 Actually look at it.** Nobody has ever seen the console's header and footer render.
      Everything typechecks and builds; nothing has been witnessed. **S**
- [ ] **D.8 surfdns #26** — nobody can be a platform operator. Blocks the `admin` role. **M**
- [ ] **D.9 surfdns #35** — `node.status` is public and leaks `bootstrapCredential`. This is the
      node-credential bootstrapping problem from [auth §9](./auth.md), already visible in production
      code. **S**

---

## Milestones

Four checkpoints, each a thing you can look at rather than a percentage.

**M0 — It builds again.**
A0
*A package, a typecheck, a test run, reactivity and DOM.* Nothing visible; the floor.

**M1 — A window you can drag.**
A1 · A2.1 · A2.2 · A2.6 · A5.1 · A5.2
*One Application, constructed from a class, in a window that moves and resizes.* This is the first
point where the design stops being prose.

**M2 — Two modes, no remount.**
A2.3 · A2.4 · A2.5 · A2.7 · A2.8 · A3.4 · A4.1–A4.4 · A6.2
*A blog in tiled mode; hit the hotkey; the header, sidebar and footer become windows; scroll position
survives.* This is the demo that proves the central claim.

**M3 — A site served from a hostname.** ✅ **2026-09-04** *(one process, four modules)*
B0 · B1a · B1b · B1c · B2 · B4 · B5 · B6 · B8 · C1.1 · C1.2 · C2.1 · A3.1 · A6.4
*Push a repo, mesh-web builds it, `console.surfdns.net` serves it from any CDN node, and signing in
issues a ticket the API validates once and caches.* End to end, one site.

All fourteen are built and both halves run for real:

- `test/server/deploy.test.ts` — a real git repository, a real `MeshApp` with the builder and CDN
  registered, a real clone, a real `sh -c` build, a real port, a real `Host` header. The hostname and
  the application name are never passed in; they come out of the repo's own descriptor.
- mesh-api's `test/identity-integration.test.ts` — a real sign-in against a real mesh-identity, one
  validation per (ticket, instance), and a revocation that lands by poll as well as by event.

- `test/server/gated-deploy.test.ts` — **all four modules in one process** (C2.1a). A deploy is a
  POST from outside, gated by the API, carrying a ticket identity issued; the tenant on the resulting
  site record is the organization that ticket resolved to.

- [x] **C2.1a One process, all four modules.** Done 2026-09-04, and it found two things that no
      single-module test could.
      **One:** the builder read `input.tenantId ?? scope`, handing straight back the override
      [auth §6](./auth.md) and mesh-api's own gate both forbid — an authenticated caller could
      publish a hostname under another organization by typing its id, and B6 would not catch it,
      because B6 checks a site's tenant against the *node's*, not against whoever deployed it. The
      order is now inverted and a disagreement is an error rather than a silent preference. It is
      also settled **before** the fetch: the check can only fail and depends on nothing the build
      produces, so running a stranger's build command first in order to tell them no is work done for
      an answer already known.
      **Two:** every builder contract was `internal`, so a deploy could only come from inside the
      cluster and M3's "push a repo" had no door. See C2.1b.
- [x] **B2a ★ It serves a real bundle.** Done 2026-09-04. Everything the CDN had served until now
      came from a two-line `build.sh` in a test fixture, and "the pipeline is file-type agnostic so a
      real bundle cannot differ" is the shape of claim this project keeps disproving. So
      `scripts/deploy.mjs` builds **this repository** through the real builder — a real clone of a
      real commit, a real compile — and serves the harness from the real CDN. It does. The framework
      is served as ES modules the browser resolves itself: `/framework/**` from `dist`, `/app/**` from
      `browser/dist`, immutable caching on the modules, `no-cache` on the page, a deep link falling
      back to `index.html`, and a missing asset still 404ing rather than being handed HTML.
      A script rather than a test, deliberately: a truthful build needs the network and takes a
      minute, and a unit suite that did that is a unit suite nobody runs.
      **The first attempt failed, and the failure was the point.** `npm ci` in the clone died on
      `file:../mesh-api` and `file:../mesh-identity` — devDependencies that resolve only on the
      machine this repo happens to sit on. A build from a clone found in twenty seconds what no
      amount of local testing would ever have shown, which is exactly [hosting §6](./hosting.md)'s
      first defect wearing new clothes: *the code must not have to be local to the server.* The site
      build installs nothing from `package.json` at all — `npx -p typescript tsc` and nothing else,
      which works because the package has **no runtime dependencies**. B2b then fixed the underlying
      defect rather than only the symptom.
- [x] **B2b The `file:../` devDependencies.** Fixed 2026-09-04, one directory up as well. B2a routed
      around them by building the site with a standalone `tsc`; this is the actual repair, because
      anything that installs normally — CI, a contributor, a second builder strategy — still hit it.
      mesh-api and mesh-identity are now **git refs**, which is how `@flybyme/mesh` was always
      installed here, and each gained a `prepare` script: `dist/` is not committed, so a git install
      would otherwise yield a package whose `main` points at a directory that was never built — a
      failure at *import*, saying nothing useful when it arrives. mesh-api had the same defect inside
      it, pointing at `file:../mesh-identity`.
      Verified the way the original was found rather than by inspection: a fresh `git clone`,
      `npm ci`, 298 tests green. The site build still uses the standalone `tsc`, which is not a
      workaround any more but the right thing — a site needs a compiler, not 282 packages including
      a browser driver.
- [x] **C2.1b Which builder contracts the world may reach.** Decided 2026-09-04, and the line is
      drawn by *what a caller can name*. `build_start` and `build_status` are `public`: they name a
      repository, an environment, or builds — the repo supplies the rest and the caller's scope says
      who owns it. `artifact_get` and `artifact_blob` stay `internal`: they name a **digest**, and a
      digest belongs to nobody, so anyone who could guess one would read another tenant's content.
      `cdn.site_put` stays internal for the same reason — it names an arbitrary artifact digest, so
      exposing it would let a caller point their own hostname at somebody else's build.
      `visibility: 'public'` means *may be exposed*, never *unauthenticated* (C2.6).

**M4 — An outside author can write an Application.**
A3 (the remaining capabilities) · A6.1 · A6.2 · A6.6 · A7 (all) · A0.6
*Someone who is not the author of this framework builds a real screen without reaching past it.*

> **The exit criterion is a real site that is not the harness.** Sharpened 2026-09-04:
>
> > "mesh-web is not usable until all the 'harnesses' are removed and it runs through the mesh system"
>
> The harness is a fake where it matters — a `memoryTransport`, an in-page copy of the API, chrome
> drawn by hand, a dispatcher going nowhere. It is a *controlled* environment, which is why the
> browser tests live in it and why it is not being deleted. But as a demonstration it is circular:
> the framework's only consumer lives inside the framework's own repository and can reach past the
> package whenever that is convenient. **That is how `Chrome` stayed unexported for a day** while a
> file arguing no privileged access was needed used privileged access to say it.
>
> So M4 is done when **M3's modules are running with a real site on top of them** — its own repo,
> consuming the package as a dependency, using `WorkbenchExtension`, talking to a real mesh-api with
> real identity, built by the real builder, served by the real CDN under a real hostname. No in-page
> anything.
>
> **And the cold agy run is how that site gets written.** Set an agent with no context on this project
> the task, and whatever it cannot do is what M4 still owes; whatever it invents is what the types
> failed to forbid; whatever it asks is what the documentation failed to say. The test fixture and the
> demonstration turn out to be the same artifact, which is why neither is worth building separately.
>
> This is a better test than the checklist above because **I am the worst possible judge of whether
> this framework is usable** — I know where every seam is and would route around a missing export
> without noticing. A cold agent has no such reach and cannot be polite about it.
>
> The first run is expected to fail badly, and **its failures are the requirements document.** Run it
> before deciding what A3 and A7 owe, not after.

- [ ] **A6.7 ★ The first real site.** Its own repository, **one repo and two packages** — a service
      half and a UI half — which is [hosting §0](./hosting.md)'s layout one level down: if the
      framework needed that split, every product built on it needs the same one, and the framework
      should ship the shape rather than have each site reinvent it.
      One repo, not two, because a product's service module and its UI ship together, version
      together, and the UI's exposure descriptor names the very contract the module implements.
      Splitting them recreates precisely the drift C3.2 and B8 exist to prevent: the site's repo is
      the source of truth for what it exposes and where it runs, and that only holds if there is one
      repo to be the source. **L** · ⛔ A6.8, A6.9
- [x] **A6.8 Make `@flybyme/mesh-web` installable.** *(done 2026-09-04)* The same defect B2b fixed
      one repository over: `dist/` is gitignored and there was no `prepare` script, so
      `npm i github:FLYBYME/mesh-web` yielded a package whose `main` pointed at a directory that was
      never built. **Nobody could consume the framework**, which was a real gap independent of any
      test, and the first wall a cold run hits. One line — `"prepare": "npm run build"` — and an
      install from a git ref now produces a built `dist/`, resolvable by name, with **no runtime
      dependencies at all**: `src/` imports nothing outside itself, so a consumer adds one package
      and pulls in nothing else. **S**
- [ ] **A6.8a Installing the framework costs a full development install.** Measured 2026-09-04:
      `npm i git+file:///…/mesh-web` into an empty project takes **~75 seconds** to deliver a
      1 MB, zero-dependency package. The cause is structural, not incidental — npm cannot run
      `prepare` without first installing every `devDependency`, so a consumer builds playwright,
      vitest, jsdom and three git-ref mesh packages (each with a `prepare` of its own) in order to
      run one `tsc`. **The package that ships has none of that in it.**

      It matters because it is paid by exactly the person A6.7 is about: someone starting a site who
      has not yet seen the framework do anything, on the slowest, least explicable step. Three
      directions, none obviously right: split the browser test rig into its own package so `prepare`
      needs only typescript; publish real tarballs so there is nothing to build on install; or
      commit `dist/`, which the `.gitignore` comment argues against on principle and which would
      still be the fastest. Decide it against a measurement, not a preference. **M**
- [x] **A6.9 The public entry must be complete.** *(done 2026-09-04)* Proved incomplete on
      2026-09-04 — `Chrome`, `ChromeWindow` and `Credentials` were never exported, so the workbench
      could not have been written by an outside author at all. Such gaps **cannot be found by
      reading**: what finds them is a project importing only the package name and typechecking,
      where a compile error *is* the test. That is now `npm run check:consumer` — it packs the
      package as npm would, installs the tarball into an empty project, and compiles
      `browser/harness.ts` and `browser/workbench.ts` against it. Both compile clean, and the
      `exports` map already present is verified to refuse `@flybyme/mesh-web/dist/kernel/kernel.js`
      at both the type level and at runtime (`ERR_PACKAGE_PATH_NOT_EXPORTED`), which is D6's boundary
      enforced rather than asserted.

      Why a separate check rather than the compilers already here: `tsconfig.browser.json` maps the
      package name with `paths` and the browser test config aliases it to `src/index.ts`. Both prove
      the *entry* is complete; **neither can see the packaging around it**, and a package npm
      assembles wrongly compiles perfectly under a `paths` mapping. `prepare` running, `files` not
      dropping a declaration, and the `exports` map holding all live in that blind spot. It takes
      about a minute, so it is not part of `npm test` — run it before anything outside this repo
      depends on the package. **S**
- [ ] **A6.10 The boot ceremony.** Starting a page today means `new Kernel()`, replacing
      `services.windows` with a `windowSink`, building a component registry, wiring a dispatcher to
      the command table, `boot([...])`, `mountPage(...)`, then `start(...)` — about sixty lines in the
      harness, identical for every site, and a third party will copy it slightly wrong. The answer is
      probably a `createSite()` that does the ordinary thing with every piece overridable, which is
      `defaultFrame`'s shape. **Deliberately deferred until after the first cold run**, because agy
      flailing at this will say more about the right API than I will. **M** · ⛔ A6.7
- [ ] **A6.11 A getting-started document.** `spec/` is fourteen documents arguing *why*; none of them
      says how to write an Application, and the only worked example is a 787-line harness that also
      contains a fake API, a memory transport and a status rail. It begins **"you have a process
      running mesh"**, not "install this package" ([hosting §0a](./hosting.md)).
      **Deliberately written after the cold run, not before** — a guide written first is a guess about
      what is confusing. **M** · ⛔ A6.7

**M5 — It proves itself.**
A6.3a · B7 · B9–B12 · C1 (all) · C2 (all) · C3.5 · C3.6 · Track D
*The console ported; surfdns's UI deleted; many sites, many owners, ten CDNs and ten APIs.*

> **M4 and M5 were one milestone until 2026-09-04**, called *the framework proves itself*, and the
> name hid a gate. It contained six unwritten capabilities (`events`, `commands`, `menus`,
> `notifications`, `models`, `log`) and the whole of A7 — the primitive vocabulary, which `PRIMITIVES`
> itself calls *"a first cut, not the audit"*, and which A7.7 makes load-bearing: **if Applications
> never write elements, the library owns accessibility.** None of that is proof; it is the framework.
>
> The gate it hid runs through **D.3**, *port the six screens*. Its blockers read `A5.1, A2`, both
> long done, so it looked startable — and it is not, because a console needs commands, menus,
> notifications, models and a settled vocabulary. Proving the framework on a real site cannot precede
> finishing the parts that site would use, and a milestone list that implies otherwise will send the
> work in the wrong order.
>
> **A6.3 was the exception and belonged where it was**: the workbench needed windows and chrome and
> nothing from A3 or A7, so it could answer the design's load-bearing question early. That it landed
> before any of this is a good sign about the split, not a contradiction of it.

---

## What this list does not cover

- **The IDE.** "VS Code for general web pages" is what the framework is *for*; A6.3 is the test that
  it can be built, not the building of it.
- **mesh itself.** Nothing here needs new framework in `mesh` except C1.9, which is a question rather
  than a change.
- **The crypto trading platform**, or anything else that comes later. If the framework is right, they
  are Applications.
