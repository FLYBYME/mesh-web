# The kernel

The part that is running before anything is loaded, and that everything else is loaded *by*.

**Status.** Design, and newer than the rest — the kernel had not been named before this document, so
most of it is **Proposed** rather than **Decided**. Where it restates something already settled it
says so and links to it.

Companions: [the model](./README.md) · [Extensions](./extension.md) · [Applications](./application.md)
· [storage and the registry](./storage-and-registry.md) · [hosting](./hosting.md) ·
[authentication](./auth.md).

---

## 1. Why there is a kernel at all — **Proposed**

The framework already had a rule: an Extension declares `needs('net', 'commands')` and
gets a context on which `cx.notifications` is a compile error. That rule is worth very little on its
own. A compile error is advice; the bundle can be built by someone else, with a different tsconfig,
or edited after the fact.

Capability narrowing means something only if, at run time, **something builds a context object with
exactly the declared capabilities on it and no others** — and only if that something cannot be
replaced by the code it is narrowing.

That is the kernel. It is not a layer for tidiness. It is the answer to *who hands out capabilities*,
and it has to exist before the first contribution is constructed, or the first contribution could
answer that question itself.

Everything else the kernel does follows from being the thing that is already there: it is
consequently also the only thing that can own the process table, resolve the registry, and decide
what happens when a contributor throws.

---

## 2. The line: kernel or built-in Extension — **Proposed**

Not everything shipped with the framework is *in* the kernel. The process manager is built in, but
it is an Extension — it has a window, it renders, and it uses ordinary capabilities.

One test decides it:

> **If an Extension could replace this, could it grant itself a capability, observe another
> contributor's traffic, or lie to the window manager about who owns a window?**

Yes → kernel. No → built-in Extension, and it should be one, because a built-in written against the
same interfaces an outside author gets is the only honest test that those interfaces are usable.
This is the same argument as [the workbench being an Extension](./README.md) and it applies
downward.

| in the kernel | a built-in Extension |
| --- | --- |
| the loader and the constructors | the workbench — chrome, activity bar, tabs |
| the capability broker | the process manager UI |
| the provider registry (token → implementation) | the command palette |
| the process table and lifecycle | the notification *surface* |
| window geometry, z-order, mode, view state | window *decoration* and theme |
| registry resolution and policy | the settings editor |
| the event bus | the log viewer |
| the router: URL → instance | — |

Two rows are worth pausing on.

**The window manager is split.** The geometry model, z-order, which view is in which tile, and the
persistence of all that, are kernel: they are what [§4 of the model](./README.md) calls view state,
they must survive the Application, and an Application must not be able to move another
Application's window. How a window is *drawn* — its title bar, its resize handle, its shadow — is an
Extension, which is what lets a blog and an IDE look nothing alike over identical mechanics.

**The notification surface is not the notification capability.** `cx.notifications.info(...)` is
kernel, because it must work before any chrome exists and must not be interceptable by whichever
Extension happens to render toasts. Where the toast appears and what it looks like is an Extension.
A site with no notification Extension still has working notifications; they just have nowhere good
to go, which is a rendering problem and not a broken call.

---

## 3. Boot — **Proposed**

Ordered, and the order is not arbitrary — each step needs the one before it.

1. **Read the deployment descriptor.** Which site this is, its API base, its environment, its
   exposure list. Static, baked at build time. [hosting §5](./hosting.md)
2. **Establish the registry.** Bind providers to hives, load `system` policy from the build and the
   server. Nothing user-specific yet, because there is no user yet.
   [storage §2](./storage-and-registry.md)
3. **Construct Extensions.** Load each bundle, check its default export is constructable, construct
   it. **No `activate` yet.** Construction must be side-effect free, which is exactly what the
   class-export model buys over `defineExtension` — a host can hold a constructed Extension and
   inspect what it needs before deciding to trust it.
4. **Resolve the provider graph.** Order Extensions by their `consumes` against others' `provides`.
   A cycle is a boot failure and names both ends.
