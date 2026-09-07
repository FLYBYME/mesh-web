# Components, styling, and what a part publishes

Written 2026-09-06, from measuring the twelve demo parts and the four in `mesh-core`.

Three problems that turn out to be one problem: there is no vocabulary above the primitives, styling
lives in TypeScript, and a part's public interface is whatever its views happened to need.

---

## 1. What exists

**Descriptions are data.** A node names a *component*, never a tag —
[`description/types.ts`](../src/description/types.ts): *"`component` names something in the
vocabulary — `Stack`, `Text`, `Button` — and the renderer decides what element that becomes, if any.
If nobody writes `div`, nobody writes `HTMLElement` either."*

**The vocabulary is 19 primitives:**

```
Stack  Row  Grid  Card  Divider  ScrollView
Text  Span  Heading  Badge
Button  Input  TextArea  Form
List  ListItem
Dialog  Draggable  DropZone
```

**And nothing above them.** Measured across the ten demo applications:

| | |
| --- | --- |
| `element()` calls | **578** |
| inline `style: {}` objects | **446** — 77% of call sites |
| shared UI modules | **0** |
| `.css` files in either repo | **0**, though C8 makes a part stylesheet possible |
| `var(--token)` uses | 93 |
| hard-coded hex colours | **318** |

`Button` appears 124 times and there is no shared button. `padding: '16px'` is written 26 times,
`'2px 6px'` 16 times, `'8px 12px'` 13 times. Colour literals outnumber theme tokens **3.4 to 1**, so
most applications do not respond to the theme extension that exists to drive them.

> How many times are we going to write a form?

Eleven `Form` elements and eighteen `Input`s, each with its own label, spacing and error text.

---

## 2. Yes, an Extension can provide components — the machinery is built and unwired

`createRegistry()` in [`render/component.ts`](../src/render/component.ts) already has this:

```ts
register(definition) {
    const existing = map.get(definition.name);
    if (existing !== undefined) {
        throw new Error(
            `Component "${definition.name}" is already registered. ` +
            `Two contributors claiming one name is a conflict to resolve at load time, ` +
            `not a last-one-wins.`,
        );
    }
    map.set(definition.name, definition);
}
```

**That error anticipates multiple contributors.** There is exactly one caller in the codebase —
`window/page.ts`, registering the window host — and the contribution layer contains **zero**
references to `components`. So the extension point was designed and the last step was never wired.
A mechanism whose error message describes a situation that cannot arise belongs in the reader audit.

### The design

**Names are namespaced: `ui.Card`, `ui.Nav`, `ui.Slider`.** *(decided 2026-09-06)* The registry is
one `Map<string, ComponentDefinition>` per page and `component` is a plain string that nothing
parses, so this works today with no change. It is needed because component names are a **global
namespace per page**, exactly like part names — two design systems both offering `Card` is otherwise
a page that refuses to boot.

**Declared in the manifest, not registered at activate time.** The kernel already resolves this class
of conflict before anything runs — A5.12, *"two Applications claiming `ctrl+n` is resolved before
either runs"*, with `manifest.conflicts` surfaced at load. Components must ride that same machinery.
Imperative registration during activation would make load order decide the winner, silently.

**The dependency is `requiredParts`, which already exists.** A part using `ui.Card` declares
`requiredParts: [{ id: 'ui', version: '^1.0' }]` in `mesh.json`, and `checkComposition` already
refuses a release missing a required part. So *"this application needs the design system"* is
expressible today with no new mechanism.

---

## 3. Styling leaves TypeScript, and the `ui` part owns the class names

**The design system takes charge of classes and ids.** *(decided 2026-09-06)* A component's rules
live in the `ui` part's stylesheet, shipped with its artifact via C8. Parts stop writing
`padding: '16px'`; they write `ui.Card` and get the padding.

Values come from the thirteen theme tokens that already exist:

```
--page  --chrome  --surface  --surface-hover  --ink  --ink-dim
--edge  --accent  --on-accent  --info  --warn  --error  --shadow
```

**This is what makes theming work by construction.** Today each application is trusted to reach for
a token and 318 hex literals say they mostly do not. Styled once inside `ui`, every component is
themed for everyone — the same discipline-into-mechanism move the rest of this project runs on.

### Order, and why it currently cannot be right

`page.ts` emits part stylesheets **in composition order, alphabetical by part id**. So `ui` loads
after `calc`, and the design system's rules would override the application's — backwards. A base
layer must load first, and alphabetical accident is not a rule.

**Use `@layer`.** The `ui` stylesheet declares its layers up front
(`@layer ui.base, ui.components, app;`) so precedence is explicit in the CSS rather than implied by
filename order. This is the one change needed outside the `ui` part itself, and it makes link order
irrelevant, which is the property worth having.

---

## 4. Two worked examples, and the rule they share

### A slider

`Input` maps to `<input>` and passes `type` through as an ordinary prop, so **`<input type="range">`
renders today.** What that buys, for free: arrow keys, Home/End, Page Up/Down — the non-pointer path
[input §3](./input.md) *requires* of every action.

So `ui.Slider` is a thin component over the native element plus a styled track and thumb. It is
**not** a hand-rolled `Draggable`, which would look identical, take a week, and be unusable from a
keyboard.

> **The rule: reach for the native element whose accessibility you would otherwise have to rewrite.**

The kernel already follows it — `Dialog` uses `<dialog>` for top layer and no z-index arithmetic,
`Heading` picks a real `h1`–`h6`, `Input` handles the dirty-value flag. A design system that reaches
for `div` inherits the maintenance of every behaviour a browser already ships.

### A nav bar

`chrome` builds one today from `Row` + `Button`. What `ui.Nav` adds is not appearance:

