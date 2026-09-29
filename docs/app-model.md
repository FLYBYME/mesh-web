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