5. **Activate Extensions in that order**, each with a context narrowed to its `needs`.
   Providers returned by `activate` become available to the next.
6. **Now there may be a user.** The auth Extension has activated, so `user` and `device` hives can
   resolve and per-user settings become readable.
7. **Restore view state** for this user and site: geometry, z-order, mode.
8. **Construct and start Applications**, and foreground one — either the route's, or the last
   foreground from view state.
9. **Route.** The URL selects an Application instance and a view within it.

Steps 1–5 are the kernel booting. Steps 6–9 are the kernel running.

The thing to preserve: **an Extension cannot observe another Extension being constructed**, and
cannot run code between step 3 and its own step 5. Any hook that lets one contributor act during
another's activation is a way around §2's table.

---

## 4. Capability mediation — **Proposed**

The kernel builds one context per contributor:

```ts
// kernel-side, illustrative
function contextFor(contribution: ErasedContribution): ErasedContext {
    const cx = baseContext(contribution.id);           // id, dispose, use
    for (const name of contribution.needs ?? []) {
        cx[name] = capability(name, contribution.id);  // scoped to this contributor
    }
    return cx;                                          // nothing else is on it
}
```

Two properties, and both are the point:

**Narrowed.** An undeclared capability is not on the object. `cx.windows` for a contributor that did
not ask for `windows` is `undefined`, which matches the compile error rather than contradicting it.

**Scoped.** A capability is not a shared singleton handed to everyone. `capability(name, id)` is
bound to the contributor asking for it, which is what makes the rest tractable:

- `log` is already tagged with who logged.
- `storage` is already namespaced, so two Applications cannot collide on a key.
- `windows` knows who opened a window, so ownership and cleanup need no bookkeeping from the caller.
- `commands` knows who registered a command, so a conflict names a culprit.
- `net` can attach the site's ticket without every caller remembering to.

Disposal follows from scoping: when a contributor stops, the kernel disposes its capabilities, and
the windows, commands, key bindings, menu items and subscriptions go with it. **A contributor is not
trusted to clean up after itself,** because the case that matters is the one that crashed.

### Capability narrowing is not a sandbox — **Proposed, and it must be said**

An Application runs in the same JavaScript realm as the kernel. It can call `fetch` directly, reach
`document`, read `localStorage`, and ignore every capability it was given. Nothing in §4 prevents
that, and a document that implied otherwise would be dangerous.

So, stated as flatly as [storage §2](./storage-and-registry.md) states its equivalent:

> **Capabilities are an architecture boundary, not a security boundary. The API is the security
> boundary.**

What capabilities actually buy is real, and worth being precise about rather than overselling:

- **A contributor cannot reach another contributor except through a declared provider**, so the
  dependency graph is the truth and not a diagram.
- **What a bundle can touch is legible before it runs**, from its `needs`, without reading it.
- **One contributor runs unchanged under a host that arranges windows as tiles, as floating windows,
  or not at all** — which is the failure the previous generation had, where every Extension received
  a `Shell` carrying `layout, activityBar, tabs, docking, transport` and was therefore an extension
  *of an IDE*.

Anything stronger requires a real boundary — an iframe per Application on its own origin, or a
worker. Both are §9.

---

## 5. The process table — **Proposed**

The kernel holds every running thing, which is what makes the process manager a view over kernel
state rather than a registry of its own.

```ts
interface ProcessEntry {
    readonly pid: string;                    // kernel-assigned, not the author's id
    readonly applicationId: string;          // from the manifest
    readonly instance: number;               // N instances of one Application
    readonly state: 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
    readonly foreground: boolean;
    readonly startedAt: number;
    readonly windows: readonly string[];     // owned window ids
    readonly error?: Error;                  // when failed
}
```

`pid` is assigned by the kernel and not taken from the bundle, for the same reason a process id is
not chosen by the program: identity has to come from the thing that grants it. This is also the
point the previous generation got wrong — identity came from the code (`defineApp({ id })`) rather
than from the manifest that asked for it, which is why two instances of one Application were
impossible.

