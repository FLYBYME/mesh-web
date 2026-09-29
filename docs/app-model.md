# The app model: App → Service / View → Component → Primitive

> **Status: design, not implemented.** "Today" statements are verified against `src/` and the
> `surfdns-*` web apps as of 2026-09-28 (mesh-web v0.19.4). Everything else is the design this
> branch builds toward.
>
> **Scope (decided 2026-09-28):** a breaking rewrite on the `components` branch. The only consumer
> that must keep working is `surfdns-company-site`; every other mesh-web consumer (mesh-core, the
> other `surfdns-*` apps) is allowed to break. Kept stable on purpose, because mesh-serve builds and
> boots every site through them: the `start` export, `@flybyme/mesh-web/net` (`call`, `defineApi`,
> used by generated clients), and "a part's entry default-exports its class".

---

## 1. Why

What mesh-web gets right — fine-grained signals, descriptions as data, a capability boundary, a
renderer that never lets a view touch the DOM, the window manager — stays. What is wrong is the
layer an author actually writes in:

- **There is no service.** Anything shared (the session, the API client, a cart) has to be an
  Extension with a `provider('id')` token that consumers `consumes(TOKEN)` and `cx.use(TOKEN)` —
  three pieces joined by a string — or it goes into one app's `internal`. So everything goes into
  `internal`.
- **There is nothing between the app and `element('Stack', ...)`.** A view is a pure function of the
  app's `internal`; a component is a pure function of props; a composite (`defineComposite`) has
  state but no owner — nothing mounts it, scopes it or disposes it. So all state and all behavior
  go up into `start()`.
- **Everything is declared twice and joined by a string.** `commands: [{ id }]` ↔
  `cx.commands.implement(id, ...)`; `views` ↔ an `internal` type kept in step by hand; `publishes` ↔
  what `start()` returns, reconciled by `checkBindings` at run time. Every "silently does nothing"
  bug this repository has recorded (A8.10, the inert composites) sits on one of those joins.
- **Most of `Declarations` does nothing for app code.** `menus` and `stores` are collected into the
  manifest (`kernel/manifest.ts`) and never read again; `settings` is only collision-checked;
  `layout`, `title`, `session` and `singleton` are site decisions sitting on the app.
- **A single-page site is second-class.** `router/match.ts` maps a URL to
  `/<applicationId>/<view>?query`: the app id is in the path, params are query strings only, and
  there are no route patterns. `surfdns.net/domains/example.com/records` is not expressible.

The evidence in the apps: `surfdns-repo/src/web/repo.app.ts` has a 233-line `start()` with ten
`cx.commands.implement` calls; `surfdns-domains/src/web/domains.app.ts` is 722 lines. Across every
`surfdns-*` web app, mesh-core's stateful composites (`Form`, `ActionButton`, `ActionCard`,
`SignIn`) are imported zero times, while the modal pattern is hand-written in seven views across four
apps. `recordModal.view.ts` takes `app: DomainsAppState` and writes through
`command('domains.setRecordField', ...)`, so it cannot be used anywhere but the domains app.

## 2. The model

```
App         routes, services, app-wide commands. Small.
 ├─ Service one instance per page, shared by injection: Auth, Cart, Notifications
 ├─ View    what a route mounts; its own state, typed params, its own commands
 │   └─ Component   reusable; its own state; made of more components
 │        └─ Primitive   Stack, Text, Button, Input — what the renderer draws
```

For anyone who knows AngularJS: App ≈ module, Service ≈ service, View ≈ route + controller,
Component ≈ directive with a controller, Primitive ≈ the DOM.

Five rules hold across every layer:

1. **Every unit is a class the kernel constructs.** Nobody writes `new` for a service, view or
   component. The constructor is the lifecycle start; `dispose()` is the end.
2. **State is fields.** No `internal`, no `ApplicationStartResult`, no `start()` returning a record.
3. **What the kernel must know before running is `static`.** `needs`, `inject`, `routes`, `params`
   are readable from the class without constructing it — so the manifest is *derived* from the code,
   not written beside it.
4. **Capabilities and services only narrow going down.** A unit can use only what it declares, and
   can declare only what its host has. A violation is a compile error at the use site and a thrown
   error at run time — never a silently missing key.
5. **Nothing is joined by a string an author has to keep in step.** Routes point at classes;
   injection names classes; commands are objects; outputs are typed callbacks.

## 3. Service — the missing layer