- `<nav>` semantics and a current item
- **arrow-key movement within the bar**, which is [input §3](./input.md)'s *focus groups*: *"a list,
  a toolbar, a sidebar is a focus group. Navigation moves within the group; leaving it moves at group
  level… Without groups, moving right from a sidebar lands in an arbitrary row of a table. This is
  the mechanism that makes it feel designed rather than computed."*

**Nav is the first component that actually needs the focus graph**, which is specified and unbuilt.
That makes it the right second component to build, after the trivial ones prove the pipeline.

---

## 5. The public interface is not the view's access path

The problem, raised by the project owner from measuring the initial demo applications:

> I don't like how many signals an app or extension makes and keeps track of, and why they are all
> being returned. **I believe that return object is the app's or extension's public interface.**

Previously, `start()` returned `ApiOf<TProvides>`, which was both what another part received from
`use(TOKEN)` and the *only* object `ViewContext` gave a view (`vx.app`). Measured across the demo parts:

| part | `signal()` | members returned |
| --- | --- | --- |
| `workbench` | 8 | **32** |
| `kanban` | 9 | 28 |
| `notes` | 7 | 24 |
| `clock` | 12 | 23 |
| `calc` | 7 | 20 |

`WorkbenchApi` published **eight raw `Signal<T>`** — mutable handles, so anything holding the API could
`.set()` them — plus ten methods that merely forwarded to `cx.chrome` (`focusWindow`, `closeWindow`,
`maximizeWindow`…), which consumers already have. It also published `filterRevision` and
`docRevision`: revision counters that existed to work around the A7.0 `Input` bug that kernel 0.11
fixed. Because `vx.app` was the view's only route to state, every internal signal had to become
permanent public API.

### The solution: two objects, not one

The kernel (v0.14.0) separates what an Application publishes from what its views read:

```ts
export interface ViewContext<
    TParams = Record<string, never>,
    TApi = unknown,
    TInternal = never,
> {
    readonly params: TParams;
    readonly app: TApi;           // public API (for views that want public surface)
    readonly internal: TInternal; // internal context (never published, holds part's own state)
    setTitle(title: string): void;
    close(): void;
    onDispose(fn: () => void): void;
}
```

- **an internal context (`vx.internal`)** — the signals, drafts and mutation methods, handed to this
  part's own views, scoped to the running process instance (`pid`), and never published to the provider
  graph.
- **the published API (`vx.app` / `use(TOKEN)`)** — what another part receives from `use(TOKEN)`.
  Deliberately small, and exposing `ReadonlySignal<T>` where it exposes state.

### How an Application declares both

`Application` accepts a 5th type parameter `TInternal`, defaulting to `never`:

```ts
export interface Application<
    TNeeds extends readonly CapabilityName[],
    TConsumes extends ProviderTokens = readonly [],
    TProvides extends ProviderToken<unknown> | undefined = undefined,
    TApi = Api<Record<string, never>>,
    TInternal = never,
> extends Declarations {
    start(cx: Context<TNeeds, TConsumes, TApi>): Promise<ApplicationStartResult<ApiOf<TProvides>, TInternal>>;
}
```

`start()` returns:
- `{ api, internal }` when providing both a published API and internal context
- `{ internal }` when the Application has views but provides no public API to other parts (`provides: undefined`)
- `api` directly when the Application does not opt in, maintaining complete backwards compatibility for existing parts.

At boot and process start, the kernel registers `entry.api` into `#providers` for `use(TOKEN)`, but
holds `entry.internal` private to the process. When `mountView` mounts a view, `vx.internal` receives
that private state.

### The rules for published interfaces

1. **A part's API exposes `ReadonlySignal<T>`, never `Signal<T>`.** The type exists in
   `reactivity/types.ts` and `models` uses it throughout. Publishing a writable handle is handing out a
   public field with a setter nobody asked for.
2. **A part never re-exports a capability.** If a consumer wants `focusWindow`, it declares
   `needs('windows')`. Ten forwarding methods on `WorkbenchApi` are ten redundant ways to reach one thing.
3. **`ViewContext.app` keeps working.** A view legitimately sometimes wants the part's own public
   facade. It is no longer the *only* route.
4. **A workaround never becomes API.** Internal revision counters or shim signals stay inside
   `TInternal` if needed at all, and are deleted when the bug they worked around is fixed.

> **The published interface is a decision, not a leftover.**

---

## 6. The worked example: one shopping cart

The project owner's framing, and it is what the architecture is for:

> I want to build one shopping cart. A really good one, but only one.

A cart is a **part**: one content-addressed artifact, independently versioned, composed into every
customer's site *by reference*. Wix gives every site its own copy, so improving the cart means
migrating N sites. Here, `cart@1.4.0` is published once and every site resolving `^1.4` has it.

**Build one, improve it forever, run it everywhere.**

And it is the argument for everything above. A cart that must look right on every customer's site
cannot contain a single hex literal — built from themed `ui.*` components it adapts to a palette it
has never seen; built the way the demo applications are built, it looks wrong on the first site whose
theme differs. Its public API should be four or five members — *what is in it, add, remove, total* —
not thirty-two, because other parts will consume it and that surface is a promise.

---

## Open

- **Which components, and in what order.** The measurements suggest: `Field` (label + input + error,
  written eleven times), `Nav`, `Panel`, `Toolbar`, `Table`, `Menu`. Ordered by how often the demos
  rebuild them, not by what a design system usually has.
- **Does `ui` own layout?** Proposed **no**: `Stack`, `Row` and `Grid` are kernel primitives, so
  primitives own structure and `ui` owns appearance and composite widgets. A second layout system
  over `Grid` is two ways to do one thing.
- **Does the kernel keep its 19 primitives, or do some move into `ui`?** `Card` and `Badge` are
  appearance, not structure, and may be in the wrong layer.
