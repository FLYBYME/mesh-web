# Dispatch 7 Report: Surface and Drag

## 1. Executive Summary

Dispatch 7 implements the two primitives deliberately held back from dispatch 6:
1. **`Surface` (Roadmap A7.5)**: The escape hatch from isolation specified in `spec/view-layer.md` §8. Accessible exclusively via the `needs('dom')` capability as `cx.dom.Surface(...)`, deliberately **excluded** from `PRIMITIVES`. Provides synchronous `setup(el: HTMLElement)` with unmount teardown, survives SSR in `flatten.ts` as an explicit placeholder without executing `setup`, and keeps DOM types strictly quarantined behind a single `host as HTMLElement` seam.
2. **`Draggable` & `DropZone` (Roadmap A7.3)**: Moving items with full compliance with `spec/input.md` §3 ("every action must have a non-pointer path"). Drag is implemented as a unified state machine: *selection (grab) followed by target (drop)*. Keyboard navigation, mouse click-to-grab/click-to-drop, and HTML5 pointer drag-and-drop all drive the exact same framework coordinator (`DragCoordinator`) and fire the exact same `mesh:drop` intent with payload.

### Verification Status
- **Typecheck**: `npm run typecheck` passes with **0 errors**.
- **Type Safety**: **Zero `as any`**, **zero `as never`**, and zero type assertions across all authored code except for the single `host as HTMLElement` seam in `broker.ts:makeDom`.
- **Unit Tests**: **331 / 331 tests passing** across 18 test files (including new `test/surface.test.ts` and `test/drag.test.ts`).
- **Boundary Tests**: `test/boundaries.test.ts` passes 62/62 tests; `src/description/` remains 100% free of DOM types.
- **Browser Tests**: `npm run test:browser` passes **34 / 34 tests**.
- **Build**: `npm run build` succeeds cleanly.
- **Version**: Bumped to **0.10.0** in `package.json` and `mesh.json`.
- **Roadmap**: `spec/roadmap.md` updated: A7.5 ticked, A7.3 drag half ticked and design decision documented.

---

## 2. The Five Key Architectural Questions

### 2.1 The Drag Model: Is the Keyboard Path the Same Path or Two Paths Agreeing by Convention?

In conventional UI toolkits, keyboard "drag-and-drop" is almost always a secondary system bolted onto a pointer-centric architecture. The mouse triggers `dragstart`, `dragover`, and `drop` events with native `DataTransfer` objects, while the keyboard triggers custom menus, modal dialogs, or arrow-key hotkeys. These two mechanisms share no state machine, use different events, and agree only by author convention. Under that paradigm, keyboard accessibility routinely rots because keeping two parallel interaction systems in sync requires continuous developer vigilance.

In Mesh, we inverted the model: **drag is fundamentally selection (grab) followed by target (drop)**.

The framework owns the state machine in a singleton coordinator (`src/render/drag.ts`):
- **Grabbing**:
  - Keyboard: Pressing `Space` or `Enter` on a focused `Draggable` (`tabindex="0"`) calls `coordinator.grab(payload, type, el)`.
  - Mouse Click: Clicking `Draggable` calls `coordinator.grab(payload, type, el)`. (Clicking again toggles/cancels grab).
  - Pointer Drag: Dragging `Draggable` triggers native `dragstart`, which calls `coordinator.grab(payload, type, el)`.
- **Target Affordance**:
  - Once an item is grabbed, `coordinator.grab` identifies all compatible `DropZone`s in the DOM tree, marking them with `[data-mesh-drop-target]` and `aria-dropeffect="move"`.
- **Dropping**:
  - Keyboard: Navigating focus (via `Tab`) to a `DropZone` and pressing `Space` or `Enter` calls `coordinator.drop(zoneEl)`.
  - Mouse Click: Clicking a `DropZone` calls `coordinator.drop(zoneEl)`.
  - Pointer Drop: Releasing over a `DropZone` triggers native `drop`, which calls `coordinator.drop(zoneEl)`.
- **Event Dispatch**:
  - In all three cases, `coordinator.drop` validates acceptance, clears grab state, and dispatches a single standard DOM CustomEvent: `mesh:drop` with `{ detail: payload }`.
  - The renderer's `bindIntents` listens for `mesh:drop` and dispatches `intents.drop` (with fallback to `intents.activate`), delivering the payload to the command or handler.
