# Extensions

A capability contributed to whatever is running.

**Status.** The contract is **Decided** — it was written, type-checked and then deleted with
everything else, and it held up ([status §2](./status.md)). Lifecycle and activation policy are
**Proposed**.

Companions: [the model](./README.md) · [the kernel](./kernel.md) ·
[Applications](./application.md) · [authentication](./auth.md).

---

## 1. What an Extension is — **Decided**

> "Extension implies you are extending the ui framework vs an application."

An Extension extends the framework. It contributes commands, menus, key bindings, views and
providers to *every* Application, has no route and no process identity, and activates once.

The operating-system analogy is exact and worth keeping: **an Extension is installed, an Application
is run.** A driver registered with a kernel is singleton by nature, is not in the process table, and
is not something a user starts and stops. That is an Extension. Something you can kill and carry on
without is an Application.

The test, from [the model §8](./README.md): *does killing it leave the system working?* Stop a
background Application and everything carries on. Kill the auth Extension and everything consuming
it breaks.

---

## 2. The bundle contract — **Decided**

**A bundle `export default`s a class. The host constructs it.**

```ts
import { needs, type Extension, type CapabilityContext } from '@flybyme/mesh-web';
import { AUTH, type AuthApi } from '@surfdns/auth-contract';

const NEEDS = needs('mesh', 'notifications');

export default class AuthExtension implements Extension<typeof NEEDS, [], typeof AUTH> {
    readonly needs = NEEDS;
    readonly provides = AUTH;

    activate(cx: CapabilityContext<typeof NEEDS>): AuthApi {
        cx.mesh.api;                  // declared
        cx.notifications.info('hi');  // declared
        cx.windows.open({ ... });     // compile error: not declared
        return { session: cx.state.signal<Session | null>(null), signIn, signOut };
    }
}
```

Four things are load-bearing here.

**A class, not a call.** There is no `defineExtension()` and no module-level registry, deliberately.
That pattern is how *mesh contracts* work and it is right there — a contract is a global
declaration, there is exactly one of each, and importing the file is the act of declaring it. None
of that is true of a screen. Copying it across bought three problems: importing a bundle became a
side effect, so a host could not inspect one before trusting it; one definition meant one instance;
and identity came from the code rather than from the manifest that asked for it.

> The mesh is the network. It is not a model for how a page is put together.

**Construction is side-effect free.** The constructor may not touch the DOM, open a connection, or
register anything. All of that is `activate`. This is what lets the kernel construct every Extension,
inspect the graph, and only then start activating ([kernel §3](./kernel.md)).

**`needs` narrows the context.** It produces `CapabilityContext<TNeeds>` with exactly those
capabilities on it — a compile error for anything else, and `undefined` at run time, because the
kernel builds the object from the same list ([kernel §4](./kernel.md)).

**`activate` returns what the Extension provides.** Not a side-channel registration — a return value,
checked against the declared `provides`.

### `needs(...)`, not `as const` — **Decided**

Earlier drafts of this document wrote `readonly needs = ['net', 'notifications'] as const`. That was
worse than it needed to be, in two ways: `as const` is ceremony the author has to know about, and the
list then had to be repeated in the type argument. Both are avoidable, and the alternatives were
checked against `tsc 5.9` rather than reasoned about.

```ts
export function needs<const T extends readonly CapabilityName[]>(...n: T): T { return n; }
```

A rest parameter with a `const` type parameter infers the literal tuple, so `as const` is not needed.
Because the constraint is the `CapabilityName` union, the editor completes capability names inside
the call and rejects a typo at the point of the typo — `needs('mesh', 'mehs')` errors on `'mehs'`,
not on some downstream context type.

Assigning it to a module-level `const` and referring to `typeof NEEDS` makes the list a single source
of truth: it is written once, as a value, and used as a type everywhere else.

**What was measured** — the four shapes, one file, `--strict`:

| shape | result |
| --- | --- |
| `readonly needs = ['mesh', 'notifications']` | widens to `string[]`. Everything is lost, silently. |
| `readonly needs = needs('mesh', 'notifications')` | literal tuple preserved. **✓** |
| `activate(cx: CapabilityContext<this['needs']>)` | **fails** — `Property 'mesh' does not exist`. TS will not resolve a mapped type through the polymorphic `this`. |
| a mixin base class supplying `activate`'s signature | **fails** — `Parameter 'cx' implicitly has an 'any' type`. A derived class's method parameters are never contextually typed by the base. |