```ts
export class AuthService extends Service {
    static readonly needs = needs('mesh', 'storage');

    readonly session = signal<Session | null>(null);
    readonly signedIn = computed(() => this.session() !== null);

    readonly signIn = command({
        title: 'Sign in',
        input: z.object({ email: z.string().email(), password: z.string().min(1) }),
        output: SessionSchema,
        run: async (input) => {
            const session = await this.cx.mesh.call('identity.session_create', input);
            this.session.set(session);
            return session;
        },
    });

    readonly signOut = command({
        title: 'Sign out',
        run: async () => { await this.cx.mesh.call('identity.session_delete', {}); this.session.set(null); },
    });
}
```

- **One instance per page**, constructed on first injection and never disposed before the page
  goes. Two views injecting `AuthService` get the same object — that is the point.
- **The class is the token.** `static inject = { auth: AuthService }` replaces
  `provider('auth')` + an Extension that `provides` it + `consumes(AUTH)` + `cx.use(AUTH)`.
- **A service has its own `needs`,** granted by the site, not by whoever injects it. A view that
  injects `AuthService` does not need `mesh` itself.
- **Services can inject services.** Cycles are an error at load, from the static `inject` graph.
- Replaces: `Extension`, `provider()`, `consumes()`, `cx.use()`, and the reason `start()` existed.

## 4. App

```ts
export default class CompanySite extends App {
    static readonly routes = {
        '/':                       HomeView,
        '/pricing':                PricingView,
        '/sign-in':                SignInView,
        '/account':                AccountView,
        '/domains/:zone/records':  RecordsView,
    };
    static readonly services = [AuthService];      // constructed eagerly at boot; others lazily
    static readonly api = apiSurfdnsNetApi;
}
```

That is the whole file for a site with no app-wide commands. An App may inject services and define
commands like any other unit; most will not need to.

Replaces: `Application`, `start()`, `stop()`, `ApplicationStartResult`, `internal`, `views`,
`Declarations`.

## 5. View

```ts
export class RecordsView extends View {
    static readonly needs = needs('mesh', 'models');
    static readonly inject = { auth: AuthService };
    static readonly params = z.object({ zone: z.string() });   // checked against ':zone' in the route
    static readonly title = (p: { zone: string }) => `Records · ${p.zone}`;

    readonly records = this.cx.models.collection('domains.record');
    readonly adding = signal(false);

    readonly add = command({
        title: 'New record',
        key: 'alt+k',
        run: () => this.adding.set(true),
    });

    render(): Node {
        return element('Stack', {
            children: [
                element('Button', { intents: { activate: { action: this.on(() => this.add.run()) } },
                                    children: [text('+ New record')] }),
                RecordTable.mount(this, { rows: this.records.rows }),
                when(() => this.adding(), () =>
                    RecordEditor.mount(this, {
                        zone: () => this.params.zone,
                        onSaved: () => this.adding.set(false),
                        onCancel: () => this.adding.set(false),
                    })),
            ],
        });
    }
}
```

- **A view is what a route mounts.** In a single-page site the router mounts one view per URL into
  the page. In the windowed OS the same routes open as windows, and a window's address *is* its
  route. A view does not know which mode it is in.
- **Params are typed and validated.** The route's path parameters are extracted at the type level
  (template-literal types over `'/domains/:zone/records'`) and must match `static params`; the URL is
  parsed through the schema before the view is constructed.
- **Its state is its own.** Two windows on the same route are two instances.
- Replaces: `ViewDecl`, `ViewContext`, `vx.internal`, `vx.app`.

## 6. Component

```ts
export class LoginForm extends Component<{ onDone?: () => void }> {
    static readonly inject = { auth: AuthService };

    readonly email = signal('');
    readonly password = signal('');
    readonly error = signal<string | null>(null);
    readonly busy = signal(false);

    render(): Node { /* fields bound to the signals; submit calls this.submit */ }

    private async submit(): Promise<void> {
        this.busy.set(true);
        this.error.set(null);
        try {
            await this.inject.auth.signIn.run({ email: this.email(), password: this.password() });
            this.props.onDone?.();
        } catch (err) {
            this.error.set(err instanceof Error ? err.message : String(err));
        } finally {
            this.busy.set(false);
        }
    }
}
```

**One login component.** `SignInView` mounts it full-page; a "session expired" dialog mounts it in a
dialog; a checkout step mounts it inline. The session lives in `AuthService`; the form's own state
(what was typed, busy, the error) lives in the instance and dies with it.

- `Component.mount(host, props)` produces a description node. The renderer constructs the instance
  inside its own reactive scope when the node is built, and disposes it when the node leaves — a
  `when` flip, an `each` row removed, the view unmounted. (`buildWhen` and `buildEach` already give
  every branch and row a scope; a `buildMount` sits beside them.)