- **Cancellation**:
  - Pressing `Escape` at any time across all three modalities cancels the grab, resets coordinator state, and strips target attributes.

Because pointer dragging is an **affordance over the selection-and-target model** rather than the model itself, the keyboard path and pointer path are **genuinely the exact same path**:
1. They mutate the exact same coordinator state (`currentGrab`).
2. They apply the exact same DOM attributes (`data-mesh-grabbed`, `data-mesh-drop-target`, `data-mesh-drag-over`).
3. They dispatch the exact same `mesh:drop` event.
4. They deliver the exact same payload to the Application.

They cannot diverge or get out of sync because there is only one interaction pipeline in the framework.

---

### 2.2 Was Roadmap A8.2 (The Focus Graph) Required After All?

**No. A8.2 was not required to deliver full keyboard drag-and-drop.**

`spec/input.md` §3 requires that *every action has a non-pointer path*. Roadmap A7.1 had tentatively gated `Draggable`/`DropZone` on A8.2 under the assumption that moving between drop zones required a 2D spatial focus navigation graph (such as navigating a grid of kanban columns with arrow keys or a gamepad d-pad).

However, by modeling drag as selection followed by target, each phase of the operation is an ordinary activation of a focusable element:
1. `Draggable` elements are keyboard focusable (`tabindex="0"`, `role="button"`).
2. `DropZone` elements are keyboard focusable (`tabindex="0"`, `role="region"`).
3. The browser's native sequential focus navigation (`Tab` / `Shift+Tab`) moves focus between the grabbed draggable and candidate drop zones.
4. Activation via `Space` or `Enter` completes the grab and drop.

A test in `test/drag.test.ts` proves this:
```ts
// 1. Focus draggable and press Space -> grabs payload
draggableEl.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
expect(hasGrab()).toBe(true);

// 2. Tab to dropzone and press Enter -> drops payload
dropzoneEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
expect(droppedPayloads).toEqual([cardPayload]);
```
This test passes completely and would fail on any pointer-only implementation.

What A8.2 will eventually add is *spatial shortcutting* (e.g. pressing `RightArrow` to jump directly to the adjacent column rather than tabbing through intermediate controls). But for keyboard accessibility and non-pointer operation, standard sequential navigation is fully sufficient, robust, and completely functional today.

---

### 2.3 What Declaring `needs('dom')` Costs a Part, and What It Buys a Reviewer

`Surface` hands over a raw `HTMLElement` to author code. This is a fundamental escape hatch from the framework's isolation model (`spec/view-layer.md` §8).

#### What it costs a part:
1. **Loss of Isolation**: The contribution cannot be moved into a Web Worker, off-thread sandbox, or multi-process boundary. An Application that renders pure descriptions could theoretically run anywhere; a part that declares `dom` is bound directly to the main DOM thread.
2. **Loss of Pure Serialization**: The part's view output cannot be fully serialized as pure JSON data or replayed headlessly.
3. **Manual Lifecycle Burden**: The author is responsible for managing internal DOM instances (Monaco Editor, Chart.js, HTML5 Canvas, WebGL context) and returning a cleanup function from `setup(el)`.
4. **Visibility in the Manifest**: The part must explicitly declare `needs('dom')` in its manifest. It cannot reach `Surface` dynamically or covertly; `element('Surface')` throws `Unknown component "Surface"`, and `cx.dom` is `undefined` unless declared.

#### What it buys a reviewer:
1. **Instant Auditability**: In a large workspace with dozens of extensions and applications, a security auditor or code reviewer can grep for `needs('dom')`. 95%+ of contributions will only declare high-level capabilities (`state`, `commands`, `windows`, `storage`). The few parts asking for raw DOM are immediately conspicuous.
2. **Targeted Security Scrutiny**: Because DOM access is the primary vector for XSS, DOM-clobbering, and memory leaks, reviewers know precisely where to focus their attention without having to inspect thousands of pure description templates.
3. **Enforceable Hosting Policies**: Site hosts and package managers (`mesh-serve`, deployment gateways) can statically inspect manifests and refuse or flag third-party contributions declaring `needs('dom')`, restricting raw DOM access to trusted built-ins or enterprise-vetted packages.

