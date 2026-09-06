# Input

Keyboard, mouse, touch, pen, and gamepad — as one model, owned entirely by the framework.

**Status.** **Decided:** the framework owns input, directional navigation is first-class, and an
Application never controls its own window. The rest is **Proposed**.

Companions: [the view layer](./view-layer.md) · [the kernel](./kernel.md) ·
[Applications](./application.md) · [the model](./README.md) ·
[storage and the registry](./storage-and-registry.md).

---

## 1. The framework owns input, because it has no choice — **Decided**

[view-layer.md](./view-layer.md) removed the DOM from an Application's reach. An Application that
never sees an `HTMLElement` never sees a `PointerEvent` either — there is no lower layer left to leak
through. So either the framework defines the whole input model, or Applications get nothing.

That is a burden and an opportunity, and the opportunity is larger:

> **A gamepad has no pointer.** A d-pad navigates a focus graph, spatially, in two dimensions.
> Computing that graph requires knowing the layout — which the renderer does and an Application does
> not.

An app writing raw DOM has to implement directional navigation itself, per app, badly, or not at
all. Because the renderer owns the tree, the framework computes it **once, for everything**. This is
a capability the previous architecture could not have had.

The target hardware is not hypothetical: tablets (touch and pen) and Steam Decks (gamepad, two
trackpads, gyro, back buttons) alongside desktops.

---

## 2. Three tiers — **Proposed**

| tier | what an Application receives | for |
| --- | --- | --- |
| **intents** | `activate`, `context`, `navigate`, `commit`, `dismiss` … | everything, by default |
| **streams** | normalized pointer/pen samples as data | drawing, dragging, viewports |
| **`dom`** | an element, via the `dom` capability | Monaco, canvas, WebGL |

### Tier 1: intents — **Proposed**

An Application receives **what was meant**, never what was pressed. Never `click`, never `keydown`,
never `buttondown`.

`context` is a right-click, a long-press, the Menu key, `Shift+F10`, or a Deck's back button. The
Application does not know which and must not care. This is the same argument as commands: a verb
that is addressable is a verb reachable from any device.

A first vocabulary, to be argued over:

| intent | mouse | keyboard | touch | gamepad |
| --- | --- | --- | --- | --- |
| `activate` | left click | Enter / Space | tap | A |
| `context` | right click | Menu / Shift+F10 | long press | Y |
| `navigate(dir)` | — | arrows / Tab | swipe | d-pad / left stick |
| `commit` | — | Enter | — | Start |
| `dismiss` | — | Escape | back gesture | B |
| `scroll(delta)` | wheel | PgUp/PgDn | two-finger drag | right stick |
| `zoom(delta)` | Ctrl+wheel | Ctrl +/− | pinch | triggers |

The mapping is data, not code — §7.

#### An intent carries its value — **Decided 2026-09-04**

`change` means *this is now the value*, and an intent that could not say what the value is made a
form impossible to write. That was the state until the first site built on this framework needed a
sign-in box: `Input` was a primitive, `change` was in the vocabulary above, the renderer bound the
listener — and what a person typed stopped at the renderer and never reached the Application.

So a dispatch carries a value: `dispatch(action, value?)`, where the value is a `string`, a
`boolean`, a `number`, or `undefined`.

**It is still the value and never the event**, which is what keeps this rule intact rather than
carving an exception into it. An Application receives what was *meant*, and for a field the thing
meant is what it now holds — not a `KeyboardEvent`, not an element, nothing with a path back to the
DOM. A description still crosses an isolation boundary unchanged.

Three details, each of which was a wrong first answer:

- **The intent decides whether there is a value, not the element.** A `<button>` has a `value`
  property — always `''` — so asking the element would deliver an empty string to every command a
  button reaches, and every handler would need to know to ignore it. `activate` carries nothing.
