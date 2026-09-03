# mesh-web: the model

An abstract operating system in a browser.

That framing is not decoration — it decides the shape of everything below. An OS runs processes.
Some have windows, some do not. A window manager arranges the ones that do, and the arrangement is
not the process. This document is what follows from taking that seriously.

**Status.** Design. Sections marked **Decided** are settled. Sections marked **Proposed** are mine
and need a yes or no. Sections marked **Open** are not answered yet.

This document is the model in one piece. Three companions take its pieces in detail — **[the
kernel](./kernel.md)**, which is what boots and hands out capabilities and cannot be replaced by what
it loads; **[Extensions](./extension.md)** and **[Applications](./application.md)**, which are the
two things it loads. Where they and this document overlap, they are the more specific and they win.

Also: [Storage and the registry](./storage-and-registry.md) ·
[Hosting: the builder, the CDN, and how a site is found](./hosting.md) ·
[Authentication](./auth.md) · [Service modules](./service-modules.md) ·
[the roadmap](./roadmap.md).

---

## 1. Processes

### Application = process — **Decided**

An Application is a process. It may have views. It may equally be **headless**: a background process
that does its work and is reached through its API.

This reverses something already in the code: `Application.surfaces` is currently required, on the
argument that "a destination that appears nowhere is not a destination". That argument was wrong,
because an Application is not a destination — it is a process, and a daemon with no window is a
perfectly ordinary thing for an operating system to run. **`surfaces` must become optional again.**

What an Application has instead of a required view is an identity and, usually, an API. A headless
Application that provides nothing and shows nothing is the degenerate case and is allowed to exist;
it just does not do anything.

### Extension = capability — **Decided**

An Extension extends the framework. Commands, menus, key bindings, providers. It has no process
identity of its own, activates once, and spans every Application.

### The API is how processes talk — **Decided**

An Application's API is what it `provides`. A headless Application is *only* its API. This is the
same provider-token mechanism already built: a token carries the type across a boundary the two
sides never import across.

So "background process accessible through its API" needs no new machinery. It is an Application
with `provides` and without views.

---

## 2. Views

A view is a unit of screen. **A window contains a view.** The header of a blog is a view; so is its
sidebar, its content area and its footer.

### Views do not nest. Below a view are components. — **Decided**

> "you can't move a nested view out of its parent. because a view can be made up of views or what it
> should be is components I think. everybody uses the same form component just with different
> styles."

This is a real simplification and it should be stated as a rule: **the window manager sees views and
nothing below them.** A view is a leaf as far as arrangement is concerned. What a view is made of is
components — a form, a table, a toolbar — and components are not window-manager concerns. They are
not placed, not moved, not dragged out, not remembered in view state.

The shared component library is the point. Everyone uses the same `Form`; what differs is styling,
not structure or placement. A component is composed into a view by its author, in code, and stays
there.

Two things fall out:

- **Nested tiling nearly disappears as a feature.** A view whose content is laid out in columns is
  using a layout component, not hosting sub-views the user can pull apart. There is no cross-level
  drag, no nested focus traversal, no recursive geometry — the hard parts were all consequences of
  a nesting that does not exist.
- **A view is the unit of everything the window manager tracks**: an id, geometry, z-order, a tile
  position. One view, one window, one row of view state.

Where genuine nesting does exist — a workbench Application hosting other Applications in its own
tiles — those are *Applications*, each contributing their own views to the host's arrangement. That
is the same one-level relationship seen from outside, not a view inside a view.

That is the unification the whole design turns on: **regions and windows are the same thing.** There
is no separate region concept that windows live inside. A tiled layout is a set of windows arranged
as tiles. Switch to windowed and the header floats off as a window, because it already was one.

### What a view declares — **Proposed**

Each view needs defaults for both modes, because it has to be reasonable in either:

| declaration | meaning |
| --- | --- |
| `id` | stable across mode switches; what geometry is remembered against |
| `tile` | where it sits in tiled mode — the slot or region it occupies, and its size |
| `float` | default position and size when it becomes a floating window |
| `minSize` | honoured in both modes |
| `closable` | whether the user may close it. A blog's header is not closable |
| `chrome` | which window controls it shows — see below |

**Open:** whether `tile` should name a slot (`header`, `sidebar.primary`) or a position in a split
tree. A slot is simpler and matches what exists; a split tree is what real tiling needs. These may
need to be the same thing, with slots being named nodes in the tree.

---

## 3. The two modes

### Tiled mode is website mode — **Decided**

> "the tiled mode is the website mode"

A blog defaults to tiled. In tiled mode:

- **A tile is a defined window.** Its position and size come from the layout, not from the user.
- **No minimise or maximise buttons.** Those controls do not exist in this mode.
- The result looks like a website, because it is one — header, sidebar, content, footer.

### Windowed mode is GIMP — **Decided**

The console is windowed: floating windows the user moves, resizes and stacks. GIMP's multi-window
mode is the reference — toolbox, layers and canvas as separate windows.

Switching the console to tiled **may look funky and must still work.** That is the acceptance
criterion, stated as such: not "looks good in both", but "works in both, and one of them is the
designed one".

### The same views, two geometries — **Decided**

Both modes arrange the same set of views. Nothing is created or destroyed by a mode switch. What
changes is geometry and chrome.

---

## 4. View state is not application state — **Decided**

> "the view is different from the state of the application"

This is the principle that makes dynamic switching possible, and it is worth stating as a rule:

**The window manager owns view state. The Application owns application state. A mode switch touches
only the first.**

View state, owned by the window manager and persisted per user:

- window position and size
- z-order
- current mode
- minimised / maximised / restored
- which tile a view occupies