---

### 2.4 What `flatten` Does with a `Surface`, and Whether That Is Honest for SSR

`flatten.ts` is the server-side rendering (SSR) and test traversal pipeline. It resolves dynamic signals, conditional branches (`when`), and keyed lists (`each`), outputting a static `FlatElement` tree with no DOM and no execution environment.

When `flatten` encounters a `SurfaceNode`:
```ts
function flattenSurface(node: SurfaceNode): FlatElement {
    const props: Record<string, Json> = {
        'data-mesh-surface': 'placeholder',
    };
    if (node.props) {
        for (const [name, value] of Object.entries(node.props)) {
            if (value === undefined) continue;
            props[name] = read(value);
        }
    }

    return {
        kind: 'element',
        component: 'Surface',
        props,
        ...(node.key !== undefined ? { key: node.key } : {}),
        children: [],
    };
}
```

#### Why this is honest:
1. **No Phantom Execution**: `flatten` **never calls `node.setup(el)`**. In an SSR environment, there is no real browser layout engine, no GPU WebGL context, and no Monaco editor runtime. Pretending to execute `setup` against a mock DOM would crash third-party libraries or leak un-teardownable resources.
2. **Explicit Semantic Placeholder**: Returning a placeholder element with `data-mesh-surface="placeholder"` honestly communicates to SSR consumers (and search crawlers) that a dynamic client-rendered region exists here.
3. **Client Handover**: During client hydration, the DOM renderer creates the real container element and invokes `setup(el)` synchronously with the real `HTMLElement`.

SSR cannot realistically render a WebGL canvas or Monaco editor into static HTML strings; emitting an explicit, structured placeholder preserves the tree layout without false pretenses.

---

### 2.5 Coherence of the Eighteen Primitives

With the completion of Dispatches 6 and 7, the primitive vocabulary now contains eighteen components:
```
Stack, Row, Grid, ScrollView,
Text, Heading, Span,
Button, Input, TextArea, Form,
Draggable, DropZone,
List, ListItem, Card, Badge, Divider
```
*(Note: `Surface` is intentionally NOT in `PRIMITIVES`; it is accessed via `cx.dom.Surface`).*

#### Architectural Coherence:
1. **Layout Continuum (1D to 2D to Viewport)**:
   - `Stack`: 1D vertical flex column with semantic `gap`.
   - `Row`: 1D horizontal flex row.
   - `Grid`: 2D Cartesian grid layout with `columns`, `rows`, `gap`, `areas`.
   - `ScrollView`: Dedicated scroll viewport with automatic overflow detection and keyboard accessibility (`tabindex="0"`, `role="region"`).
2. **Semantic Typography**:
   - `Heading`: Now accepts `level: 1..6`, emitting semantic HTML `<h1>` through `<h6>`.
   - `Text`: Standard paragraph/text node.
   - `Span`: Fine-grained inline text formatting (`bold`, `italic`, `code`, `color`, `size`).
3. **Interactive & Input Modalities**:
   - `Button`: Standard click/activate control.
   - `Input`: Single-line text, password, checkbox, radio with dirty-value preservation.
   - `TextArea`: Multi-line text editor with dirty-value preservation and newline handling.
   - `Form`: Semantic form wrapper with `commit` intent.
   - `Draggable` & `DropZone`: Complete spatial grab-and-drop system satisfying keyboard and pointer equivalence.
4. **Structural Presentation**:
   - `Card`: Semantic container (`<section>`).
   - `Divider`: Semantic separator (`<hr>` with horizontal/vertical orientation).
   - `List` & `ListItem`: Semantic list containers (`<ul>`, `<li>`).
   - `Badge`: Status/indicator pill (`<span>`).

#### Does anything in the original set look wrong?
- In the initial prototype of 11 primitives, `Card` and `Badge` were heavily overloaded. `Badge` was abused as inline code, inline chips, and data table cells because `Span` was missing. `Card` was abused as a divider (collapsed to 1px) and as a code block.
- With `Span` and `Divider` added in dispatch 6, `Badge` and `Card` have returned to their clean, intended semantic roles.
- The eighteen primitives form a self-contained, highly coherent vocabulary that covers the full range of desktop and productivity application requirements without needing raw DOM escape hatches for standard UI construction.

