# Applications

A process.

**Status.** The contract is **Decided**; instances, foreground semantics and routing are
**Proposed**.

Companions: [the model](./README.md) · [the kernel](./kernel.md) · [Extensions](./extension.md) ·
[hosting](./hosting.md).

---

## 1. An Application is a process — **Decided**

Not a screen, not a destination — a process. It may have views. It may equally be **headless**: a
background process that does its work and is reached through its API.

This reverses something the deleted code had: `Application.surfaces` was **required**, on the
argument that "a destination that appears nowhere is not a destination". The argument was wrong,
because an Application is not a destination. A daemon with no window is a perfectly ordinary thing
for an operating system to run.

> **`surfaces` is optional, and there is no construct-time guard demanding a view.**
> [roadmap A1.1](./roadmap.md)

What an Application has instead of a required view is an identity and, usually, an API. A headless
Application that provides nothing and shows nothing is the degenerate case, is allowed to exist, and
simply does not do anything.

**More than one Application runs at a time. One is in the foreground.** A hotkey switches between
them ([the model §6](./README.md)).

---

## 2. The bundle contract — **Decided**

Same shape as an Extension: **a bundle `export default`s a class, and the host constructs it.**

**An Application is a manifest with code attached.** Almost everything about it is declared as data;
`start()` holds only the logic.

```ts
export default class ConsoleApp implements Application<typeof NEEDS, typeof CONSUMES, typeof CONSOLE> {
    // ---- what it needs
    readonly needs    = NEEDS;
    readonly consumes = CONSUMES;
    readonly provides = CONSOLE;

    // ---- what is shown
    readonly layout   = tiles({ ... });      // named regions, a split tree — §6
    readonly views    = [ ... ];             // view types that fill them — §6

    // ---- what can happen
    readonly commands = [ ... ];             // ids + titles; bodies come from start()
    readonly keys     = [ ... ];             // default bindings, overridable by the user
    readonly menus    = [ ... ];             // menubar, window, status, context

    // ---- how it is configured
    readonly settings = [ ... ];             // schema + defaults, read at boot

    // ---- the logic, and only the logic
    async start(cx): Promise<ConsoleApi> { ... }
    async stop(): Promise<void> { ... }
}
```

### Why declared and not registered — **Decided**

> "we must define views but i think things like commands and keys. and you can also include things
> like the registry with app config/defaults"

One rule covers all of it:

> **Anything the kernel needs before the Application runs must be declared, not registered.**

Run that test over what an Application would otherwise do imperatively inside `start()`:

- **commands** — the palette must list what an Application can do *before* it is running, or you
  cannot invoke an Application into existence.
- **keys** — a binding must fire when the Application is not started. And bindings created by calling
  `cx.keys.bind()` **can never be rebound by the user** without the Application's cooperation. As
  data, the registry overrides them. That alone settles it.
- **menus** — same argument.
- **views and layout** — the kernel restores geometry at [boot step 9](./kernel.md) and starts
  Applications at step 10, so it must already know what tiles and views exist and what they default
  to, or every window appears at a default position and jumps. §6.
- **settings** — hard-forced. Declared defaults are folded into the registry at
  [boot step 5](./kernel.md); the Application starts at step 10. A default that arrives at step 10 is
  five steps too late.

Two things follow for free. **Conflict detection moves to load time** — two Applications claiming
`ctrl+n` is resolvable before either runs. And **an Application can be inspected without executing
it**, which the process manager and any gallery of installable Applications both require.

This is the shape VS Code's `contributes` block has, and for the same reason: a shell must reason
about an extension it has not run. Where this design diverges from VS Code is elsewhere — no
activation events, no `deactivate` ([Extensions §6](./extension.md)), and no `Shell` god object.

### Where a command's body lives — **Proposed**

A declared command is an id and a title. `start()` supplies the implementation, and the ids are
checked against the declaration:

```ts
type CommandId = ConsoleApp['commands'][number]['id'];   // a literal union
cx.commands.implement('console.reload', () => { ... });  // only a declared id compiles
```

Same trick as the view ids in §6. A typo is a compile error; a declared command with no
implementation fails at `start()` rather than the first time someone presses the key.

This is also the answer to handler identity across an isolation boundary
([view-layer §5](./view-layer.md)) — one mechanism, because it is the same problem twice.