- **It listens for `input`, not `change`.** The DOM's `change` fires on blur, so a form whose button
  is clicked straight from a focused field never sees the last thing typed. That is the classic
  dropped password, and it is invisible to any test that dispatches events by hand.
- **An empty number field is `undefined`, not `0`.** `Number('')` is a number nobody typed, and what
  an empty field means is the reader's decision rather than the renderer's.

For a command the value is **appended** to the arguments the author declared, so
`command('post.rename', slug)` on a field arrives as `run(slug, title)` — a binding that gains a
value does not move the arguments already written.

### Tier 2: normalized streams — **Proposed**

Drawing and dragging need more than an intent. A component may opt into a sample stream:

```
{ pointerId, x, y, pressure, tiltX, tiltY, twist, type: 'mouse' | 'pen' | 'touch', buttons }
```

Detailed, and still **plain data**, so it crosses an isolation boundary like anything else. **Raw
input and raw DOM are different things**, and conflating them would have made `dom` the answer to
every drawing app.

Opting in is per component, declared, and visible in the manifest.

### Tier 3: `dom` — **Proposed**

The escape hatch already specified in [view-layer §8](./view-layer.md). Text editors with their own
selection and IME handling are the honest case.

---

## 3. Focus and directional navigation — **Decided: first-class**

Not opt-in. Every Application is navigable without a pointer.

The alternative was considered and rejected: retrofitting a focus graph onto a component library
designed without one is the kind of work that never actually happens, and "gamepad apps are a special
kind" means every other app is quietly mouse-only forever.

### The graph — **Proposed**

Three mechanisms, because spatial scoring alone produces navigation that feels random:

1. **Spatial scoring.** Every focusable node has a rect from layout. Moving in a direction picks the
   best candidate by overlap on the perpendicular axis and distance on the primary axis. Handles the
   common case with no author input.
2. **Groups.** A list, a toolbar, a sidebar is a focus *group*. Navigation moves within the group;
   leaving it moves at group level, and re-entering restores the last focused member. Without groups,
   moving right from a sidebar lands in an arbitrary row of a table. **This is the mechanism that
   makes it feel designed rather than computed.**
3. **Explicit overrides.** A component may declare `navigate: { down: 'footer' }` where scoring gets
   it wrong. Rare by design; if it is common, groups are wrong.

**Traps — Built.** A modal traps focus (`src/input/trap.ts`, `DialogNode`). On open, focus
automatically enters the modal (prioritizing `[autofocus]`, then the first focusable child, then
the container). `Tab` and `Shift+Tab` cycle strictly within the active dialog; controls behind the
modal cannot be reached. Traps form an explicit stack (`trapStack`): a nested dialog pushes onto
the stack so only the topmost dialog traps navigation. When dismissed or closed, the trap pops from
the stack and restores focus to whatever element opened it. Escape key events map directly to the
topmost dialog's `dismiss` intent rather than executing uncoordinated browser dismissals or raw DOM
key handlers. If the opener ignores the dismissal, declared state and DOM reality do not diverge.
A window in windowed mode traps until dismissed at the window-manager level.

**Focus is renderer state**, not application state, and not view state in the geometry sense. It is
per view instance, restored with it, and moved by the kernel — never set by an Application.

### What this constrains in the component vocabulary — **Decided**

The rule, and it gates [roadmap A7.1](./roadmap.md):

> **Every action must have a non-pointer path.**

Which forbids, in the primitives:

- **Hover-only affordances.** Hover does not exist on touch or gamepad. A menu that opens on hover is
  unreachable; it opens on `activate`.
- **Position-only interactions.** A slider must accept discrete increments, not only "drag to x".
- **Unfocusable interactive elements.** If it does something, it takes focus.
- **Hit targets fixed in pixels.** Sized by modality — §4.
- **Drag as the only path.** Reordering by dragging needs a modifier+arrow equivalent.

Accessibility and gamepad support are the same requirement wearing different clothes, which is
convenient: doing this well means [roadmap A7.7](./roadmap.md) mostly falls out.

