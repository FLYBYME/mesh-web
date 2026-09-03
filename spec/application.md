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

```ts
import type { Application, CapabilityContext } from '@flybyme/mesh-web';

const CONSOLE = provider<ConsoleApi>('surfdns.console');

export default class ConsoleApp implements Application<['net', 'windows', 'commands'], [typeof AUTH], typeof CONSOLE> {
    readonly needs = ['net', 'windows', 'commands'] as const;
    readonly consumes = [AUTH] as const;
    readonly provides = CONSOLE;

    readonly views = [
        { id: 'domains',  title: 'Domains',  tile: 'content', default: { width: 900, height: 600 } },
        { id: 'sidebar',  title: 'Navigate', tile: 'sidebar', default: { width: 240 } },
    ];

    async start(cx: Context): Promise<ConsoleApi> {
        const auth = cx.use(AUTH);
        return { reload: () => { ... } };
    }

    async stop(): Promise<void> { ... }
}
```

The reasoning behind the class-export model, `needs` narrowing and provider tokens is identical to
[Extensions §2 and §4](./extension.md) and is not repeated. What differs is everything below.

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

The URL selects an Application instance and a view within it.

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
