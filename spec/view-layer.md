# The view layer

> "what is shown and the logic for what is shown are two different things"

**Status.** New. **Decided** where it records a decision you made; **Proposed** for the rest.

Companions: [the model](./README.md) · [the kernel](./kernel.md) · [Applications](./application.md)
· [Extensions](./extension.md) · [storage and the registry](./storage-and-registry.md).

---

## 1. The rule — **Decided**

> **A view is a pure function from application state to a description. It holds no logic and
> produces no DOM.**

Everything in this document is a consequence of that sentence.

The separation is not enforceable by convention. A view that can reach `document` can hold logic,
and eventually one will — under deadline, in the one place it seemed harmless. The description layer
is the enforcement: a view that cannot construct a DOM node cannot smuggle behaviour into one.

So no Application and no view ever sees `HTMLElement`, `Node`, `Event`, or any other DOM type. Not
discouraged — **absent from the types they are given.**

---

## 2. What a view returns — **Decided**

A description: plain data describing components and their props.

```
Application  →  description (data)  →  renderer  →  DOM
                       ↑ the Application stops here
```

The renderer is the kernel's ([kernel §2](./kernel.md) — window geometry is kernel, decoration is an
Extension; the same line puts the renderer in the kernel and the component *library* outside it).

**What this buys, in order of how much it matters:**

1. **The boundary you asked for.** An app cannot touch the DOM because it is never handed one.
2. **Server-side rendering.** A blog needs real first paint and real crawlability. A description
   renders to HTML on a server; DOM nodes do not.
3. **Tests without a DOM.** Assert on a tree.
4. **The window manager can reparent and re-tile a view without touching it**, which is what makes
   "[mode switching with no remount](./README.md) §5" true rather than aspirational.
5. **Theming.** If nobody writes `<button>`, one component controls every button on the site.
6. **Isolation becomes reachable.** §9.

---

## 3. Components, not tags — **Decided**

> "everybody uses the same form component just with different styles"

An Application's vocabulary is components: `Stack`, `Row`, `Text`, `Heading`, `Button`, `Input`,
`Form`, `Table`, `Card`, `Badge`, `Spinner`, `EmptyState`, `ErrorState`. Never `div`, `span`,
`button`.

This is the other half of the boundary and it is load-bearing. Fix only the return type and an app
writing `h('div')` is still writing DOM with extra steps. **`h()` is not exported to Applications
at all** — it is the renderer's internal business.

It is also what makes [views not nesting](./README.md) §2 workable. Below a view are components; a
component is a description-producing function like a view, without an identity, a window, or a place
in the layout.

**Where components come from — Proposed.** The framework ships the primitives above. Everything
richer is contributed by an **Extension**, which is how a design system ships: one Extension provides
a token, consumers get its components typed, and swapping the Extension restyles a whole site without
touching an Application. That keeps the framework small and puts the vocabulary where the site team
owns it, consistent with [hosting §5](./hosting.md).

### Two kinds of contributed component — **Decided 2026-09-04**

Roadmap A7.4 asked whether a contributed component is *"a fourth contract, or a plain function
returning a description"* and left it undecided. It is **both**, because two different things were
being called one word, and separating them makes most of the question disappear.

| | **composition** | **a new primitive** |
| --- | --- | --- |
| what it is | `Card`, `Toolbar`, a form layout | a virtualised list (A7.6), a `Surface` for Monaco or canvas (A7.5) |
| what it does | returns a description built from primitives | tells the renderer how to *create and update* an element |
| how it is written | a plain function | a `ComponentDefinition`, registered |
| declared in the manifest? | **no** — there is nothing for the kernel to know | **yes** — the kernel must know it before render |
| how a consumer reaches it | `cx.use(DESIGN_SYSTEM).Card({ … })` | `element('VirtualList', { … })` |
| typed? | **already, for free** — it is a function call | **no**, and this is the open part |

**Composition needs nothing from the framework.** No registration, no declaration, no conflict rule,
and it is checked today because a function call is checked. An Extension hands its components out
through the token it already provides. This is almost certainly the majority of what anyone would
call a component library, and the right answer for it is *the framework stays out of the way.*

**A new primitive is a real contribution** and follows every rule the others do. The kernel has to
know it before anything renders — the same reason commands, keys, views and layout are declared —
and two contributors claiming one name is a load-time conflict, which
[`ComponentRegistry.register`](../src/render/component.ts) already refuses rather than resolving
last-one-wins. There is a working precedent in the framework itself: `mountPage` registers
`windowHostComponent` into the site's registry at boot ([extension §8](./extension.md)).