---

## 4. Modality is framework state — **Proposed**

A Steam Deck can emulate a mouse. Tablets emit synthetic mouse events. **Building for mouse and
relying on emulation produces software that is bad on both** — no hover, imprecise targets, a laggy
trackpad pointer standing in for a finger.

So the framework tracks the current modality as a signal:

```
modality(): 'pointer' | 'touch' | 'pen' | 'directional'
```

Components read it. Larger hit targets under `touch`, focus rings only under `directional`, hover
affordances only under `pointer`, pressure-aware tools under `pen`. **One component definition,
correct on all of them** — and correct at run time, because a Deck user who plugs in a mouse switches
modality mid-session.

Modality changes on the most recent real input, with hysteresis so a stray event does not flip the
whole UI.

---

## 5. The renderer owns feedback; the Application owns consequences — **Decided**

This is [the view layer's rule](./view-layer.md) applied to input, and it is also the latency answer.

**Never reaches the Application:** hover and press states, focus movement, scroll and its momentum,
drag ghosts, resize previews, hit-target sizing, selection rectangles, tooltips, keyboard repeat.

**Reaches the Application:** the drop, the activation, the committed text, the chosen value.

A node declares that it is draggable; the renderer performs the entire drag and reports on drop. So
the round trip only happens for things that were going to be asynchronous anyway, and a worker-hosted
Application still feels immediate because the parts that must be immediate never left the renderer.

---

## 6. Window management is input — **Decided**

> "in windowed mode the app does not control the window and the kernel does, resizing windows should
> be baked in"

**An Application never moves, resizes, stacks, minimises, maximises or closes its own window.** It
may *declare preferences* — a view's default size and minimum size ([Applications §6](./application.md))
— and it may *observe* its size so a view can lay out responsively. Observing is reading; it is not
control.

Move and resize are **kernel mechanics, baked in**, for a reason §3 makes concrete: resizing with a
d-pad requires a window-management mode driven by the framework's own focus and input system. A
decoration Extension could not implement that, and a broken one must not be able to make windows
unresizable.

This refines [kernel §2](./kernel.md): window *mechanics* are kernel, window *appearance* is an
Extension.

**A window-management mode — Proposed.** Enter it with a binding; the d-pad or arrows then move or
resize the focused window with modifier for the other; confirm or dismiss to leave. Exactly a tiling
window manager's keyboard mode, and it is what makes floating windows usable on a Deck at all.

In tiled mode, geometry comes from the layout and none of this applies except moving focus between
tiles.

---

## 7. Bindings — **Proposed**

[The manifest](./application.md) declares `keys`. That generalises: a **binding** maps any input
signal to a command, across device classes.

```
bindings: [
    { command: 'blog.newPost', keys: 'alt+n', gamepad: 'Y', gesture: 'two-finger-tap' },
]
```

One command, many ways to reach it — which is exactly why declaring commands first was right. The
input map is a separate layer resolving onto verbs that already exist.

**Profiles live in the `device` hive**, which [storage §2](./storage-and-registry.md) already
defines. A Steam Deck's binding profile is per-device, per-user, overridable state, and it falls out
of the registry with no new mechanism. A user rebinding `Y` is writing a registry value, and it
survives because the Application declared the command rather than registering a handler for a key.

Conflicts resolve at load time with everything else ([kernel §3](./kernel.md) step 4).

### 7.1 Some bindings are not ours to take — **Decided**

Found by someone opening the harness and pressing the key the docs told them to, 2026-09-03. **This
document's own example was `ctrl+n`, and `ctrl+n` opens a browser window.** The handler ran, the
command fired, and a new tab opened over the top of it.

A page cannot prevent the browser's own accelerators. `preventDefault()` on `ctrl+n`, `ctrl+t`,
`ctrl+w`, `ctrl+shift+n` and the rest is simply ignored — they are handled before the page sees the
event, and no amount of being a framework changes that. §1 says the framework owns input *because it
has no choice*; this is the boundary of that claim, and it belongs written down next to it rather
than discovered per Application.

So the binding layer has a third outcome besides bound and conflicting: **reserved**.

- **A reserved binding is a load-time conflict**, reported like any other ([kernel §3](./kernel.md)
  step 4). An Application declaring `ctrl+n` gets an error naming the reason, not a binding that
  half works — a command that fires *and* opens a tab is worse than one that does not fire, because
  it looks like it worked.
- **The reserved set is per-host, not universal.** A page inside a browser tab loses far more than
  the same framework in an Electron shell or a kiosk, and a locked deployment
  ([README §5](./README.md)) may own the whole keyboard. So the set is a property of the host
  adapter, not a constant in the framework.
- **The fallback is the point of §7 anyway.** `blog.newPost` is reachable by `alt+n`, by `Y` on a
  gamepad, by a two-finger tap, and from the command palette. One command, many ways to reach it —
  losing one of them to the browser costs a route, not an action. That is only true because the
  Application declared a *command* rather than registering a handler for a key.

The general shape is worth naming because it will recur: the framework cannot own input it does not
receive. `ctrl+n` is the first instance; full-screen entry, clipboard access and pointer lock are the
same problem with different names, and each is a permission the host grants rather than a capability
the kernel can hand out.

---

## 8. Text input — **Proposed**

**A hardware keyboard may not exist.** A text component *requests* text entry rather than assuming
focus is enough, so the platform can raise a tablet keyboard or the Steam OSK.

**Composition never crosses a boundary.** IME is stateful, latency-critical, and deeply tied to the
platform. The renderer owns composition; the Application receives **committed text**, not keystrokes.
That is the right split anyway — an Application reacting to individual keypresses in a text field is
usually a bug — and it means an app can be hosted remotely without breaking Japanese input.

The hard case stays hard: an editor with its own selection model and inline completion wants raw
composition events. That is `dom` until someone proves otherwise.

---

## 9. The gamepad polling problem — **Proposed**

The Gamepad API has no events. `navigator.getGamepads()` must be polled, so the kernel runs a poll
loop — which collides with [kernel §6](./kernel.md): one thread, no preemption, and a poll loop is
work that happens whether or not anything is happening.

Constraints that follow:

- **Poll only while a gamepad is connected**, started and stopped by `gamepadconnected` /
  `gamepaddisconnected`.
- **Stop when the tab is hidden.** This is a handheld; a background poll loop is battery.
- **Analog needs shaping** — dead zones, an initial delay and a repeat rate for navigation,
  acceleration for scroll. Raw stick deflection as navigation is unusable.
- **The loop is the kernel's alone.** No Application polls anything.

---

## 10. Open

- **The intent vocabulary.** §2's table is a first draft. It wants review against a blog, a console
  and an IDE before it is fixed, because adding an intent later is cheap and changing one is not.
- **Gyro and trackpads.** A Deck has two trackpads and a gyro. Trackpad-as-pointer is the obvious
  mapping; gyro has no obvious meaning outside games and is probably not the framework's business.
- **Multi-touch gestures** beyond tap, long-press, pinch and two-finger scroll. Custom gestures are a
  recognition problem and probably belong to components rather than the framework.
- **Pen latency.** Ink under ~20ms rules out any round trip. Tier 2 pinned to the main thread, and an
  Application drawing this way opts out of isolation — legibly, since it declared the stream.
- **Palm rejection**, which the platform partly does and partly does not.
- **How modality interacts with a locked build.** A blog stripped of floating mode
  ([README §6](./README.md)) still needs directional navigation; a kiosk may want *only* directional.
- **Whether an Application may observe its own size at pixel precision** or only at declared
  breakpoints. Pixel precision invites layout thrash across a boundary; breakpoints may be too
  coarse for a canvas.