Application state — scroll position, form contents, an open connection, a running query, a
half-typed message — belongs to the Application and is never touched by a mode switch, a move, a
resize or a re-stack.

Windowed mode **remembers** position, size and z-index. Switching to tiled and back returns windows
where they were. That memory is view state, keyed by view id, and it survives the round trip.

---

## 5. Mode switching is dynamic — **Decided**

> "it needs to be dynamic"

No remount, no teardown, no reload. The DOM subtree of a view moves between containers; it is not
rebuilt.

Consequences that follow, and that the implementation has to honour:

- A view's element is created once and **moved**, never re-created. The compositor already does this
  for backgrounded apps — `detachAppSurfaces`/`restoreAppSurfaces` preserve the container and its
  position — and the same mechanism generalises.
- Focus must be restored after a move. Removing an element from the document blurs it, so the window
  manager records what had focus and gives it back.
- Scroll position is application state and must survive. In practice a moved element keeps its
  `scrollTop`, but this needs a test rather than an assumption.
- Anything mid-flight — an open SSE stream, a pending request, a WebSocket — is untouched, because
  none of it lives in the DOM.

---

## 6. Who can switch — **Decided**

> "I as the admin and developer can switch it"

Switching modes is a privilege, not a user preference. Two audiences: the developer at build time,
and an administrator at runtime.

### Locked mode — **Decided**

> "in a locked down mode the blog can never look like anything but the blog"

A deployment can be locked to one mode. Locked means the mode cannot be changed by anyone, through
any control, at runtime. A locked blog is a blog and cannot be turned into floating windows.

### Two hotkeys, and they are different things — **Decided**

> "a hot key in dev mode can trigger a switch or because more than one application can run at a
> time a hot key to switch"

**Mode switch** — tiled ↔ windowed. Available in dev mode and to an administrator. This is the
trigger; there is no viewport-driven or otherwise automatic switching, and §8 no longer asks about
one. A person presses a key. That is the whole mechanism, and it is the right amount of mechanism:
a site that rearranges itself because a window got narrow is a different feature, and one nobody
asked for.

**Application switch** — cycle between the Applications running at once. Not privileged and not a
dev-mode feature: several processes running with one foreground is the normal state, so this is an
ordinary part of using the system.

They must be separately bound. Sharing one key, or gating the application switcher behind dev mode,
would conflate "which process am I looking at" with "how are windows arranged".

**This needs a working hotkey parser, and there is not one.** The existing task switcher compares a
configured hotkey against the string literal `` 'ctrl+`' `` and hard-codes the matching event test,
so any other configured binding installs a listener that can never fire — silently. It is filed as
mesh-api issue #7 and moved here with the runtime. Two bindings instead of one makes it a blocker
rather than a wart: the second one cannot work at all until the parser is real.

### Stripping it from production builds is acceptable — **Decided**

> "if it needs to be locked out from production builds that's fine"

The window manager's floating mode may be excluded from a production bundle entirely. This is
permitted and probably wanted: a blog ships without the code to float its header, which is smaller
and removes the question of whether a visitor can reach it.

**Proposed:** three levels rather than a boolean, because they are genuinely different situations:

| level | meaning |
| --- | --- |
| `locked` | one mode, no switching, floating code may be stripped from the build |
| `privileged` | switching exists at runtime, gated on an administrator |
| `open` | any user may switch — a developer console, an IDE |

---

## 7. What this changes in the code

Written down so it is not lost:

1. **`Application.surfaces` must become optional.** A headless Application is a background process
   and is legitimate. The current requirement, and the `constructApplication` guard that checks for
   it, are both wrong and were argued from "a destination must appear somewhere" — the wrong framing.
2. **`WindowPreferences` is on the wrong thing.** It sits on `Application` and assumes a window is a
   whole Application. If a view is a window, defaults belong per view.
3. **Regions and the window manager must merge.** `LayoutConfig.regions` and the compositor's region
   placement describe tiled mode. They are not a separate concept from windows.
4. **View state needs an owner and a store.** Nothing today persists geometry, z-order or mode.
   [Storage and the registry](./storage-and-registry.md) gives it one.
5. **A capability for mode control**, gated — an Application should not be able to switch the host's
   mode just because it can see it.
6. **A real hotkey parser**, before anything binds a second key. See §6.

---

## 8. Open

Recommendations below are mine and one word from settled. They are recorded rather than left in a
conversation so they are not lost.

- **Does a headless Application have a lifecycle distinct from an Extension?** — **Proposed: yes,
  keep them distinct.** The test that settles it is whether killing it leaves the system working. A
  background process can be stopped and everything carries on; kill the auth Extension and
  everything consuming it breaks. In OS terms an Extension is *installed* — a driver registered with
  the kernel, singleton by nature — and an Application is *run*: a process in the process table,
  with N possible instances, stoppable and restartable, listed in the process manager.
- **`tile` as a slot name or a position in a split tree?** — **Proposed: both.** It is a split tree
  whose nodes may be named. `tile: 'header'` resolves to the node named `header`; user-dragged
  splits create unnamed nodes. A blog author writes names and never sees a tree; an IDE user drags
  splits and never writes a name.
- **Can one view live in two windows?** — **Proposed: no.** A view instance is in exactly one
  window; a DOM element has one parent and anything else means mirroring. Two windows means two
  instances. A split editor showing one document twice already works without a new concept, because
  view state and application state are separate (§4): two view instances, one application state.
- **What does a caller do with a detected conflict?** — **Proposed:** a `conflict` field on a
  setting declaration, defaulting to `reject`. Safe by default; window geometry opts into
  last-write-wins explicitly rather than everything silently doing it. See
  [storage and the registry](./storage-and-registry.md) §7.
