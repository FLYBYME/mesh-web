# Dispatch 13 Report: Component Contribution via Extensions

## 1. Executive Summary

Dispatch 13 delivers the capability for Extensions to contribute components to the framework, closing the open architectural gap identified in `spec/components.md` §2 and roadmap item A7.4a.

### The Problem
Previously, `createRegistry()` in `src/render/component.ts` contained registration and conflict-detection machinery:
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
That error anticipated multiple contributors, but the contribution layer contained zero references to `components`. There was exactly one caller in the entire codebase (`window/page.ts`, registering the internal `WindowHost` marker). The extension point was designed, but the wiring from declarations to the manifest, conflict merge pipeline, and render registry was missing. It stood as a reader-audit entry: an error message anticipating contributors that could not exist.

Without this mechanism, there was no way to provide a design system (`ui.*`), forcing applications to write repetitive inline styles and hard-coded colors (578 `element()` calls across ten applications, 446 inline `style: {}` objects, 318 hard-coded hex colors against 93 theme tokens).

### The Solution
1. **Manifest Declaration**: Added `components?: readonly ComponentDefinition[]` to `Declarations` in `src/contribution/contract.ts`.
2. **Conflict Resolution & Prefix Enforcement**: `mergeManifests` (`src/kernel/manifest.ts`) merges declared components into `manifest.components`. It surfaces duplicate name claims in `manifest.conflicts` (surfaced as warnings at boot) rather than throwing at render, and enforces that contributed components are namespaced by their contributing part (`${id}.*`).
3. **Route into Registry**: In `src/kernel/start.ts:234`, all contributed components in `kernel.manifest.components` are registered into `ComponentRegistry` alongside `PRIMITIVES` before page chrome or application windows are mounted.
4. **Enhanced Diagnostic Attribution**: `RenderOptions` now accepts an optional `part?: string` passed through `mountShell` and `mountView`. When a part renders an unknown component name, the renderer names both the unknown component and the specific part that requested it.
5. **DOM Boundary Clarification**: Documented and verified why a `ComponentDefinition` touches the DOM (`create(props): Element`) while the description layer remains 100% free of DOM types.

### Verification Summary
- **Unit Tests**: **378 / 378 tests passing** across 21 test files (Transform: 5.0s, Tests: 4.3s). All 371 existing tests pass unmodified; 7 new tests in `test/component-contribution.test.ts` verify manifest merging, prefix enforcement, load-time conflict deduplication without render throws, and error attribution.
- **Browser Tests**: **49 / 49 tests passing** across 8 test files in real Chromium via Vitest browser runner / Playwright. New browser test `test/browser/component.browser.test.ts` proves that an Extension provides a component (`ui.Banner`) and an Application renders with it in real DOM layout with verified bounding box dimensions and computed styles.
- **Boundary Verification**: `test/boundaries.test.ts` passes 67/67 assertions. Zero node imports in `src/`, zero DOM types in `src/description/`.
- **Typecheck**: `npm run typecheck` (`tsc -p tsconfig.check.json --noEmit`) clean (0 errors).
- **Zero Casts**: Zero `as any`, zero `as never`, zero type assertions in implementation or tests.
- **Kernel Minor Bump**: Bumped to `0.15.0` in `package.json`.
- **Specifications Updated**: `spec/components.md` §2 updated from "built and unwired" to active specification; `spec/roadmap.md` A7.4a marked closed.

---

## 2. Whether the `ui.` Prefix is Enforced or Permitted, and the Argument

### The Decision
The kernel **enforces** the prefix: every component declared by a contribution with identifier `id` must start with `${id}.` (specifically `${id}.${componentName}` where `componentName` is non-empty).

For example:
- An Extension with `id: 'ui'` must name its components `ui.Card`, `ui.Nav`, `ui.Slider`.
- An Extension with `id: 'dashboard'` must name its components `dashboard.Widget`, `dashboard.Metric`.
- A contribution with `id: 'ui'` attempting to declare `Card` is rejected with a load-time conflict in `manifest.conflicts`.
- A contribution with `id: 'custom'` attempting to declare `ui.Card` is rejected with a load-time conflict in `manifest.conflicts`.

### The Argument
1. **"Discipline into Mechanism"**:
   As `spec/components.md` and the prompt note: *"This project's word for things that are merely permitted is 'encouraged', and it uses that word about things that do not happen."*
   The codebase history demonstrates that "encouraged" conventions fail:
   - Applications were encouraged to use theme tokens; instead, they wrote 318 hard-coded hex literals against 93 token uses.
   - Applications were encouraged to avoid inline styling; instead, 77% of call sites wrote `style: {}` objects.
   - Window frames were encouraged to respect `closable`; instead, chrome ignored it until the kernel enforced it in dispatch 8.
   If namespacing were merely permitted, authors would declare bare names like `Card` or `Button`, leading to silent namespace collisions.