The reasoning behind the class-export model, `needs` narrowing and provider tokens is identical to
[Extensions §2 and §4](./extension.md) and is not repeated — including why it is `needs('net', ...)`
rather than `['net', ...] as const`, which was checked against a typechecker and is recorded there.

---

## 3. Instances — **Proposed**

**One Application, N instances.** Two console windows, two chart windows, two editors on different
files.

This is the requirement that killed the previous model outright: `defineApp({ id })` put identity in
the code, one definition meant one instance, and a window manager whose whole point is two chart
windows cannot use that.

So identity is a pair:

- **`applicationId`** — from the manifest, stable, the same for every instance.
- **`pid`** — assigned by the kernel per instance ([kernel §5](./kernel.md)).

Everything instance-scoped keys on `pid`: application state, window ownership, storage namespace, log
scope. Everything Application-scoped keys on `applicationId`: settings, the deployment declaration,
what the process manager lists.

**Whether an Application permits multiple instances is its own declaration** —
`readonly singleton = true` for something that genuinely cannot be duplicated. Default is multi, and
the default is the interesting case.

---

## 4. Lifecycle — **Proposed**

Unlike Extensions, which are installed and never deactivated ([Extensions §6](./extension.md)),
Applications start and stop. That is the distinction.

```
constructed → starting → running → stopping → stopped
                  ↓          ↓
               failed     failed
```

- **`start(cx)`** may be async, and returns the Application's API. Until it resolves the instance is
  `starting` and has no windows.
- **`stop()`** may be async. The kernel disposes the instance's capabilities regardless of whether
  `stop` succeeds or throws — windows, commands, bindings and subscriptions go with it. `stop` is for
  the Application's own concerns: flushing a draft, closing a stream cleanly.
- **`failed` is a resting state, not a disappearance.** The instance stays in the process table with
  its error so it can be inspected and restarted. An Application that vanishes on error is one nobody
  can debug.
- **Restart is stop then start**, and produces a **new `pid`**. It is not a resumption; nothing is
  carried over except what was persisted.

The kernel decides these transitions. An Application does not stop itself — it can *request* it, and
the request goes through the same path as the process manager's stop button, so there is one code
path and one place where ownership is released.

---

## 5. Foreground and background — **Proposed**

Several Applications are loaded; one shows.

The question that has to be answered concretely, because the wrong answer is the expensive one:
**what happens to a background Application's DOM?**

> **Proposed: it stays mounted and hidden.** Not unmounted, not re-created on switch.

A background Application is **idle, not stopped**. It keeps its DOM, its scroll positions, its
in-flight requests, its open SSE subscription and its half-typed form. Switching back is instant and
lossless — which is the same guarantee [the model §4](./README.md) makes about mode switching, for
the same reason: the arrangement is not the process.

What the kernel does on switch:

- `hidden` on the outgoing windows, not `display: none` on a re-render
- move focus, and restore it on return
- update z-order and view state
- **tell the Application**, so it can throttle voluntarily — an animation, a polling loop, a live
  chart. A capability call, not an enforced suspension: [kernel §6](./kernel.md) is honest that there
  is no preemption in a tab.

The cost is memory: ten loaded Applications is ten mounted trees. That is the right trade for a
handful of Applications and the wrong one for a hundred, and if it ever becomes a hundred the answer
is unmounting *views* under a policy, not unmounting Applications.

---

## 6. Views — **Decided in principle**

A view is a unit of screen, and **a window contains a view**. The header of a blog is a view; so are
its sidebar, its content area and its footer.

**Views do not nest. Below a view are components.**

> "you can't move a nested view out of its parent. because a view can be made up of views or what it
> should be is components I think. everybody uses the same form component just with different
> styles."

This is the decision that deletes most of the hard part: the window manager sees views and nothing
under them, and there are no cross-level interactions to design.

### A tile is a slot. A view fills it. — **Decided**

> "the 'content' is almost a sub thing … what i did like was the 'ViewProvider' in mesh-ui"

The demo had this wrong: it declared a *view* named `content` and a *tile* named `content`, which
are not the same kind of thing.

**The Application declares a layout** — a split tree whose nodes are named. Those names are tiles.
**Each view declares which tile it targets.** Several views may target one tile over the
Application's life, and the window manager decides which occupies it now.

