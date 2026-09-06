# Dispatch 10 Report: Dialog and Focus Trap

## 1. Executive Summary

Dispatch 10 introduces the **`dialog`** primitive into the `@flybyme/mesh-web` description vocabulary alongside a browser-level **focus containment trap** (`src/input/trap.ts`).

In standard web development, `<dialog>` elements and modals are typically manipulated through imperative DOM method calls (`dialog.showModal()`, `dialog.close()`) and brittle manual focus management libraries. In Mesh, an Application never touches DOM handles or invokes imperative dialog methods:
- **Declared State**: An Application declares whether a dialog is open via a reactive signal or boolean accessor: `dialog({ open: () => vx.app.dialogOpen(), ... })`.
- **Reconciliation to Native `<dialog>`**: The DOM renderer reconciles that declared reactive state to native `<dialog>`, calling `showModal()` and `close()`.
- **WhenNode Child Semantics**: When closed, the dialog's children are not in the DOM tree at all (`children: []` in `flattenDialog`), eliminating memory leaks, hidden state, and accidental query hits.
- **Focus Containment & Restoration**: Focus is renderer state owned by the kernel. When a dialog opens, focus automatically enters the dialog (prioritizing `[autofocus]`, then the first focusable control, then the dialog container itself). `Tab` and `Shift+Tab` navigation cycles strictly within the dialog. Closing restores focus to whatever element opened it.
- **Stack Discipline**: Traps form an explicit stack (`trapStack`). Nested dialogs push onto the stack so only the topmost dialog traps navigation; closing pops the stack and reactivates the parent trap.
- **Escape Key via Dismiss Intent**: Escape keypresses and native `cancel` events are intercepted and mapped to the declared `dismiss` intent, routing through the command system to the opener rather than executing raw DOM key handlers or uncoordinated browser closing.
- **Top Layer & No `z-index`**: Baseline CSS in `src/kernel.css` styles `dialog` and `dialog::backdrop` using semantic design tokens (`--surface`, `--edge`, `--ink`, `--shadow`, `--backdrop`) without any `z-index` rules. Two dialogs stack naturally in the browser's top layer.

### Verification Status
- **Typecheck**: `npm run typecheck` passes with **0 errors**.
- **Type Safety**: **Zero type assertions (`as ...`)** introduced in new production code.
- **Unit Tests**: **368 / 368 tests passing** across 19 test files (including new unit test suites in `test/description.test.ts` and `test/render.test.ts`).
- **Browser Tests**: **48 / 48 tests passing** across 7 test files in real Chromium via Playwright/Vitest (including 5 browser tests in `test/browser/dialog.browser.test.ts`).
- **Build**: `npm run build` succeeds cleanly, compiling TypeScript and copying `src/kernel.css` to `dist/kernel.css`.
- **Version Bump**: Bumped to minor **`0.13.0`** in `package.json` and `mesh.json`.
- **Specifications**: Updated `spec/input.md` ("Traps — Built") and `spec/html5.md` (ticked Dialog Element).

---

## 2. Dismissal Mechanics and Opener Coordination

### 2.1 How Dismissal Reaches the Opener
Native HTML5 `<dialog>` elements opened with `showModal()` have default browser behavior: pressing Escape cancels the dialog and closes it unilaterally. In Mesh, this ambient behavior is strictly forbidden because it would decouple DOM state from declared application state.

In `src/render/dom.ts`:
1. The renderer attaches listeners for native `cancel` and `keydown` (specifically matching `e.key === 'Escape'`) on the `<dialog>` element.
2. When triggered on the active topmost dialog, the handler immediately calls:
   - `e.preventDefault()`: Prevents the browser from unilaterally mutating `<dialog>.open` or closing the modal.
   - `e.stopPropagation()`: Stops the Escape key event from bubbling to parent dialogs or host windows.
3. If the dialog node declared a `dismiss` intent (`node.intents?.dismiss`), the renderer dispatches that intent:
   ```ts
   options.dispatch.dispatch(binding.action, undefined);
   ```
4. This intent dispatches a declared command (e.g. `command('post.cancel')` or `command('dialog.close')`), which invokes the opener's command implementation.
5. The opener updates its reactive state (e.g. `openSignal.set(false)`).
6. The reactive effect observing `node.open` executes, transitions from `next: true` to `next: false`, and invokes `closeModal()`.
7. `closeModal()` deactivates the focus trap, restores focus to the opener element, tears down the child reactive scope, removes the children from the DOM, and invokes `el.close()`.

### 2.2 What Happens If the Opener Ignores the Dismissal
Because `e.preventDefault()` is called on both `cancel` and `keydown` Escape:
- The browser **cannot** close the dialog natively.
- If the opener has no `dismiss` intent, or if the opener's command deliberately decides not to update state (e.g., an unsaved-changes confirmation prompt, an in-progress transaction, or a required modal auth challenge):
  - The application's declared state remains `open: true`.
  - The DOM `<dialog>` element remains open (`el.open === true`).
  - The focus trap remains active and top-of-stack.
  - Declared state and DOM reality **never diverge**.

---

## 3. Window-Owned Modality (Deliberately Not Built)

### 3.1 What Window-Owned Modality Needs
Window-owned modality is a desktop paradigm where a dialog is modal *only with respect to a single window* in windowed or tiled mode. In this paradigm:
- Window A opens a modal dialog.
- Interaction with Window A's main contents is blocked, and focus within Window A is trapped to that dialog.
- However, Window B, Window C, the system menubar, and other applications on the desktop remain fully interactive and can receive clicks and focus.