2. **Invariant Protection for Kernel Primitives**:
   The 19 primitives (`Stack`, `Row`, `Grid`, `Card`, `Divider`, `ScrollView`, `Text`, `Span`, `Heading`, `Badge`, `Button`, `Input`, `TextArea`, `Form`, `List`, `ListItem`, `Dialog`, `Draggable`, `DropZone`) occupy the un-dotted PascalCase namespace. Because every contributed component must contain a dot prefixed with its part id, contributed components and kernel primitives form **disjoint sets of names by construction**. No Extension can ever shadow, override, or collide with a primitive component.

3. **Namespace Squatting and Conflict Containment**:
   The component registry is a single map per page. If prefixes were merely permitted, a third-party extension `plugin-x` could declare `ui.Card` or `Button`. Enforcing that only contribution `id` can declare `${id}.*` ensures that:
   - An Extension cannot squat on or hijack another part's component namespace.
   - A part cannot pollute the global namespace.
   - Two distinct parts can never legitimately declare the same component name. If an attempt is made, it is caught at manifest merge time and flagged before anything runs.

4. **Consistency with `requiredParts`**:
   An Application using `ui.Card` declares `requiredParts: [{ id: 'ui', version: '^1.0' }]` in `mesh.json`. The dependency mechanism already resolves parts by `id`. Enforcing that the component prefix matches the contributing part id creates direct transparency: seeing `element('ui.Card')` in a view immediately identifies that the part `ui` must be present in the composition.

---

## 3. The DOM Boundary

### Why a Component May Create Elements When a Description May Not
The description layer (`src/description/types.ts`) explicitly states:
> *"Deliberately no `HTMLElement`, `Node` or `Event` anywhere in it. Descriptions are data, so a render can be flattened, asserted on, or run on a server without jsdom or a browser."*

At the same time, `ComponentDefinition` in `src/render/component.ts` specifies:
```ts
export interface ComponentDefinition {
    readonly name: string;
    create(props?: Props): Element;
    apply?(el: Element, name: string, value: Json): boolean | void;
    slot?(el: Element): Element;
    readonly spaceIsTextInput?: boolean | ((el: Element) => boolean);
}
```
`create` returns an `Element`. This is the **one place in the entire system where a part touches the DOM**.

### The Principle: Implementing the Vocabulary vs Using It
The distinction is between **vocabulary use** and **vocabulary implementation**:
- **Applications and Views use the vocabulary**: They describe the user interface using pure data trees (`ElementNode`, `TextNode`, `WhenNode`, `EachNode`). They never touch DOM nodes, never inspect elements, and never attach native event listeners.
- **Components implement the vocabulary**: A `ComponentDefinition` is not a description. It is the renderer plugin that teaches the renderer how to instantiate and update a named vocabulary term in the DOM.

Just as the kernel's built-in primitives (`tag('Button', 'button')`) instruct the renderer how to turn the description `element('Button')` into `<button>`, an Extension providing `ui.Card` instructs the renderer how to turn `element('ui.Card')` into `<div class="ui-card">`.

### Stating the Boundary So It Is Not Widened
To prevent future dispatches from blurring this line:
1. **Views describe; Extensions implement vocabulary; the Renderer reconciles.**
2. **Applications and views never receive DOM nodes.** `ViewDecl.render(vx)` returns a `DescriptionNode`. `vx` provides state (`vx.app`, `vx.internal`, `vx.params`), window controls (`setTitle`, `close`), and lifecycle (`onDispose`), but never an `Element`.
3. **`ComponentDefinition` methods are executed exclusively by the renderer.** `create` is called once per element instance during `render()`, and `apply` is called when reactive props change.
4. **No DOM leaking**: A component definition must not expose DOM elements to the application layer. It interacts with the DOM solely to construct the host element and assign attributes/properties requested by the description's props.

---

## 4. What Happens Today When a Part Renders an Unregistered Component Name, and What Happens Now

### What Happened Today
Previously, `src/render/dom.ts:167` had:
```ts
const definition = options.components.get(node.component);
if (definition === undefined) {
    throw new Error(
        `Unknown component "${node.component}". ` +
        `Known: ${options.components.names.join(', ') || '(none registered)'}.`,
    );
}
```
While it named the missing component, it provided **no context on who requested it**. On a desktop running multiple applications and background daemons with dozens of windows, an application rendering `element('ui.FancyCard')` threw an error with zero attribution:
```
Error: Unknown component "ui.FancyCard". Known: Badge, Button, Card, Divider...
```
The developer or site owner had no way to know whether the error came from `notes`, `calc`, `workbench`, or background chrome.

### What Happens Now
1. `RenderOptions` gained an optional attribution field:
   ```ts
   export interface RenderOptions {
       readonly components: ComponentRegistry;
       readonly dispatch: Dispatcher;
       readonly part?: string;
   }
   ```