**What stays open is narrower than A7.4 implied.** Only the second kind needs typing, because only
the second kind is reached by a *string*. `element('VirtualList')` compiles today whether or not
anything provides it, and you find out at render. That is the same problem as A3.1d — typed accessors
for everything string-keyed — and it should be solved once for views, commands, settings and
components together rather than four times.

The split also has a pleasant consequence: the contributed-*primitive* path stays small, and small is
what makes a load-time refusal on a duplicate name tolerable rather than obstructive.

---

## 4. Reactivity — **Proposed**

Fine-grained, as the deleted runtime was. No virtual DOM, no diffing. A signal is bound to the node
it affects; an update writes one text node.

**One render path.** A view always produces a description, even in-process. The alternative — build
DOM directly when local, describe when remote — means two renderers that must agree, and they will
not. Construction cost is once per view mount, not per update, so the tax is a single tree
allocation and the update path is unchanged.

### Reactivity does not conflict with a data description — **Proposed**

An earlier draft of this design claimed these pulled against each other. They mostly do not, and the
reason is direction of travel.

When an Application runs across a boundary, its reactive graph runs **on its own side**. Signals,
computeds, effects and control-flow expansion never cross. What crosses is the *output*: a
description, then patches when signals fire.

So a closure in the tree is not a serialization problem. `text: () => count()` is never transmitted —
the app side evaluates it, sends `5`, and sends `7` when it changes. That is fine-grained reactivity
with the boundary drawn after the effect instead of before it. The runtime already knows which effect
touches which node; whether it then writes a text node or posts a patch is an implementation detail.

**What must be data is the node description itself.** That is §2 and §3, and it is the whole
constraint.

---

## 5. Events — **Decided in shape**

Events travel the other way — renderer to Application — so they need identity that survives a
boundary. A closure has none.

**[input.md](./input.md) is the full model** — intents rather than device events, a first-class focus
graph so everything works without a pointer, modality as framework state, and bindings across
keyboard, gamepad, touch and pen. What follows here is only the identity mechanism the description
needs.

### Two kinds, and a rule for which

**Commands** are the Application's verbs. Declared in the manifest, implemented in `start()`.

**Handlers** are incidental interaction — a disclosure toggle, a hover, a field's input event.
Written as an ordinary function; the framework assigns it an id and keeps the function in a per-view
table, so the description carries the id and not the function.

> **The test: would anyone ever want to bind a key to it?** Yes → command. No → handler.

That line lands almost exactly where [§4 of the model](./README.md) already draws one: commands tend
to mutate **application state**, incidental handlers tend to twiddle **view state**. When two
independent arguments put a seam in the same place, the seam is usually real.

Commands are not merely a serialization trick. A button pointing at a command is automatically in
the palette, bindable to a key, reachable from a menu, and **scriptable** — and for an IDE, an app
whose verbs are not addressable cannot be automated, extended, or driven by tests through its own
surface. Routing *every* interaction through one, though, is too heavy: a disclosure triangle does
not deserve a palette entry.

### `preventDefault` is data, not a decision — **Decided**

The problem that sinks naive isolation designs: **`preventDefault` cannot be asynchronous.** Form
submit, paste, drag and most key handling need a synchronous answer, and across a boundary the
default has already happened by the time a handler runs.

So the decision is declared statically on the node and the reaction stays async. The renderer knows
before it dispatches. What is given up is deciding dynamically whether to suppress an event, which
is a real but narrow loss.

### Handler disposal

The per-view handler table is freed when the node goes away, and the whole table when the view
instance closes. This is the existing scoping model ([kernel §4](./kernel.md)) rather than new
machinery — but it is bookkeeping, and bookkeeping is wrong the first time. Worth a test that opens
and closes a view a thousand times and asserts the table is empty.

---

## 6. Tiles are slots; views fill them — **Decided**

> "the 'content' is almost a sub thing … what i did like was the 'ViewProvider' in mesh-ui"

Right, and the demo had this wrong. It declared a *view* called `content` and also a *tile* called
`content`, which conflated two different things.

**A tile is a named region in a layout. A view is a thing that can occupy one.**

An Application declares a layout — a split tree whose nodes have names — and each view declares which
node it targets. Several views may target the same node over the app's life; the window manager
decides which one occupies it now.

For the blog that means:

| | |
| --- | --- |
| **tiles** | `header`, `sidebar`, `content`, `footer` — the layout |
| **views** | `masthead` → header · `postList` → sidebar · `post` → content · `colophon` → footer · `editor` → content |

`post` and `editor` both target `content`. Reading swaps in one, editing swaps in the other. That is
the thing `content` was reaching for by being "almost a sub thing": it is not a view, it is where
views go.

### This is mesh-ui's ViewProvider, with its three faults removed

The good idea in `ViewRegistry` was exactly this — a named slot that different providers fill,
resolved at runtime. What to drop:

1. **The four hard-coded locations.** `'left-panel' | 'right-panel' | 'center-panel' | 'bottom-panel'`
   is an IDE baked into the framework. Tile names come from the *Application's own layout*, so a blog
   names `header` and an IDE names `panel.bottom`, and the framework knows neither.
2. **One instance per id.** `activeContainers: Map<providerId, HTMLElement>` made two editors
   impossible. Instance identity is the view id plus a key from its params.
3. **Author-managed disposables.** The kernel disposes what it scoped.

And in windowed mode, tile names are simply unused: every view is a window, and the layout is
whatever the user dragged. Same views, two geometries.

---

## 7. Local view state — **Proposed**

A gap the pure-function rule exposes, and it is not answered anywhere else.

[§4 of the model](./README.md) splits **view state** (window manager: geometry, z-order, mode) from
**application state** (the Application: scroll, forms, connections). A disclosure triangle's
open/closed is neither. It is not geometry, and it is not the Application's business.

If views are pure functions it has nowhere to live at all — which is the first thing anyone hits,
because a collapsible section is roughly the first view anyone writes.

**Proposed: the kernel holds it, per view instance, beside geometry.**

- A view declares its local state keys and their defaults, the same way it declares everything else.
- The kernel owns the values, so a pure view reads them from its context and requests changes through
  a handler.
- It persists with geometry, keyed per view instance — so a collapsed section stays collapsed across
  a reload, and two editors collapse independently.
- It survives a mode switch untouched, for the same reason geometry does.

This makes the ownership rule complete and stateable in one line: **the kernel owns everything about
a view except what the Application knows.**

---

## 8. The escape hatch — **Proposed**

Monaco, a canvas, a WebGL surface, a third-party map. An IDE cannot be built if raw access is
forbidden forever, and pretending otherwise would make this spec dishonest rather than strict.

**DOM access is a capability.** A `Surface` component hands over a region, and it is available only
to a contribution declaring `needs('dom')`.

Which means it is declared, greppable, narrowable, and visible in a manifest before anything runs —
the same properties every other capability has. And it is legible to the framework: a contribution
that declared `dom` cannot run across an isolation boundary, and the kernel knows that without
running it.

The rule: **`dom` is for embedding something the framework does not model, never for convenience.**
A view reaching for `dom` to render a list is a bug, and a review can see it in the manifest.

---

## 9. What isolation this makes possible — **Proposed**

[kernel §4](./kernel.md) states plainly that capabilities are an architecture boundary and not a
sandbox, because everything shares one realm. This layer is what turns that from a permanent
condition into an engineering problem.

If a view is data and events carry ids, an Application can run in a **worker**: it holds its own
reactive graph, emits descriptions and patches, and receives events by id. It never touches the DOM
because it never could.

Not promised, and not scheduled. What is decided is that **the description is pure data from the
start**, because that property is cheap to hold now and very expensive to retrofit.

Contributions declaring `dom` (§8) opt out, and that is a legible trade rather than a silent one.

---

## 10. What this changes elsewhere

- [application.md](./application.md) — `mount(el, vx)` becomes a pure `render`, and `views` joins a
  larger declaration surface. §2 and §6 there.
- [kernel.md](./kernel.md) — the renderer is kernel; §9's isolation entry is conditional on this
  document rather than open-ended.
- [README.md](./README.md) §2 — "below a view are components" now has a definition of *component*.
- [roadmap.md](./roadmap.md) — A0.4 splits into description layer and renderer; the component
  vocabulary (A7) moves onto the critical path instead of being a later audit.

---

## 11. Open

- **The component vocabulary itself.** Which primitives, with what props. §3 lists thirteen from the
  deleted runtime; nobody has audited them against a blog, a console and an IDE at once
  ([roadmap A7.1](./roadmap.md)).
- **How a component is defined** by an Extension contributing one — a fourth contract, or a plain
  function returning a description.
- **Styling.** Tokens as registry values is the intent ([roadmap A7.2](./roadmap.md)); what a
  component's style API looks like to an author is undecided.
- **Focus, selection and IME.** Now largely answered by [input.md](./input.md) — focus is renderer
  state with a first-class graph, and composition never crosses a boundary. A text editor with its
  own selection model remains the hard case, and §8's `dom` is the honest answer for it.
- **Accessibility.** If apps never write elements, the component library owns every role, label and
  focus order. That is an argument *for* this design, and it means the primitives must be right,
  because an app cannot patch around them. [input §3](./input.md)'s "every action has a non-pointer
  path" is most of this requirement already.
- **List virtualisation.** A ten-thousand-row table cannot send ten thousand nodes. Windowing has to
  be a component the renderer understands, not something an app implements.