- `render()` runs once per instance. Reactive reads go in thunks, as today.
- Outputs are typed callback props (`onDone`, `onSaved`), not command ids.
- `this.on(fn)` is instance-scoped: handlers are removed when the instance is disposed. (Today the
  window's handler table has no per-entry removal, so a `vx.on` inside an `each` row lives until the
  window closes — this fixes a leak that exists now.)
- Replaces: `defineComponent`'s stateless-only role for anything with behavior, `defineComposite`,
  `CompositeContract`, and the required `on: Registrar` prop.

## 7. Command

A command is one object: its title, key, schemas and implementation, defined as a field on whatever
owns it.

```ts
readonly create = command({
    title: 'New record',
    key: 'alt+k',
    input: z.object({ type: RecordType, name: z.string(), value: z.string() }),
    output: DnsRecordSchema,
    run: async (input) => { /* ... */ },
});
```

- **No `implement`.** The declaration is the implementation.
- **Lifetime is the owner's.** A view's commands are live while the view is mounted — so `alt+k`
  means "new record in the view in front of you", which the old global-id model could not say. An
  app's commands live with the app; a service's are global.
- **The schema does real work:** input is validated at the boundary; the palette can build a form
  from `input` when a command needs one; a tool or agent gets a typed signature.
- **This is what a part publishes.** A command with `input`/`output` schemas on a service or app is
  callable from outside; one without is local. There is no separate `publishes` declaration and no
  `checkBindings`.
- A button calls a command as `this.on(() => this.create.run(input))`, or passes the command itself
  to a primitive that knows how to show it running and refused (`Availability` carries over).
- Replaces: `CommandDecl`, `KeyDecl`, `cx.commands.implement`, `command('id')` actions, `publishes`,
  `ApiDecl`, `checkBindings`.

## 8. Primitive

What the renderer draws: `Stack`, `Text`, `Button`, `Input`, `Form`, `Dialog`, … . `Declarations.components`
(`PrimitiveDefinition[]`) is renamed **`primitives`**, because that is what it is.

Open for this layer: `element('Stack', { ... })` names a primitive by string — the same string join
rule 5 removes everywhere else. Typed primitive functions (`Stack({ ... }, children)`) would make a
misspelled primitive a compile error. Not required for the first cut.

## 9. What is deleted

| Deleted | Because |
|---|---|
| `Application`, `start()`, `stop()`, `ApplicationStartResult`, `internal` | App is a class; state is fields |
| `Extension`, `activate()`, `provider()`, `consumes()`, `cx.use()` | Service |
| `ViewDecl`, `ViewContext` | View |
| `defineComposite`, `CompositeContract`, `Registrar` as a prop | Component |
| `CommandDecl`, `KeyDecl`, `cx.commands.implement`, `command('id')` | Command objects |
| `publishes`, `ApiDecl`, `checkBindings` | Commands with schemas |
| `menus`, `stores`, `settings` | Collected, never used for app code |
| `layout`, `title`, `session`, `singleton` on the part | Site composition / policy |

Kept: reactivity, the description model, the renderer, the window manager (as a presentation mode
of the router), `net`, `models`, capabilities.

## 10. Kernel work, in order

1. **Type tests first**, with `@ts-expect-error` cases, before any runtime code:
   - a unit using a capability it did not declare;
   - mounting a component whose `needs` or `inject` the host lacks;
   - a route whose `:param` is missing from the view's `params` schema;
   - a command called with input that does not match its schema;
   - a service injection cycle (runtime, from the static graph).
   If any of these needs `as any` / `as never` to express, the design changes, not the types.
2. The service container: construct once per page from static `inject`/`needs`, cycle check.
3. The `mount` node and `buildMount`; instance-scoped handlers; disposal order (scope, handlers,
   `dispose()`).
4. Commands as objects: discovery on mount, removal on dispose, key collisions reported when a
   binding goes live.
5. The router: path patterns, typed params, one view per URL in single-page mode; windows as a mode
   over the same routes.
6. Delete what §9 lists. Rename `components` → `primitives`.
7. Rewrite `surfdns-company-site` on it. Tests press buttons; none call `run()` directly (the A8.10
   lesson).

## 11. Open questions

- **The word "service".** In this codebase a service is already a server-side `ServiceModule`
  (`@flybyme/mesh`), and `*.site.json` has `kind: 'service'` for exactly that. A browser-side
  `Service` is a different thing with the same name. Keep it and qualify where needed, or pick
  another word.
- **Who grants a service its `needs`.** The site composition, presumably — which means mesh-serve's
  site schema learns about browser services.