| | |
| --- | --- |
| **tiles** (the layout) | `header`, `sidebar`, `content`, `footer` |
| **views** (what fills them) | `masthead`→header, `postList`→sidebar, `post`→content, `colophon`→footer, `editor`→content |

`post` and `editor` both target `content`. Reading swaps one in, editing swaps the other. That is
what `content` was reaching for by being "almost a sub thing" — it is not a view, it is where views
go.

This is mesh-ui's `ViewProvider` idea, which was the right one: a named slot that different providers
fill, resolved at runtime. What it got wrong is in
[view-layer §6](./view-layer.md) — four hard-coded panel locations, one instance per provider id, and
author-managed disposables.

In **windowed mode tile names are simply unused.** Every view is a window and the layout is whatever
the user dragged. Same views, two geometries.

`layout` is therefore part of the manifest (§2), not something built in `start()` — the kernel needs
the tile names to restore geometry before the Application runs.

### View types are declared; view instances are created — **Proposed**

The question this answers: does an Application register its views in `start()`, the way mesh-ui's
extensions called `shell.views.registerProvider(location, provider)` during activation?

**Partly, and the split matters.**

| | view **type** | view **instance** |
| --- | --- | --- |
| what it is | "this Application can show a record editor" | "this record editor, showing `example.com`" |
| declared | statically, on the class | created at run time |
| when known | before `start()` | whenever the user opens one |
| carries | defaults, tile name, min size, `instances` | geometry, z-order, scroll, its params |
| how many | fixed, small | zero to many |

The reason types cannot wait for `start()` is not aesthetic — it is the boot order.
[kernel §3](./kernel.md) restores view state at step 9 and starts Applications at step 10. Geometry,
z-order and mode are restored *before* the Application runs, so a window comes back where it was
rather than appearing at a default position and jumping once the app finishes starting. That is only
possible if the kernel already knows what views exist and what their defaults are. A registration
call inside `start()` is too late by construction.

And the reason instances cannot be static is obvious the moment there is a second one: an editor
cannot declare "a view for `example.com`" ahead of time, and §3's whole point is that two of
something must be possible.

So:

```ts
// declared — the catalogue
readonly views = [ view({ id: 'record', title: 'Record', instances: 'many' }) ];

// created — at run time, by the Application, the router, or the user
cx.windows.open({ view: 'record', params: { zone: 'example.com' } });
```

A view type declares `instances: 'one' | 'many'`. `'one'` is a sidebar or a footer — opening it twice
focuses the existing one. `'many'` is an editor. Instance identity is the view id plus a key derived
from `params`, which is what lets geometry persist per document rather than per view type.

Declaring views statically has a second payoff that registration inside `start()` could not give:
**the ids survive as literal types.**

```ts
type ConsoleViews = ConsoleApp['views'][number]['id'];   // 'domains' | 'sidebar' | 'record'
```

So `windows.open({ view: 'recrd' })` and a route pointing at a view that does not exist are both
compile errors in the Application's own file. Checked against `tsc 5.9`, along with the rest of the
contract.

### A view renders. It does not mount. — **Decided**

An earlier draft of this document gave a view `mount(el, vx)`, taking mesh-ui's
`resolveView(container, disposables)` as the shape to keep. That was wrong in one specific way: a
view handed a container can construct DOM, and a view that can construct DOM can hold logic.

**A view is a pure function from application state to a description.** No container, no
`HTMLElement`, no `mount`. [view-layer.md](./view-layer.md) is the whole argument; what carries over
here is that a view's output is data and the renderer is the kernel's.

What mesh-ui got right — a named slot filled by different providers, resolved at runtime — is kept,
and is the tile model above. What it got wrong is listed in
[view-layer §6](./view-layer.md): four hard-coded panel locations, one instance per provider id, and
author-managed disposables.

Each view declares its own defaults, and they belong to the view rather than the Application
([roadmap A1.2](./roadmap.md)):

| declares | used by |
| --- | --- |
| `id`, `title` | window title, process manager, view state key |
| `tile` | which named node of the split tree in tiled mode |
| `default` geometry | first open in windowed mode |
| min/max size, resizable | the window manager |
| whether it may be closed | a blog's content area may not |