2. `mountShell` (`src/window/shell.ts`) and `start.ts` wire the owning process's `applicationId`:
   ```ts
   partOf: (owner) => kernel.processes.find((p) => p.pid === owner)?.applicationId,
   ```
3. When `mountView` calls `render()`, `part` is passed to the renderer options.
4. In `src/render/dom.ts`, when `definition === undefined`:
   ```ts
   const who = options.part !== undefined ? ` wanted by "${options.part}"` : '';
   throw new Error(
       `Unknown component "${node.component}"${who}. ` +
       `Known: ${options.components.names.join(', ') || '(none registered)'}.`,
   );
   ```
5. The resulting error clearly names both the component and the part:
   ```
   Error: Unknown component "ui.FancyCard" wanted by "notes". Known: Badge, Button, Card...
   ```
6. If `part` is not supplied (e.g. low-level renderer unit tests), it falls back cleanly to `Unknown component "${node.component}". Known: ...` with no empty clauses, ensuring 100% backward compatibility with existing tests.

---

## 5. What the `ui` Part Will Need That This Does Not Give It

While this dispatch makes an Extension providing components fully functional, building the actual `ui` part (in the next dispatch) will require several things outside this repository's scope:

1. **Stylesheet Precedence and `@layer` in `mesh-serve`**:
   The `ui` design system will ship CSS (via C8). However, `page.ts` in `mesh-serve` currently emits stylesheets in composition order, which is alphabetical by part id. Under that rule, `ui` would load after `calc`, causing the design system's default rules to override an application's custom overrides backwards. The `ui` stylesheet must declare `@layer ui.base, ui.components, app;` so precedence is governed by CSS layers rather than link tag ordering.
2. **The Focus Graph (spec/input.md §3)**:
   Complex composite widgets like `ui.Nav` or toolbars require arrow-key navigation within focus groups (moving left/right between items within the bar without jumping to arbitrary window contents). This capability requires the focus graph (A8.2 / A7.1), which is specified but not yet implemented in the kernel.
3. **Composite Components (Functions Returning Descriptions)**:
   As established in `spec/roadmap.md` A7.4, there are two kinds of components:
   - **Contributed Primitives** (this dispatch): components that teach the renderer how to build DOM elements (`ComponentDefinition`).
   - **Composite Widgets** (`Card`, `Toolbar`, `FormRow`): plain TypeScript functions that return `Node` descriptions composed of existing primitives. These require no kernel registration or manifest entries—they are ordinary code distributed as a library.
4. **Token Definitions & Fallback Variables**:
   The `ui` part will need concrete CSS definitions for the 13 theme tokens (`--page`, `--chrome`, `--surface`, `--surface-hover`, `--ink`, `--ink-dim`, `--edge`, `--accent`, `--on-accent`, `--info`, `--warn`, `--error`, `--shadow`) to ensure out-of-the-box styling when no custom theme extension is present.

---

## 6. Anything for the Reader Audit

### Reader Audit Resolution: `ComponentRegistry.register()`
- **File**: `src/render/component.ts:59-69`
- **Previous state**:
  `ComponentRegistry.register()` contained:
  ```ts
  if (existing !== undefined) {
      throw new Error(
          `Component "${definition.name}" is already registered. ` +
          `Two contributors claiming one name is a conflict to resolve at load time, ` +
          `not a last-one-wins.`,
      );
  }
  ```
  This error message anticipated multiple contributors, but had only one caller in the codebase (`window/page.ts` registering `WindowHost`), and the contribution layer had zero references to `components`. It was an unwired extension point.
- **Current state**:
  Closed. `Declarations.components` now allows Extensions and Applications to declare components. `mergeManifests` inspects all declared components and detects duplicate name claims at load time, recording conflicts in `manifest.conflicts` and warning in kernel logs. At boot, `start.ts:234` registers all contributed components into `ComponentRegistry`. The load-time resolution mechanism anticipated by the error message is now completely wired and verified.

---

## 7. Commits and Verification Log

### Commits in this Worktree
- `2c3c90b`: `feat(components): let an Extension provide components via manifest declarations`
  - Manifest field `components` in `Declarations`
  - Merge and conflict handling with prefix enforcement in `mergeManifests`
  - Route from `kernel.manifest.components` to `createComponents()` in `start.ts`
  - Part attribution in `RenderOptions` and `buildElement`
  - Unit tests in `test/component-contribution.test.ts`
  - Browser tests in `test/browser/component.browser.test.ts`
  - Spec updates in `spec/components.md` §2 and `spec/roadmap.md` A7.4a
  - Minor version bump to `0.15.0`

### Test Suite Execution
```
Unit Tests:
Test Files  21 passed (21)
     Tests  378 passed (378)
  Duration  5.87s

Browser Tests (Chromium via Vitest Browser):
Test Files  8 passed (8)
     Tests  49 passed (49)
  Duration  9.55s

Typecheck:
tsc -p tsconfig.check.json --noEmit: 0 errors
```
