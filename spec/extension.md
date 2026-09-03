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
import type { Extension, CapabilityContext } from '@flybyme/mesh-web';

const AUTH = provider<AuthApi>('identity.auth');

export default class AuthExtension implements Extension<['net', 'notifications'], [], typeof AUTH> {
    readonly needs = ['net', 'notifications'] as const;
    readonly provides = AUTH;

    activate(cx: CapabilityContext<['net', 'notifications']>): AuthApi {
        cx.net.baseUrl;               // declared
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

**`needs` narrows the context.** `readonly needs = [...] as const` produces
`CapabilityContext<TNeeds>` with exactly those capabilities on it — a compile error for anything
else, and `undefined` at run time, because the kernel builds the object from the same list
([kernel §4](./kernel.md)).

**`activate` returns what the Extension provides.** Not a side-channel registration — a return value,
checked against the declared `provides`.

### Why narrowing, and not a `Shell`

The previous generation handed every extension a `Shell` object carrying `layout`, `activityBar`,
`tabs`, `docking` and `transport`. Every extension was therefore implicitly an extension *of an IDE*:
a blog written against it still received a docking system, and a host that did not have tabs could
not run it at all.

Declaring capabilities is what lets one Extension run unchanged whether the host arranges windows as
tiles, as floating windows, or as a single maximised page.

---

## 3. What an Extension contributes — **Decided in shape, Proposed in detail**

Through capabilities it declared, and nothing else:

| contribution | capability | notes |
| --- | --- | --- |
| commands | `commands` | id, title, typed arguments, a handler |
| key bindings | `keys` | bindings are data, and one parser reads them ([roadmap A1.4](./roadmap.md)) |
| menu items | `menus` | `menubar`, `window`, `status`, `context:*` |
| views | `windows` | a view an Application or the user can put in a window |
| providers | return value | the typed API other contributors consume |
| notifications | `notifications` | as a caller; the *surface* is a different Extension |
| storage providers | `storage` | a remote provider is an Extension contribution |
| log scopes | `log` | already tagged with who logged |

Every one of these is disposed by the kernel when the Extension stops. A contributor is not trusted
to clean up after itself, because the case that matters is the one that crashed.

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
readonly consumes = [AUTH] as const;

activate(cx: CapabilityContext<['net']> & Consumer<[typeof AUTH]>) {
    const auth = cx.use(AUTH);     // typed AuthApi, with no import of AuthExtension
    auth.session();                // and no `any` anywhere
}
```

Three rules:

- **`provides` is checked against `activate`'s return type.** Declaring a token you do not return is
  a compile error.
- **`consumes` restricts `cx.use`.** Using a token you did not declare is a compile error, and the
  kernel does not resolve it at run time either.
- **Tokens are identity, not implementation.** Two Extensions may provide the same token in different
  builds — a mock auth provider in development, the real one in production — and no consumer changes.

That last one is the reason for tokens rather than direct imports, and it is the same argument as
swappable storage providers in [storage §4](./storage-and-registry.md).

---

## 5. Activation order — **Proposed**

The kernel topologically sorts Extensions by `consumes` against `provides`, then activates in that
order ([kernel §3](./kernel.md) step 5).

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

**Built in.** Shipped with mesh-web: the workbench, the process manager, the command palette, the
notification surface, the settings editor. Privileged only in being present by default —
[kernel §2](./kernel.md) requires them to be written against the same interfaces an outside author
gets, because that is the only honest test that those interfaces are usable.

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