The same views serve both modes. In tiled mode geometry comes from the layout and there are no
min/max affordances; in windowed mode they float, move, resize and stack. **The same views, two
geometries** — see [the model §3](./README.md).

**One view instance per window.** Two windows means two view instances, over one application state —
which is how a split editor showing one document twice works with no new concept
([the model §8](./README.md)).

---

## 7. Application state — **Decided**

The other half of [the model §4](./README.md), from the Application's side.

**The Application owns:** scroll positions, form contents, open connections, running queries, a
half-typed message, selection, undo history.

**The window manager owns:** position, size, z-order, mode, minimised/maximised, which tile a view
occupies.

A mode switch, a move, a resize or a re-stack touches only the second. The Application is not
notified, does not re-render, and does not remount. That is the whole mechanism behind "switching is
dynamic", and it works because the two are stored separately rather than because anything is
carefully preserved during the switch.

Application state that should **survive a restart** goes to `storage`, namespaced per instance, and
that is a deliberate act by the author — not an automatic snapshot. A restart produces a new `pid`
and a fresh instance; what comes back is what was written down.

---

## 8. The API — **Decided**

> "the application should include what it will take in and what it can provide"

An Application's API is what it `provides`. `consumes` is what it takes in. Same provider tokens as
[Extensions §4](./extension.md), same phantom type, same rules.

**A headless Application is only its API.** This needs no new machinery — it is an Application with
`provides` and without views, which is why "background process reachable through its API" required no
design work beyond making `surfaces` optional.

Two things worth separating, because one word covers both and they are different:

- **The provider API** — in-page, typed, synchronous-ish, consumed by other contributors through
  `cx.use`.
- **The site's HTTP API** — mesh-api, over the network, gatekept, per [hosting §4](./hosting.md).

An Application declares its endpoints against the second and exposes a typed facade over it as the
first. The auth Extension attaches the ticket, so an Application does not handle credentials.

---

## 9. Routing — **Proposed**

**Yes, routing goes through views** — that is what a route resolves *to*.

```
/zones/example.com   →   application  surfdns-console
                     →   view type    'record'
                     →   params       { zone: 'example.com' }
                     →   instance     created if absent, focused if present
```

A route names a view type and its params; the router asks for that view instance the same way any
other caller does, through `windows.open`. So a deep link and a click are the same operation, and
there is one path that creates a view rather than two that must agree.

- **An Application declares its routes**, relative to a mount point it does not choose. Two instances
  of one Application cannot both own `/domains`, so the mount point is assigned — by the kernel for
  the first instance, and by the window for the rest.
- **Only the foreground Application's route is in the address bar.** Background Applications keep
  their route internally, and switching restores it. This follows from §5: they are idle, not stopped,
  so their position is still real.
- **A deep link starts an Application if it is not running**, then routes into it — the same path as
  the process manager starting one.

Open: what a URL looks like when several Applications are running and the user switches. Probably the
foreground's route, with the rest as restorable view state, but session restore across a reload wants
thinking about before it is written.

---

## 10. What an Application declares to be deployed — **Decided**

Its repo declares its production host, its production API, and its other environments
([hosting §5](./hosting.md)). The site team owns what mesh contracts it exposes and to whom.

> "every new extension or app will be its own repo unless they are built in"

The process manager is built in. surfdns-console is its own repo. A blog is its own repo. All three
are Applications under one contract, which is the claim the framework is making and the one Track D
of the [roadmap](./roadmap.md) tests.

---

## 11. Open

- **Session restore.** Which Applications come back on reload, in what mode, at what route. §9.
- **Can an Application start another Application** — specifically, can one spawn a headless helper —
  or is starting reserved to the kernel, the router and the process manager?
  ([kernel §9](./kernel.md))
- **Crash-restart policy.** Does a failed background Application restart automatically, and how many
  times before it stays failed?
- **Instance limits.** Should an Application be able to cap its own instances at something other than
  one or unbounded?
- **What a background Application is told**, precisely, in §5's throttle notification — and whether
  ignoring it has any consequence at all, given [kernel §6](./kernel.md).
- **Per-instance storage lifetime.** A new `pid` on every restart means per-instance storage is
  orphaned by design; either it is keyed by something stabler, or something collects it.
