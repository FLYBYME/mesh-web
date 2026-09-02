# mesh-web: the model

An abstract operating system in a browser.

That framing is not decoration — it decides the shape of everything below. An OS runs processes.
Some have windows, some do not. A window manager arranges the ones that do, and the arrangement is
not the process. This document is what follows from taking that seriously.

**Status.** Design. Sections marked **Decided** are settled. Sections marked **Proposed** are mine
and need a yes or no. Sections marked **Open** are not answered yet.

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
5. **A capability for mode control**, gated — an Application should not be able to switch the host's
   mode just because it can see it.

---

## 8. Open

- **Does a headless Application have a lifecycle distinct from an Extension?** Both activate and
  provide. The difference is that an Application is a process with identity and can be stopped and
  restarted; an Extension is part of the framework once loaded. This may be a real distinction or
  may collapse.
- **`tile` as a slot name or a position in a split tree.** See §2.
- **What "automatically" means for a mode switch.** The phrase was used earlier; §4 answers what is
  *preserved* across a switch, but not what *triggers* one without a person asking. Viewport size is
  the obvious candidate — a tiled site on a phone — but that is not the same feature as an admin
  toggling windowed mode, and conflating them would be a mistake.
- **Multiple windows of one view.** `singleton: false` currently sits on an Application. If a window
  holds a view, the question is whether one view can appear in two windows, which is a different and
  harder question (two live instances of the same subtree).
- **Nested tiling.** A tiled Application inside a floating window of the console. The model permits
  it; whether the first implementation supports it is a scope decision.