The last two are the ones worth recording, because both look like they should work and neither does.
`this['needs']` is the shape that would remove the second `typeof NEEDS`, and it is simply not
available. A mixin looks like it should let the base supply the signature, and TypeScript's rule that
derived method parameters get no contextual type from the base kills it.

The one shape with *no* annotation at all is an object literal passed to a generic helper — full
contextual inference, nothing written twice. It is not used here, because it is
`defineExtension({...})` in all but name, and the reasons for a class stand
([§2](#2-the-bundle-contract--decided)). The class costs one type annotation on `activate`; that is
the whole price, and it is worth paying.

`implements` is optional — the kernel checks structurally, so a class without it still loads. Keep it
anyway: it is what turns "I forgot to return the thing I said I provide" into an error in this file
rather than a surprise in a consumer.

### Why narrowing, and not a `Shell`

The previous generation handed every extension a `Shell` object carrying `layout`, `activityBar`,
`tabs`, `docking` and `transport`. Every extension was therefore implicitly an extension *of an IDE*:
a blog written against it still received a docking system, and a host that did not have tabs could
not run it at all.

Declaring capabilities is what lets one Extension run unchanged whether the host arranges windows as
tiles, as floating windows, or as a single maximised page.

---

## 3. What an Extension contributes — **Decided in shape, Proposed in detail**

An Extension is a manifest with code attached, exactly as an Application is
([Applications §2](./application.md)). The same rule decides which half a thing belongs in:

> **Anything the kernel needs before the Extension runs must be declared, not registered.**

**Declared, as data on the class — read at [boot step 3](./kernel.md), before anything activates:**

| declaration | notes |
| --- | --- |
| `commands` | id and title. The body comes from `activate`, checked against the declared ids. |
| `keys` | default bindings, overridable by the user through the registry. One parser reads them ([roadmap A1.4](./roadmap.md)). |
| `menus` | `menubar`, `window`, `status`, `context:*` |
| `views` | views an Application or the user can put in a window |
| `settings` | schema and defaults, folded into the registry at [boot step 5](./kernel.md) |
| `components` | the vocabulary an Extension adds ([view-layer §3](./view-layer.md)) |
| `needs` / `consumes` / `provides` | what it uses and what it exposes |

**Obtained at run time, through capabilities it declared:**

| through | for |
| --- | --- |
| return value of `activate` | the provider API other contributors consume |
| `notifications` | as a caller; the *surface* is a different Extension |
| `storage` | including contributing a remote provider |
| `net`, `events`, `models` | talking to the site's API |
| `log` | already tagged with who logged |

The distinction matters most for `keys`. A binding created by calling `cx.keys.bind()` **cannot be
rebound by the user** without the Extension's cooperation; a binding declared as data is overridden
by the registry like any other setting.

Everything obtained at run time is disposed by the kernel when the Extension stops. A contributor is
not trusted to clean up after itself, because the case that matters is the one that crashed.

---

## 4. `provides` and `consumes` — **Decided**

The typed boundary between contributors that never import each other.

```ts
declare const PROVIDED: unique symbol;

export interface ProviderToken<T> { readonly id: string; readonly [PROVIDED]?: T; }
export function provider<T>(id: string): ProviderToken<T> { return { id }; }
export type Provided<TToken> = TToken extends ProviderToken<infer T> ? T : never;
```

The `unique symbol` phantom is what carries `T` across a boundary neither side imports over. A
consumer writes:

```ts
const NEEDS    = needs('mesh');
const CONSUMES = consumes(AUTH);          // same helper shape as needs()

readonly needs    = NEEDS;
readonly consumes = CONSUMES;

activate(cx: Context<typeof NEEDS, typeof CONSUMES>) {
    const auth = cx.use(AUTH);     // typed AuthApi, with no import of AuthExtension
    auth.session();                // and no `any` anywhere
}
```

`Context<TNeeds, TConsumes>` is `CapabilityContext<TNeeds> & Consumer<TConsumes>` — one type
parameter per declaration, so the two lists stay independent and each is written once.

Three rules:

- **`provides` is checked against `activate`'s return type.** Declaring a token you do not return is
  a compile error.
- **`consumes` restricts `cx.use`.** Using a token you did not declare is a compile error, and the
  kernel does not resolve it at run time either.
- **Tokens are identity, not implementation.** Two Extensions may provide the same token in different
  builds — a mock auth provider in development, the real one in production — and no consumer changes.

That last one is the reason for tokens rather than direct imports, and it is the same argument as
swappable storage providers in [storage §4](./storage-and-registry.md).

### Where the public interface lives — **Proposed**

`provides` says *that* an Extension has a public interface. It does not say where the interface is
written down, and that is the question that decides whether any of this survives contact with more
than one repository.

The constraint: **a consumer must get `AuthApi`'s type without importing `AuthExtension`.** If it
imports the implementation it has pulled in the whole Extension, its dependencies and its side
effects, and the token bought nothing.

So the interface and the token live in a third place — small, types plus one constant, no
implementation:

```ts
// @surfdns/auth-contract — imported by the Extension and by every consumer
import { provider } from '@flybyme/mesh-web';

export interface AuthApi {
    readonly session: Signal<Session | null>;
    signIn(): Promise<void>;
    signOut(): Promise<void>;
}

export const AUTH = provider<AuthApi>('identity.auth');
```

Three consequences worth being explicit about:

- **It is a real dependency, not a type-only one.** `AUTH` is a runtime value — an object with an
  `id`. It is a few bytes, but `import type` will not do, and a build that assumes contract packages
  are erasable will break.
- **The contract package is the thing that gets versioned**, and it is the only thing both sides
  share. Changing `AuthApi` is a breaking change to a published interface, which is exactly the
  visibility that makes it hard to change casually.
- **It is where a site's own conventions live.** `@surfdns/auth-contract` is surfdns's, not
  mesh-web's. The framework ships `provider()` and nothing else; what a site's Extensions expose to
  each other is the site team's business, the same as
  [what it exposes over HTTP](./hosting.md) §5.

An Extension may provide **more than one token**, and should when the audiences differ — a narrow
`AUTH` that most consumers use, and a wider `AUTH_ADMIN` that the settings screen uses. That is
cheaper than one interface with optional members, because `consumes` then records which consumer
needed the privileged surface.

### What shape a provider API may be — **Proposed**

A gap the isolation decision opens, and it needs stating before anyone writes a second provider.

`cx.use(AUTH)` returns an object today because everything shares one realm. If an Application ever
runs in a worker ([kernel §9](./kernel.md)), it cannot hold a reference to an object living on the
main thread, and a provider API shaped as an ordinary object stops working.

The demo's `AuthApi` already fails this test. `can(action: string): boolean` is **synchronous** and
computes over state the Extension holds — there is no way to answer it across a boundary without
blocking.

So a provider API is an **interface, not an object graph**, and it may only be made of three things:

| | | across a boundary |
| --- | --- | --- |
| **async methods** | `signIn(): Promise<void>` | a message and a reply |
| **signals** | `session: Signal<Session \| null>` | mirrored by the kernel, the same machinery as view patches |
| **plain data** | `readonly baseUrl: string` | copied once |

And **nothing else** — no synchronous methods over provider state, no class instances, no callbacks
passed in, no DOM.

**Where the synchronous logic goes:** the contract package, as a pure function over mirrored state.

```ts
// @surfdns/auth-contract
export interface AuthApi {
    readonly session: Signal<Session | null>;
    readonly grants:  Signal<readonly string[]>;   // mirrored, not asked for
    signIn(): Promise<void>;
    signOut(): Promise<void>;
}

/** Pure. Runs wherever the caller is, over data it already has. */
export function can(grants: readonly string[], action: string): boolean { ... }
```

Which is better than the method it replaces even with no isolation anywhere: `can` becomes testable
without an Extension, and a consumer that re-renders on `grants` changing gets that for free because
it is a signal rather than a question.

The rule, in one line: **state is signals, actions are async, logic is a pure function in the
contract package.**

**The alternative, considered and not taken.** Module augmentation would let the id carry the type
with no import at all:

```ts
declare module '@flybyme/mesh-web' {
    interface Providers { 'identity.auth': AuthApi }
}
// then: cx.use('identity.auth')  — typed, no token import
```

Nicer at the call site, and the editor completes the string. Rejected because it is a global
namespace: two independently-built Extensions can claim the same key with different types, and
whichever augmentation happens to be loaded wins. A token is a value, so a collision is a build
error rather than a silent disagreement — and this framework is explicitly for many sites by many
authors ([hosting §3](./hosting.md)).

---

## 5. Activation order — **Proposed**

The kernel topologically sorts Extensions by `consumes` against `provides`, then activates in that
order ([kernel §3](./kernel.md) step 7).

- **A cycle is a boot failure**, reported naming both ends. Not broken by lazy proxies: a cycle
  between two Extensions is a design error, and hiding it produces a system whose behaviour depends
  on load order.
- **An unresolved `consumes` is a failure for that Extension**, not for boot. It does not activate,
  and its own consumers cascade — one error, naming the root ([kernel §7](./kernel.md)).
- **Order among independent Extensions is undefined**, and should be *deliberately* undefined:
  anything that depends on it has an undeclared dependency and should declare it.

---

## 6. Lifecycle — **Proposed**

**Extensions activate once and are never deactivated.**

This is a real decision and the alternative was considered. VS Code deactivates extensions and pays
for it forever: every extension author must write teardown that is exercised rarely and therefore
wrong, and the failure mode is a leak nobody can attribute.

The argument for making them permanent is that it matches what an Extension *is*. It is installed, it
is singleton, its providers are held by everything that consumes them, and there is no coherent
answer to what happens to a consumer when its provider deactivates. The system already has a thing
that starts and stops with clean semantics — that is an Application, and something wanting a
lifecycle should be one.

What follows:

- **No `deactivate`.** Nothing to implement, nothing to get wrong.
- **Enabling or disabling an Extension is a build or a reload**, not a runtime toggle. The site
  declares its Extensions in the deployment descriptor ([hosting §5](./hosting.md)).
- **A failed Extension stays failed** for the life of the page. It is reported, not retried.

The cost, stated: developing an Extension means reloading. Acceptable, and cheaper than the whole
category of teardown bugs. Hot reload in dev is a separate mechanism and can be built later without
changing this contract.

### Eager or lazy — **Proposed: eager, with one exception**

VS Code's activation events exist because it has thousands of extensions and a startup budget. A site
has a handful, chosen by its own team and shipped in its own build.

So: **activate everything at boot.** No activation events, no lazy proxies, no observable difference
between "installed" and "active". Predictable, and it makes §5's ordering meaningful.

The exception worth allowing is an Extension declaring itself `deferred`, activated after first
paint, for something genuinely not needed to render — a log shipper, a telemetry sink. Its providers
are unavailable until then, so nothing may `consume` a deferred Extension.

---

## 7. Where Extensions come from — **Decided**

> "every new extension or app will be its own repo unless they are built in"

Three origins, one contract:

**Built in.** Shipped with mesh-web: the process manager, the command palette, the notification
surface, the settings editor. Privileged only in being present by default — [kernel §2](./kernel.md)
requires them to be written against the same interfaces an outside author gets, because that is the
only honest test that those interfaces are usable.

> **The workbench is not one of them — corrected 2026-09-04.** This list named it first, and that was
> wrong twice over. **The IDE is a different product from the framework it is written with**, so a
> blog installing `@flybyme/mesh-web` should no more receive an activity bar than it should receive a
> docking system — which is the same argument §1 makes about the `Shell` object, one level up.
>
> And keeping it inside `src/` quietly weakened the only claim it exists to make. §8a's argument is
> that the shell needs no privileged access; a file inside the package reaching into
> `../contribution/capabilities.js` cannot demonstrate that, because it would have had that reach
> whether or not the capability existed. Moved out to `browser/workbench.ts`, importing
> `@flybyme/mesh-web` by name, **the proof became real and immediately failed**: `Chrome` and
> `ChromeWindow` were never exported from the public entry, so no outside author could have written
> this file at all. One minute outside the package found what a day inside it had not.

**Site-supplied.** In the site's own repo or a repo it depends on. The auth Extension is the usual
one: it holds the session, attaches the ticket, and handles the revocation event. One per site,
because [the site is the boundary](./hosting.md) — one Application signing in does not sign you into
another site's API.

**Third-party.** Its own repo, built by the CDN, declared by the site that wants it. Same contract.
The security position is unchanged and worth repeating: capabilities constrain *architecture*, not
*trust*. A third-party Extension runs in the same realm as everything else, and the reason that is
survivable is that the API is the gatekeeper ([kernel §4](./kernel.md), [auth §5](./auth.md)).

---

## 8. The workbench is an Extension — **Decided**

> "i think i should be able to write an extention that would cover the 'workbench' idea too"

The chrome of an IDE — activity bar, tabs, panels, status bar — is an Extension over the kernel's
window manager, not a mode baked into the framework. This is the load-bearing test of the whole
design: if the IDE shell cannot be written as an ordinary Extension, the capability split is wrong,
and it is much better to learn that from writing the workbench than from the first outside author.

It is also what closed the previous attempt: PR #6 proposed shell *profiles* that baked two layouts
into the framework, which is the same mistake as the `Shell` god object one level up.

### The IDE is an Application that consumes a Workspace Extension — **Decided**

> "the ide is an application that consumes a workspace extension right?"

Yes, and saying it this way fixes a drift: this section called the workbench an *Extension*, while
[the model §on nesting](./README.md) called it "a workbench **Application** hosting other
Applications in its own tiles". Both were right about different things and both said "workbench".
The two names are now separate:

| | what it is | why |
| --- | --- | --- |
| **the IDE** | an Application | you start it, you quit it, it is in the process table, and two of them can be open on two projects |
| **the Workspace** | an Extension | installed, not run; kill it and everything consuming it breaks |

That is §1's test applied twice and getting two different answers, which is what makes the split
real rather than a naming preference.

**The constraint this puts on the Workspace Extension is the interesting part.** An Extension is
singleton by nature and an Application has N instances, so a Workspace Extension cannot *be* a
workspace — two IDE windows on two projects would fight over one Extension's state. It **provides**
them: `provides = WORKSPACE`, and `activate()` returns an API that opens a project and hands back a
handle per caller. A driver, not a document. That is the same shape as the auth Extension
([hosting §on the singleton](./hosting.md)) — one thing that owns the resource, many callers holding
what it gave them.

It also settles what the nesting line was reaching for: the IDE Application hosts other Applications
in its tiles, and what they have in common is not the chrome — it is the workspace they all read the
project through.

### What writing it found: the `chrome` capability — **Decided**

Built 2026-09-04. §8 calls this section's claim the load-bearing test of the design, and the first
honest attempt at it failed: **the capability split, as it stood, could not express a workbench.**

`windows` gives a contribution `open()` and `own()`. A workbench could therefore see the windows it
opened itself and nobody else's — and drawing a tab for every window is the entire job. There was no
narrower thing missing; the shape simply was not there.

The wrong repair is to hand the workbench the `WindowManager`. That is [kernel §2](./kernel.md)'s
`Shell` god object one layer down — the previous generation gave every extension
`layout, activityBar, tabs, docking, transport`, so a blog received a docking system — and it would
also make every field the manager happens to store part of what an outside author writes against.

So: `needs('chrome')`, following the three rules the `credentials` capability established
([network §4](./network.md)):

- **Declared, therefore visible.** Observing every window is observing every Application, and
  [kernel §4](./kernel.md)'s question answers *yes*. That is the reason it is written down in a
  manifest rather than made ambient, not a reason to refuse it.
- **Narrow.** A stated `ChromeWindow` — id, owner, view, title, tile, rect, closable — never the
  manager's record.
- **Mechanics stay in the kernel.** §2 is explicit that moving, resizing and stacking are kernel and
  not a decoration Extension. Chrome renders a resize edge and *reports the drag*; the kernel decides
  what it means, applies the view's minimum size, and clamps to the viewport. A hostile chrome can
  ask for anything and get what the kernel allows.

Writing the third rule down immediately caught a violation of it. `closable` was stored on a window,
handed to chrome, and **enforced nowhere** — so it told chrome which affordance to draw and stopped
nothing, and any chrome could close a permanent window by asking. It is enforced now. Process
teardown still ignores it, because the flag means *the user may not dismiss this*, not *this window
outlives its Application*.

### Where chrome draws: chrome describes the page, and says where the windows go — **Decided**

An activity bar and a tab strip are the frame *around* the windows, not windows, so chrome needs a
surface outside the window area. Three shapes were considered and two are wrong:

**A DOM handle is wrong.** [kernel §2](./kernel.md) gives the kernel that the DOM exists at all, and
it must not be replaceable by the code it renders. Handing chrome an element hands it that.

**Named regions are wrong** — `top`, `bottom`, `left`, `right`, or worse `activityBar` and
`statusBar`. That is PR #6's shell *profiles* returning in different clothes: a docking model baked
into the framework, which every site then pays for and no site can escape. §8's whole argument is
that the shell must not be a mode.

**So the surface is inverted.** Chrome describes the **whole page**, and one node in that description
says *the windows go here*:

```ts
activate(cx: CapabilityContext<typeof NEEDS>) {
    return {
        render: () => element('div', { class: 'shell' }, [
            tabStrip(cx.chrome.windows()),
            cx.chrome.host(),          // ← the window area, wherever chrome puts it
            statusBar(cx.chrome.focused()),
        ]),
    };
}
```

`cx.chrome.host()` returns an ordinary description node the kernel recognises. After mounting
chrome's description the kernel finds it and mounts the window layer inside — so chrome lays out
anything it likes around the windows, in any arrangement, and still never touches the DOM or the
mounting. The framework gains exactly one new concept, *"the window area goes here"*, and names no
layout at all. A site with no chrome Extension gets the window layer mounted at the root, which is
what makes chrome genuinely optional rather than a mode with a default.

Two constraints fall out and both are real:

- **The host must be unconditional.** Inside a `when` or an `each` it would be destroyed and
  recreated, re-parenting every window — and re-parenting resets scroll, which is the exact defect
  the no-remount design exists to prevent ([the model](./README.md)). The kernel checks the host is
  still attached after a reconcile, so this fails loudly rather than as mysterious scroll loss.
- **Chrome that forgets the host is a broken site**, not a site with no windows, so it is refused at
  boot rather than rendered.

**What this found: the window layer was not in the framework.** A6.3 asks whether the workbench can be
written as an Extension *over the window manager* — and the thing that painted windows was 900 lines
of `browser/harness.ts`, demo code, not part of the package at all. The manager tracked windows;
nothing in `src/` rendered them. So chrome could not wrap the shell until the shell existed to be
wrapped, and the order became: extract the window layer (A6.3e), then chrome (A6.3d).

That was not a detour. A framework whose only shell lives in its own demo has not shipped a shell, and
this is how that gets noticed.

---

## 8a. The answer: yes — **Decided**

Built 2026-09-04. `src/workbench/extension.ts` boots through the ordinary Extension path, declares
`needs('chrome', 'state', 'commands', 'log')`, provides `PAGE_CHROME`, and returns a description with
a tab strip above the window area and a status bar below it.

**What is not in that file is the whole argument.** No `Shell` object. No privileged import. No
reaching into the kernel, and no DOM. Every affordance is a declared command dispatched by the page —
so a tab is bindable to a key and reachable from a palette rather than only clickable, and the
workbench holds no callbacks of its own. Everything it does, an outside author can do, which is the
only honest test that these interfaces are usable.

Two tests carry the claim:

- an Application running **beside** it declares `needs('windows')` and has no name for the workbench,
  no way to enumerate contributions, and no path to `chrome`. It never learns a shell is there.
- a site that installs **no** workbench gets the window layer at the root, two working windows, and
  no chrome at all. Chrome is optional, not a mode with a default.

The question was worth asking precisely because the answer was **no** three times first: no capability
to see other windows, no window layer in the package, no surface to draw on. Each was found by trying
to write the thing rather than by reading the design, which is what §8 predicted and why it said to do
this before the first outside author does.

---

## 9. Open

- **Extension settings.** An Extension declaring a settings schema, and where the editor for it lives.
  Wants [storage §5](./storage-and-registry.md)'s registry and a `conflict` policy first.
- **Whether an Extension can contribute a capability**, rather than only consuming them. A storage
  provider is already close to this. If yes, the kernel's capability broker takes registrations, which
  weakens [kernel §2](./kernel.md)'s table — so probably no, and providers are the answer.
- **Versioning and compatibility.** A third-party Extension built against an older contribution API.
  Nothing here yet, and it is not urgent until there are third-party Extensions.
- **Dev-mode hot reload**, per §6.
- **Whether `deferred` is worth the exception it introduces**, or the simpler rule should just win.