---

## 3. Summary of Code Changes

| File | Changes Made |
| :--- | :--- |
| `src/description/types.ts` | Added `'drop'` to `IntentName`; widened `IntentValue` to `Json \| undefined`; added `SurfaceNode` to `Node` using method bivariance `setup(host: unknown): (() => void) \| void`. DOM types kept out of description layer. |
| `src/description/index.ts` | Exported `SurfaceNode`. |
| `src/description/flatten.ts` | Added `case 'surface'` in `flatten()` producing explicit placeholder `FlatElement` without invoking `setup()`. |
| `src/contribution/capabilities.ts` | Added `SurfaceOptions` (with `setup(el: HTMLElement): (() => void) \| void`); defined `Dom` capability interface (`Surface` and `surface`); added `dom: Dom` to `CapabilityMap`. |
| `src/contribution/index.ts` | Exported `Dom` and `SurfaceOptions`. |
| `src/kernel/broker.ts` | Wired `case 'dom'` in `createContext`; implemented `makeDom()` registering safe teardowns in kernel cleanups; single DOM seam cast `host as HTMLElement`. |
| `src/render/drag.ts` | **New file**: Implemented `DragCoordinator` managing `currentGrab` state (`payload`, `type`, `element`), drop validation (`accepts`, disabled checks), attribute management (`data-mesh-grabbed`, `data-mesh-drop-target`), Escape cancellation, and `mesh:drop` dispatch. Zero casts. |
| `src/render/component.ts` | Added `Draggable` and `DropZone` to `PRIMITIVES` (with `spaceIsTextInput: false`). Attached click, keydown (Space/Enter), dragstart, dragover, drop listeners driving `DragCoordinator`. Handled `data`, `type`, `accepts`, `disabled` reactively in `apply`. |
| `src/render/dom.ts` | Added `case 'surface'` in `build()`; implemented `buildSurface` running `setup(el)` and binding teardown to reactive scope. Updated `bindIntents` to handle `mesh:drop` for `intents.drop` and fallback `intents.activate`. |
| `src/render/index.ts` | Exported drag coordinator utilities (`canDrop`, `cancelGrab`, `drop`, `getGrabbed`, `grab`, `hasGrab`, `isGrabbed`, `resetDrag`). |
| `src/kernel.css` | Added styling for `[data-mesh-surface]`, `[data-mesh-draggable]`, `[data-mesh-grabbed]`, `[data-mesh-dropzone]`, `[data-mesh-drop-target]`, `[data-mesh-drag-over]`. |
| `package.json` | Bumped version from `0.8.0` to `0.10.0`. |
| `mesh.json` | Bumped version from `0.8.0` to `0.10.0`. |
| `spec/roadmap.md` | Ticked A7.5 and A7.3 drag half; documented the drag model decision. |
| `test/surface.test.ts` | **New file**: 7 tests verifying `Surface` lifecycle, capability scoping, SSR flattening, and teardown execution. |
| `test/drag.test.ts` | **New file**: 8 tests verifying keyboard drag (Enter/Space grab -> Tab -> Enter/Space drop), mouse click grab/drop, HTML5 pointer DnD, Escape cancel, type filtering, disabled state, and reactive updates. |
| `test/render.test.ts` | Updated `typed` array type to `IntentValue[]`. |

---

## 4. Verification

1. **Unit Test Suite**:
   ```
   Test Files  18 passed (18)
        Tests  331 passed (331)
   ```
2. **Browser Test Suite**:
   ```
   Test Files  4 passed (4)
        Tests  34 passed (34)
   ```
3. **Typecheck**:
   ```
   npm run typecheck -> 0 errors
   ```
4. **Boundary Verification**:
   ```
   test/boundaries.test.ts -> 62/62 passed (zero DOM types in src/description/)
   ```
5. **Type Assertion / Cast Audit**:
   - Zero `as any`
   - Zero `as never`
   - Only 1 cast in newly introduced code: `host as HTMLElement` at the Surface boundary seam in `broker.ts:makeDom`.