- **Serialisability.** A `mount` node holds a class and closures, so a description containing one is
  not plain data. `surface` already holds a function, so this is not the first such node, but the
  worker/SSR path (`docs/workers-and-ssr.md`) must treat it as opaque.
- **Keyed mounts.** Props flow in reactively without reconstructing; a prop change that should
  re-mount (a different record entirely) needs a `key`, as `each` has.
- **What mesh-serve reads.** Its builder writes the site manifest; confirm it can get routes, needs
  and api by importing the module rather than parsing source.
- **Instance commands vs the static manifest.** Commands are found on mount, so the palette and key
  collisions are only known for what is mounted. That is the intended semantics, but it means a site
  review cannot list every command without running it — only every schema-bearing command on services
  and apps.

## 12. Phase 1 findings (2026-09-28)

Phase 1 (`src/app/`, `test/app-model.types.ts`, `test/app-command.test.ts`) changed the design in
four places. Where the examples above disagree, this section and the code win.

- **The spec is passed to the base, not written as statics.** A class cannot name its own statics in
  its `extends` clause (`class A extends View<typeof A>` is a circularity error), so the base cannot
  see a subclass's `static needs`. Instead: `class RecordsView extends View({ needs, inject, params })`.
  The spec is still static and readable without constructing anything — `RecordsView.spec`.
- **`View` and `ComponentBase` are named abstract classes, not class expressions.** Returned from a
  function, a class expression's `abstract render()` is emitted to the `.d.ts` as a plain method, so a
  package consumer could declare a view with no `render` and get no error. Found only by compiling
  the type tests against the *emitted declarations*; the whole type-test file is now checked that way
  as well as against source.
- **Services are not narrowed.** Rule 4 narrows *capabilities* down the tree; injection is not
  narrowed. A service is the sanctioned way to share power — a component without `mesh` may inject
  `AuthService` and call `signIn`, which uses `mesh`. That is delegation through a narrow, typed
  surface, not escalation. Who grants a service its own `needs` is still open (§11).
- **Injection cycles cannot be written.** `extends Service({ inject: { b: B } })` is evaluated where the
  class is written, so a service can only inject one declared before it (TS2449 otherwise). The
  kernel's runtime cycle check becomes a backstop for cross-module import order, not the rule.
- **A command has two types.** Callers pass the schema's *input* type; `run` receives its *output*.
  `z.object({ ttl: z.number().default(300) })` accepts `{}` and produces `{ ttl: 300 }`. Read from
  zod's `_input` phantom, falling back to the output type for any other schema — still no zod import.
- **"Declared nothing" is `Record<never, never>`.** `Record<string, never>` has `keyof` `string`, which
  made a param-less view accept every `:param` route — caught by an `@ts-expect-error` that stopped
  failing.

## 13. Phase 2 findings (2026-09-28)

Phase 2 added `src/app/runtime.ts`, the `mount` description node, `HandlerTable.remove`, and tests
(`test/app-runtime.test.ts`, `test/browser/app-runtime.browser.test.ts`).

- **The renderer knows nothing about the app model.** A `mount` node carries an `instantiate()`
  closure the runtime made; `buildMount` calls it inside a fresh scope and disposes it when the node
  leaves. Two nested scopes make children dispose before their parent's `dispose()`.
- **The runtime constructs through a static `create(init)` method, not `new`.** Construct signatures
  compare parameters strictly, so no unit class is assignable to an erased `new (init) => ...`;
  methods compare bivariantly — the same reason `ViewDecl.render` is a method. That keeps the runtime
  free of casts.
- **A unit's `cx` is a projection of the App's grant** — exactly the declared capabilities plus its
  own `onDispose` — and a unit asking for more than its host has is refused at run time as well as
  compile time. The App's `needs` is the page's grant for now (§11 still open).
- **`dispose()` is a plain method an author writes**, not declared on the bases: with
  `noImplicitOverride`, declaring it there would force `override` on a hook nobody inherited.
- **Bridge, temporary:** `ViewContext.off` exists so a runtime hosted inside a legacy view can remove
  its handlers. It goes with `ViewContext` in phase 5.
- **`flatten` instantiates, reads and disposes** a mounted unit — a snapshot has to construct what it
  snapshots.
- **Verified by pressing:** the browser test types and clicks through two `LoginForm`s sharing one
  `AuthService`, and flips a third in and out of a `when` five times. Breaking handler removal on
  purpose fails it (7 live handlers where 5 should be).

## 14. Phase 3 findings (2026-09-28)

Phase 3 added `src/app/registry.ts`, the `COMMAND` brand, and tests (`test/app-commands.test.ts`,
`test/browser/app-commands.browser.test.ts`).

