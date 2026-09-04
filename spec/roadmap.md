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

- [ ] **A3.1 ★ `net`** — the HTTP abstraction over a site's API. Base URL from the deployment
      descriptor, ticket attached by the auth Extension, not by each caller. **Fully typed**:
      `cx.net.call('credential.resolve', { id })` infers input and output exactly as mesh's
      `ctx.call` does. **L** · [network.md](./network.md) · [hosting §4](./hosting.md)
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
- [ ] **A3.3 `commands`** — registration, invocation, argument typing, the palette's data source. **M**
- [x] **A3.4 `keys`** — binding resolution, sharing one parser with A1.4. `bindingTable()` answers
      both directions: a keypress to a command, and a command to its bindings so a menu can show the
      shortcut without anybody writing it twice. **Reserved bindings are enforced here**
      ([input §7.1](./input.md)): the manifest refuses one the host takes first and reports it as a
      load-time conflict, because a binding that fires the command *and* opens a browser window
      looks like it worked. The reserved set is a parameter — a tab loses `ctrl+n`, a kiosk loses
      nothing — not a constant.
- [ ] **A3.5 `menus`** — menubar, window, status and `context:*` targets. **M**
- [ ] **A3.6 `notifications`** — baked in, identical for a blog, a console and an IDE. Info, warning,
      error, progress, actions, and a handle that can be updated and dismissed. **M**
- [ ] **A3.7 `models`** — typed collections over a site's CRUD contracts, reactive. **L**
- [ ] **A3.8 `windows`** — see A2.6.
- [ ] **A3.9 `storage`** — see A4.
- [ ] **A3.10 `log`** — scoped, level-filtered, and shippable. **S**

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
- [ ] **A6.3 The workbench as an Extension.** The load-bearing test of the whole design: if the IDE
      shell cannot be written as an ordinary Extension over the window manager, the capability split
      is wrong and better to learn it here. **L** · ⛔ A2, A3
- [ ] **A6.4 Auth Extension** — holds the session, attaches the ticket, handles sign-in and the
      revocation event. One per site. **M** · ⛔ C2
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
- [ ] **A7.4 How an Extension contributes components** — a fourth contract, or a plain function
      returning a description. Undecided. **M** · [view-layer §3](./view-layer.md)
- [ ] **A7.5 The `dom` capability and `Surface`** — the escape hatch for Monaco, canvas and WebGL.
      Needed on day one or the IDE case is blocked, and a contribution declaring it is legibly
      opting out of isolation. **M** · [view-layer §8](./view-layer.md)
- [ ] **A7.6 List virtualisation as a component** the renderer understands. Ten thousand rows cannot
      be ten thousand nodes, and an Application cannot implement windowing if it cannot measure.
      **M** · [view-layer §11](./view-layer.md)
- [ ] **A7.7 Accessibility lives in the primitives.** If apps never write elements, the library owns
      every role, label and focus order — and an Application cannot patch around a mistake. **M**

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

- [ ] **C1.1 ★ The `identity` ServiceModule.** CRUD `user`, `organization`, `membership`, `team`,
      `role`, `grant`, `apiToken`, `ticket`. **L** ·
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
      views. **M** · ⛔ A5.1, A2
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

**M3 — A site served from a hostname.** *(one process, four modules)*
B0 · B1a · B1b · B1c · B2 · B4 · B5 · B6 · B8 · C1.1 · C1.2 · C2.1 · A3.1 · A6.4
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