Extensions are **not** in the process table. They are installed, singleton, and have no lifecycle to
manage — see [extension.md §6](./extension.md).

---

## 6. Scheduling, honestly — **Proposed**

A browser tab has one main thread. There is no preemption, no time slicing, and no way for the
kernel to take control back from an Application that is in a loop.

"Process" is therefore bookkeeping, not enforcement. It is still the right model — it gives identity,
lifecycle, ownership and a process table, all of which are real — but the OS metaphor stops exactly
here and this document should say so rather than let someone discover it.

What follows:

- **A misbehaving Application freezes everything.** The kernel cannot fix this. It can only notice:
  a watchdog on the event loop that reports which contributor was last on the stack.
- **Background Applications are not running in the background.** They are idle until something calls
  them. A headless Application that wants to do periodic work does it on a timer like everything
  else, and gets no scheduling guarantee.
- **Long work belongs in a worker.** Not offered as a capability yet; §9.
- **Cooperative yielding is a convention**, and conventions that matter should be made easy: the
  kernel should provide the yield rather than leave every author to reinvent it.

---

## 7. Failure — **Proposed**

Fault containment is most of what a kernel is for, and the cases differ.

**An Extension throws during `activate`.** Boot continues. The Extension is marked failed, its
`provides` are unavailable, and anything that `consumes` one of them fails to activate too, in a
cascade the kernel reports as one error naming the root. A site that cannot function without an
Extension says so by declaring it required in the descriptor; the kernel does not guess which ones
are essential.

**An Extension throws after activation**, inside a command or a callback. The kernel catches at the
capability boundary — it invoked the callback, so it is the one holding the try — reports it against
that Extension, and keeps going. One broken command does not take down the page.

**An Application throws during start.** It goes to `failed` in the process table with its error, its
windows are disposed, and the rest of the system is untouched. This is the case the process model
earns its keep on.

**An Application throws while running.** Same containment. It stays in the table as `failed` so it
can be inspected and restarted, rather than vanishing.

**The kernel throws.** There is no recovery, and pretending otherwise produces a half-running system
that is worse than a stopped one. Render a failure page, report, stop.

The rule underneath: **the kernel catches at every boundary it calls across, and nowhere else.**
Catching inside a contributor's own call stack hides bugs from the author who can fix them.

---

## 8. What the kernel is not — **Proposed**

- **Not a UI.** It renders nothing. A kernel with no Extensions is a blank page with a working
  process table, and that should be a real, testable state.
- **Not a mesh node.** [Already decided](./status.md) §5: the browser never joins the mesh. The kernel
  speaks HTTP to a site's API and holds no transport, no broker, no peer connection.
- **Not extensible.** There are no kernel plugins, no hooks into boot, no way to wrap the capability
  broker. Everything extensible is an Extension, and the kernel is deliberately the part that is not.
- **Not the security boundary.** §4.

---

## 9. Open

- **Real isolation.** An iframe per Application would give each its own origin — which is exactly the
  isolation [hosting §3](./hosting.md) already relies on between *sites* — at the cost of making
  every capability call cross a postMessage boundary and making tiled layout much harder. A worker
  per headless Application is cheaper and only helps the ones with no view. Neither is decided;
  today's answer is one realm, and that answer is written down as a limit rather than a design.
- **Workers as a capability.** Follows from §6, and probably wants to exist before anything does
  real work in a tab.
- **Whether the kernel is replaceable at build time.** A locked-down blog build could use a smaller
  kernel with no process table and no window manager, which is the same idea as
  [stripping floating mode from a production build](./README.md) §6 taken further. Attractive, and it
  risks two kernels that drift.
- **Watchdog reporting** — what it observes and where it sends it.
- **Boot performance budget.** Steps 1–5 are all before first paint. Nobody has measured anything,
  because nothing exists; the number should be chosen before it is missed.
- **Whether Applications can be started by other Applications**, or only by the kernel, the router
  and the process manager. Bears on whether one Application can spawn a headless helper.