- **A command is live exactly as long as its owner.** The runtime collects every own field holding a
  command when it constructs a unit, and retires them *first* on teardown, so no key can reach a unit
  that is going. Services' and the app's are live for the page. `runtime.commands.live` is a signal a
  palette can read.
- **Two live commands on one key: the newest wins,** and the older one answers again the moment the
  newer owner goes. Right for a single page; in windowed mode "in front" should mean the focused
  window, which is phase 4's to decide.
- **Keys are checked early.** `command()` normalises its key and throws on one that cannot parse —
  there is no `mod` modifier, which this document's own first examples got wrong. A chord someone
  else already answers is refused when the owner mounts, naming who: the browser's
  (`BROWSER_TAB_RESERVED`) or **the kernel's own window bindings**. The browser test found the second:
  a component on `alt+n` ran its command *and* minimised the window, and every click after went to an
  invisible element. Those bindings now live in `input/keys.ts` as `KERNEL_WINDOW_BINDINGS`, used by
  both the kernel and the registry.
- **A keyed command with input runs with `{}`;** its schema's defaults decide whether that is enough.
  Any failure goes to `onError` — never an unhandled rejection.
- **Plain keystrokes in a text field are never taken;** a modifier chord still works there (the
  kernel's rule, now shared).
- Mutation-checked: stop retiring commands on dispose and the browser test fails on the registry
  (a disposed owner's command still live) and two unit tests fail with it.

## 15. Phase 4 findings (2026-09-28)

Phase 4 added `src/app/routes.ts`, `router.ts`, `link.ts`, `site.ts`, the `Link` primitive, the
`navigate` intent's wiring, and tests (`test/app-routes.test.ts`, `test/browser/app-site.browser.test.ts`).

- **`mountSite(App, { root })` is the single-page path, and it needs no kernel:** renderer, one
  handler table, the browser's history, one view per URL. The outlet is an `each` over zero or one
  match keyed by route + params, so the existing reconciler does the swapping.
- **Matching includes the view's schema.** A URL whose params do not parse falls through to the next
  route, then to not-found — never an exception from inside rendering. Static segments beat params
  whatever the declaration order; two patterns matching the same URLs are refused.
- **A change of params is a new view instance** (params are constructor input); anything else leaves
  the instance alone. The old instance's commands and handlers go with it.
- **`Router` is an ordinary injected service** with a typed `href(View, params)`: a link that names a
  param the view does not take, or misses one it needs, does not compile.
- **`Link` is a real `<a href>`.** The `navigate` intent — declared in `IntentName` since the start
  and never wired — now claims only a plain primary click; ctrl/cmd/shift/alt/middle click is left
  to the browser, so new tabs, copying the address and crawlers all work.
- **A view's `title` is the document's.**
- **Windowed mode moved to phase 5.** Windows come from the kernel's window manager, so "the same
  routes as windows" and "the focused window's key wins" belong with booting an App through the
  kernel — which is also where the App's capabilities stop being passed in by hand (`granted`).
- Mutation-checked: claim modified clicks, or key matches by route alone, and the browser test
  fails (the second also fails a unit test).

## 16. Phase 5a findings (2026-09-28)

Phase 5 was re-ordered: deleting `Application`/`Extension` first would take the windowed desktop
down before anything replaced it, and the one consumer that must keep working is a website. So:
**5a** boots an App through the kernel as a site; **phase 6** rebuilds the company site on it;
**5b** (windowed mode for Apps) and **5c** (the deletions) follow.

- **`start()` boots an App.** mesh-serve's boot script is unchanged — it still passes default-exported
  classes. A part whose export has `kind: 'app'` is booted by `startApp`: the App's `needs` go through
  the kernel's own `createContext`, so `cx.mesh` is the page's client for the App's declared API
  (credentials included), `cx.notifications` reaches the kernel's notification surface, `cx.storage`
  is the page's hives. That context is the grant the runtime projects. The log viewer mounts too.
- **One setup for both boot paths.** Storage hives, drivers, services and the API client moved from
  `start()` into `createPageKernel`, so a legacy part and an App get capabilities built one way.
- **`start()` is overloaded,** not widened: a composition of legacy parts still returns `Started`
  (every existing typed caller); one that may hold an App returns `Started | StartedApp`, which is
  what it may really return. `kind` tells them apart.
- `UnitSpec.api` is now `Api<...>` rather than `unknown`, so it flows to `createContext` without a
  cast and `cx.mesh` stays typed by the specific API.

## 17. Phase 6 findings (2026-09-29)

`surfdns-company-site` (branch `components`) is rebuilt on the model: `App` with three routes and
one service, `AuthService`, one `LoginForm` mounted in two places, three pages and a `Nav`.
`src/index.ts` is 25 lines and has no `start()`.

- **The app model is exported from the package root, and only there.** A part's build keeps one
  specifier external (`@flybyme/mesh-web`) and bundles everything else, so a subpath export would
  have put a second copy of the runtime — a second `Router` class — inside the part. The legacy names
  it collided with were renamed: `command` → `commandAction`, `Router` → `RouterCapability`,
  `Component` → `CallableComponent`.
- **Setup that must run at construction goes in a constructor,** written without naming the init
  type: `const Base = Service({...}); class AuthService extends Base { constructor(...args:
  ConstructorParameters<typeof Base>) { super(...args); ... } }`. `AuthService` attaches its ticket
  to `cx.credentials` that way.
- **Sign-in is typed end to end:** `command({ input: identityTicketIssueInputSchema, ... })` takes the
  generated client's own schema, and `cx.mesh.call('identity.ticket.issue', ...)` is checked
  against the generated API. The site's browser test proves the ticket is on the call made after it
  is issued and not before, and fails if the header is not attached.
- **The whole path boots from a served page.** `npm run dev` (was `mesh-serve dev`, a command
  mesh-serve does not have) serves a page that calls the kernel's `start()` exactly as mesh-serve's
  boot script does. Loaded headless as a visitor: home, a deep link, a clicked link, a 404, no
  console errors but the expected 404s of an unconfigured API.
- **A stale title, found by that load and not by a test:** `mountSite` only set the title when a
  view declared one, so a 404 or an untitled view kept the previous page's. It now falls back to the
  page's own title (and restores it on dispose). The first regression test for it passed with the
  bug still in — another test had left the title set — and was only made to fail by giving it a
  title nothing else could produce.

## 18. Phase 5b findings (2026-09-29)

Phase 5b added `src/app/desktop.ts` and `test/browser/app-desktop.browser.test.ts`.

- **`mountDesktop(App, …)`: the same App, its routes as windows.** Navigating opens a window, or
  focuses the one already showing that route with those params; back/forward do the same;
  `Router.current` is the focused window's route. Two windows on one route are two instances.
- **Built on the existing window layer**, not beside it: the real `WindowManager` and `mountPage`
  shell, which mount a window through `viewOf(owner, view)` → `ViewDecl`. Each route is handed to it
  as a `ViewDecl` whose `render` mounts the route's view through the runtime, in that window's handler
  table. A second temporary bridge on `ViewContext`, `windowId`, lets it say which window.
- **A key reaches the window in front and no other.** A root mount carries a scope (its window) that
  every component beneath it inherits; the registry, told which window is focused (`inFront`), skips
  commands scoped to any other. Services' and the app's commands have no scope and always answer.
  Mutation-checked: drop the filter and the browser test fails with the keys in the wrong window.
- **`start()` picks by policy.** An App is a single-page site unless the site's `window-manager/mode`
  policy is `windowed` or `tiled` — the reverse of the legacy kernel's default, on purpose.
- Not done: the URL does not follow focus (clicking a different window leaves the address bar on the
  last navigation); `HistoryLike` has no `replace`. Window geometry is not persisted for Apps yet.

## 19. Phase 5c — A1: only an App boots (2026-09-29)

5c is done as **A then B**: A deletes the authoring surface of the legacy model and keeps the engine
the App path still runs on (the broker's `createContext`, the page services); B then replaces that
engine with platform services. A is in steps, each green.

**A1** made `start()` boot only Apps:

- `start()` is ~200 lines, down from ~1,000. It keeps mesh-serve's contract whole — it still takes
  `{ application, api, policy, parts, open, … }`, `open` accepted and ignored — boots the first part
  whose export is an App, and **says** what it will not boot: no App is an error naming the legacy
  parts; legacy parts beside an App are a warning in the log. `mountPart`, the legacy test harness,
  is gone; an App is tested with `mountSite`/`mountDesktop` or through `start()` itself.
- Tests of machinery that no longer exists were deleted (legacy window modes, `mountPart`,
  Extension-contributed components, the internal/published split, `KeyDecl` bindings — the last
  already covered by the app-model key tests with real keystrokes). Tests of features that still
  exist were **ported, not dropped**: dialogs, live collections, storage, the log viewer, kernel
  logging, the display capability, `start()` itself. Several read better on the model: the dialog
  test's page went from a provider token, four declared commands and four `implement` calls to one
  view with two signals.
- **Three regressions the ported tests caught** — each something the legacy boot did and the first
  App boot did not:
  - ctrl+alt+q no longer opened the log panel (the toggle lived in the legacy key listener). The
    panel now owns its toggle, as it already owned Escape.
  - `cx.display` was never measured, so a service asking how much room there is got 0×0. `startApp`
    now measures before anything is constructed, on resize, and on the root's own box changing.
  - `dispose()` left behind the root `start()` had created. It now removes a root it made (and
    leaves one it was given).
- **A failed App is not a blank page:** the page says it could not start and why, the log panel is
  mounted, and the error still propagates.

## 20. Phase 5c — A2: the part machinery is gone (2026-09-29)

- **Deleted:** `Kernel` (boot, processes, providers, start/stop/restart), the manifest and its merge,
  the dependency graph, the legacy router (`routerSink`, `match.ts`'s `/<app>/<view>` scheme) and
  the window sink. `router/router.ts` keeps only `HistoryLike` and `browserHistory`.
- **Tests:** those of the deleted machinery went (kernel lifecycle, manifest, publishes, the legacy
  router and URL parser, the part end-to-end, the chrome capability over the window sink, the
  manifest's key checks). Every capability test that booted a `Kernel` only to reach a context was
  ported to the context an App is really given — the broker's `createContext`, the call `startApp`
  makes — read through an app-model service so it arrives **typed, with no cast**: confirm, storage
  (reload survival), models (including the session end-to-end, now through an ordinary session
  service), net, kernel-log (call failures never log a ticket, header, password or body), drivers.
  Where a test used a `Kernel` as a typed token store, it is an `IoManager`, which is what that was.
  Three casts came out on the way (`as unknown as Context`, two `as any` renderer lookups — one of
  which answered *every* token with the renderer).
- **The window-layer tests run on the App desktop** (`mountDesktop`), the real shell and default
  frame — sizes, drag with pointer capture, the resize grip and minimum, frames that cannot break
  positioning, close/maximize under a real pointer, one window per route. That needed two things the
  desktop lacked: **`View({ window: { defaultSize, minSize, closable, tile } })`** — the part-era
  window hints, applied the way the window sink applied them — and a `frame` option.

## 21. Phase 5c — A3/A4: the authoring surface is gone (2026-09-29)

**What app code can import is now the app model and nothing that competes with it.**

- **Deleted:** `contribution/contract.ts` and `contribution/api.ts` whole — `Application`,
  `Extension`, `ViewDecl`/`ViewContext`, `Declarations` (`commands`, `keys`, `menus`, `settings`,
  `stores`, `components`, `publishes`), `ApplicationInstance`/`KEEPS_NOTHING`, `construct`,
  composites (`defineComposite`, `CompositeContract`), `defineComponent`/`CallableComponent`,
  `CommandContract`/`BoundCommand`, `ApiDecl`/`checkBindings`, `Availability`. From `provider.ts`:
  `consumes`, `Consumer`, `Provided`. From `session.ts`: `AUTH`, `AuthApi`, `Credentialed` (a service
  is found by its class).
- **The window layer has its own small contract** (`window/view.ts`): `WindowView` — id, title,
  window hints, `render` — and `WindowViewContext` — the window's params, its handler table
  (`on`/`off`), `windowId`. It is what the shell mounts, not something app code writes; the desktop
  is its one user. The part-era context's `internal`/`app` are gone, and with them the three
  `as never` casts `mountView` needed to fill them. The shell lost `apiOf`, `internalOf` and
  `isReady`, which existed for processes.
- `ErasedContext` moved into the broker, its only user.
- **Tests:** `mountView` callers name a `view`, not a `decl` — which removed the `as never` their
  declarations needed. Type assertions that had silently become checks against `any` when `Context`
  went (five `@ts-expect-error`s reported unused) now target `Capabilities<Needs, Api>` — a unit's
  `this.cx` type — and hold again. Five `as Context<…>` casts in the capability tests became checks.
- **Left for B**, deliberately: the capabilities that only the part model needed (`commands`,
  `windows`, `chrome`, the legacy `router` capability) still exist in the broker; `commandAction` and
  the `command` kind of `Action` still exist in the description layer; and four pre-existing
  `as any` casts in `models/models.ts`. B replaces the broker with platform services, and those go
  with it.

## 22. The kernel's CSS is structure; the look is a theme (v0.20.1, 2026-09-29)

`kernel.css` had three jobs in one file: what the window system needs to work, a dark palette used as
the fallback of every colour (and a page background), and defaults for every `button`, `input`,
`h1`–`h6`, `ul` … on the page. So every site was dark whether it asked to be or not, and lost its list
bullets. Split:

- **`kernel.css` — structure only.** The desktop's page and window host (only in windowed/tiled
  modes), the window frame's layout, drag and resize handles, mode rules, `[hidden]`, the kernel's
  own primitives (`Grid`, `ScrollView`, `Surface`, drag and drop, `Dialog`) and the layout of its own
  widgets (notifications, log panel, confirm, window frames). No page background, no font, nothing on
  a site's own elements. The widgets still read the tokens (`--page`, `--ink`, `--accent` …), but
  unset they fall back to **CSS system colours** (`Canvas`, `CanvasText`, `ButtonFace`, `Highlight`),
  which follow the page's `color-scheme` — a light site gets light notifications.
- **`themes/dark.css` — the old look, opt-in** (`@flybyme/mesh-web/themes/dark.css`): the tokens on
  `:root`, the page background and font, and the element defaults in `@layer mesh-theme` so a site's
  own unlayered CSS wins without a fight. It adds the one rule the old reset lacked, `a`.
- **A live bug fixed on the way:** the desktop rules were written `:not([data-mesh-window-mode="single"])`,
  and a single-page site sets no mode at all — so every website's root was pinned to the viewport
  with `overflow: hidden`, and nothing below the fold could be scrolled to. The desktop modes are
  now named positively. `test/browser/kernel-css.browser.test.ts` asserts a single-page site
  scrolls (and fails against the old selector), that an unthemed page is not painted, that the
  desktop is still pinned, and that the dark theme gives the old look back.

## 23. Future: server-side rendering (wanted, not now — 2026-09-29)

The owner wants SSR; it is deliberately deferred behind the reference app. The plan, so it is not
re-derived:

- **How a request renders:** match the URL with the same route table; a *fresh runtime per request*
  (never shared — one visitor's state must not reach another's page); construct the services and
  the view; `flatten()` — which already instantiates mount nodes, reads them and disposes them, so
  components need nothing special; serialize to HTML; send it with the boot script. The client
  boots and takes over. `Link` is a real `<a href>`, so a server page navigates before any script.
- **Missing:** a string renderer — primitives are defined by `create()` calling
  `document.createElement`, so each needs its tag and attribute rules declared as data; server-side
  capabilities (`mesh` over the server's `fetch` with no visitor credentials; inert storage,
  notifications, display); waiting for a page's data before flattening (the runtime tracks the
  collections a render created and waits for them to settle, with a timeout); a gateway hook.
- **Hard parts:** data (a one-shot snapshot shows loading states); running a site's code in the
  platform's node per request (a sandbox and time-limit question before anyone else's code gets
  it); handing over without a flash (re-render and replace first; hydration later, if it matters).
- **Order:** (1) prerender param-less public routes at release time — no per-request code, most of
  the benefit for a public site; (2) per-request rendering with data waiting, isolated;
  (3) hydration.

## 24. Reference-app gaps, closed one at a time (2026-09-29)

The owner's question before writing a large UI: *what does an advanced site look like in this
model, and is it the right shape?* The answer is a reference app (`examples/console`) built on the
model. Building it lists what the model lacks, and each gap is closed in the framework, not in the
example, before the example relies on it:

1. **Query-string state rebuilt the view.** Path params and the query were merged into `params`, and
   the route key covered both, so `?page=2` disposed the list and built a new one, losing scroll,
   selection and open dialogs. **Fixed:** a view declares `params` (the path, fixed for the
   instance's life) and `query` (reactive: `this.query()`). The route key is the pattern plus
   the path params only, so a query change keeps the instance and updates `query()`. On the
   desktop, the window showing that path follows it. Both schemas are part of matching, so a
   query the view refuses is a 404. The types refuse a `params` field the path does not have
   ("belongs in `query`"). `router.href(View, { zone, page })` takes both, with query fields
   optional. `SearchOf<S>` is the type (not `QueryOf`, which models already exports).
   A query cannot spoof a path param any more: they are no longer merged.
2. **One throwing component blanked the page.** A constructor or `render()` that threw propagated
   out of the renderer. **Fixed:** every mount is an error boundary. The unit's registrations are
   removed, the error goes to the console (so to the log viewer), and the unit is replaced by the
   App's `fallback({ unit, error })` or, by default, a labelled `role="alert"` box. Its siblings,
   its parent and the rest of the page carry on. A **boot** service that is refused still stops the
   App, because nothing could run without it. A service injected lazily by one view only costs that
   view. Errors thrown later, in a handler, a command or an effect, are not caught here; that is a
   separate gap.
3. Still open: layouts (a persistent shell across pages), guards/redirects, forms from schemas, a
   design system of real components, lazy routes.