Building window-owned modality requires:
1. **Window-Scoped Backdrop**: An overlay positioned within the window frame (`.window`) rather than viewport-spanning document top layer.
2. **Window-Manager Focus Routing**: The `WindowManager` must intercept focus and pointer events aimed at that specific window and redirect them to the modal child, while permitting focus transitions to other windows.
3. **Modal Child Window Hierarchy**: A parent-child relationship between window records where closing or minimizing the parent hides or closes the modal child.
4. **Z-Index and Layering within Frame**: Proper stacking of the modal within the window's stacking context.

### 3.2 Why It Was Deliberately Not Built
Dispatch 10 implements `<dialog>` as a first-class description vocabulary primitive matching the Web Platform's native `<dialog>` element. Native `<dialog>.showModal()` places the element in the browser's top layer, which renders above all other elements and makes everything else in the document `inert`.

Window-owned modality is a **desktop shell refinement** that belongs in the `WindowManager` and shell chrome layer (`roadmap A4`), not in the foundational component description vocabulary. Conflating the two would have forced the component vocabulary to know about window IDs and manager topologies. `<dialog>` serves the universal case for application modals in single, tiled, and windowed modes alike.

---

## 4. Focus Trap vs. The Focus Graph

### 4.1 Did the Focus Trap Expose Flaws in the Focus Graph?
The focus graph described in `spec/input.md` §3 specifies directional navigation via three mechanisms:
1. **Spatial Scoring**: Computing candidate focus targets based on layout rects and axis overlap.
2. **Groups**: Scoping navigation within lists, toolbars, and sidebars.
3. **Explicit Overrides**: Component-level directional overrides.

The implementation of `FocusTrap` confirmed that **focus traps are orthogonal to spatial scoring**:
- Directional scoring operates on a flat or grouped spatial coordinate space.
- A focus trap is a **containment boundary and stack discipline**, not a layout node.
- Within a dialog, spatial scoring and focus groups work exactly as they do anywhere else. The trap simply acts as a boundary: queries for candidates are confined to `container.querySelectorAll(...)`, and boundary crossings wrap around.

### 4.2 Key Structural Insights
- **Stack Discipline**: Modal focus is intrinsically a stack. Dialog 1 opens Dialog 2; focus moves into Dialog 2; Escape or close pops Dialog 2; focus restores to the button in Dialog 1; Tab navigation in Dialog 1 resumes. Attempting to model this through spatial scoring would fail because the two dialogs overlap spatially.
- **Focus Is Renderer State**: Applications cannot set focus. The trap automatically manages focus transitions (entering `[autofocus]` or first focusable child on open, restoring to opener on close) inside the DOM renderer, keeping Applications pure data producers.

---

## 5. Evaluation of the Three Bootstrap Modal Use Cases

Bootstrap modals historically covered three primary patterns:

| Use Case | Status in Mesh | Architectural Solution |
| :--- | :--- | :--- |
| **1. Notifications & Alerts** | **Already served** | Served by `cx.notifications` kernel service (`NotificationHandle`, `mountNotifications`). Notifications appear in the kernel-owned notification host, do not trap focus, and do not belong in modal dialogs. |
| **2. Custom Content (Forms, Confirmations, Dialogs)** | **Served by Dispatch 10** | Served directly by `dialog({ open, props, intents, children })`. Full lifecycle reconciliation, lazy mounting matching `WhenNode`, Tab containment, and Escape dismissal. |
| **3. Lightboxes / Fullscreen Media Viewers** | **Deliberately not served** | Not served by standard `dialog()`. Lightboxes require pan/zoom pointer streams (Tier 2 input), gesture carousels, backdrop tap-to-dismiss without focus traps, and image preloading. These belong in dedicated surface components or future popover primitives. |

---

## 6. Reader Audit

In accordance with Mesh architectural principles, every added field and node type must have explicit, verified readers.

| Added Symbol / Field | Reader(s) | Description |
| :--- | :--- | :--- |
| `DialogNode` (`kind: 'dialog'`) | `flattenNode` in `src/description/flatten.ts` | Flattening pass produces `FlattenedNode` with empty children when closed. |
| `DialogNode` (`kind: 'dialog'`) | `build` in `src/render/dom.ts` | Routes to `buildDialog` to construct DOM element and attach focus trap. |
| `DialogProps.open` | `flattenDialog` in `src/description/flatten.ts` | Determines whether children are flattened or discarded. |
| `DialogProps.open` | `buildDialog` in `src/render/dom.ts` | Reactive effect reconciles `showModal()` / `close()` and child scope lifecycle. |
| `DialogProps` (`class`, `style`, `aria-*`) | `buildDialog` in `src/render/dom.ts` | Bound via `applyDefaultProp` or component definition `apply`. |
| `DialogProps` (`class`, `style`, `aria-*`) | `flattenDialog` in `src/description/flatten.ts` | Retained on flattened description for inspections and SSR. |
| `DialogOptions` | `dialog(...)` in `src/description/build.ts` | Convenience builder validating options and constructing `DialogNode`. |
| `createFocusTrap` / `FocusTrap` | `buildDialog` in `src/render/dom.ts` | Instantiated per dialog; manages trap activation, deactivation, and containment. |
| `getActiveTrap` | `buildDialog` in `src/render/dom.ts` | Ensures only the topmost active dialog consumes Escape key and cancel events. |
| `getFocusableElements` / `isFocusableElement` | `src/input/trap.ts` | Discovers interactive DOM nodes for Tab navigation and focus restoration. |
| `PRIMITIVES` (`Dialog`) | `createComponents(PRIMITIVES)` in `src/kernel/start.ts` | Registers default `Dialog` component definition (`<dialog>` tag with `data-mesh-dialog`). |
