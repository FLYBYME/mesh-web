# Dispatch 9 Report: Single Window Mode

## 1. Executive Summary

Dispatch 9 introduces the third window mode to `@flybyme/mesh-web`: **`'single'`** (completing `'windowed' | 'tiled' | 'single'`).

Until now, `@flybyme/mesh-web` supported desktop floating windows (`'windowed'`) and split-tree grid layouts (`'tiled'`). In both existing modes, the browser acts as a fixed app shell viewport where `#mesh-web-root` and `[data-mesh-window-host]` have fixed heights and hidden overflow, forcing scrolling inside individual window bodies (`.content`). While appropriate for dense desktop tools (editors, consoles, dashboards), this model breaks the fundamental semantics of normal websites, blogs, and reader views, where the document itself should flow and scroll naturally via the browser's native viewport (`document.scrollingElement`).

With `'single'` mode:
- **Zero Window Furniture**: No title bar, no drag handle/affordance, no resize grip, no border, no border radius, and no drop shadow.
- **Natural Document Flow**: The window manager stops absolute positioning and size clamping (`rectOf()` returns `undefined`). Inline position, coordinates (`top`, `left`, `width`, `height`), and z-index are cleared.
- **Native Document Scrolling**: Mode-scoped CSS in `kernel.css` ensures `#mesh-web-root`, `[data-mesh-window-host]`, `.window`, and `.content` do not constrain height or clip overflow. When content exceeds the viewport height, `document.scrollingElement` scrolls naturally.
- **Lossless Mode Transitions**: Mode switches never overwrite a window's saved geometry. Moving into and out of single mode preserves and restores previous geometry, DOM identity, and state without remounting.
- **Deployment Policy Enforcement**: The page-level `window-manager/mode` setting allows a deployment to lock single mode via build policy (`policy: { 'window-manager/mode': 'single' }`), refusing runtime writes and throwing `SettingLocked`.

### Verification Status
- **Typecheck**: `npm run typecheck` passes with **0 errors**.
- **Type Safety**: **Zero `as ...` type casts** introduced in new production code.
- **Unit Tests**: **345 / 345 tests passing** across 18 test files (including new unit test suites in `test/window.test.ts` and `test/persistence.test.ts`).
- **Browser Tests**: **39 / 39 tests passing** across 5 test files in a real Chromium instance via Playwright/Vitest (including the comprehensive suite in `test/browser/single.browser.test.ts`).
- **Build**: `npm run build` succeeds cleanly, compiling TypeScript and bundling `dist/kernel.css`.
- **Version**: Minor version bumped to **0.12.0** in `package.json` and `mesh.json`.
- **Specifications**: Updated `spec/roadmap.md` (item A2.4), `spec/application.md` §6 (three arrangements), and `spec/extension.md` §8.

---

## 2. The Three Core Architectural Decisions

### 2.1 Decision 1: Which Window is Shown in Single Mode?

**Decision**: The most recently focused, non-minimized window (`manager.focused()`, or the top-most non-minimized window from `manager.stacked()`). If all windows are minimized or no windows are open, no window is shown (`visible()` returns `[]`). All other windows are reported by `hidden()`.

#### Rationale:
In windowed mode, all non-minimized windows are visible and stacked. In tiled mode, visible windows are determined by which views occupy slots in the split tree. In single mode, the screen is dedicated to exactly one view at a time.
By tying visibility to focus and the stack order:
1. When an Application opens a new view, it receives focus and immediately becomes the single active view.
2. If the active window is minimized or closed, focus falls back to the next non-minimized window in the stack, which smoothly takes its place.
3. The remaining windows are **hidden (`host.hidden = true`), never disposed or unmounted**. This preserves their DOM state, form inputs, in-flight network connections, and scroll positions across focus shifts.

### 2.2 Decision 2: Per-Application vs. Per-Page Window Manager Mode

**Decision**: Window manager mode is a **page-level deployment policy** (`window-manager/mode`), which takes precedence over individual per-application preferences (`window-manager/mode/${application}`).

#### Rationale:
Whether a page behaves as an ordinary document flow (like a blog post or documentation page) or as a desktop workspace (like an IDE or multi-window console) is a deployment-level decision of the site itself, not an isolated preference of an individual application.
- If a site's build configuration or system policy pins `policy: { 'window-manager/mode': 'single' }`, the setting is locked. Any attempt by code, extensions, or user hotkeys to write to `window-manager/mode` throws `SettingLocked('window-manager/mode', ...)`.
- If no deployment policy pins the mode, the window manager checks the page setting in `device` hive, falling back to per-application preference or `'windowed'`.
- In `src/kernel/start.ts`, boot logic inspects `pageWindowMode` from settings resolution before mounting, ensuring the site renders in single mode on first frame without flickering or geometry jumps.

### 2.3 Decision 3: Behavior When a Second Application is Opened

**Decision**: Non-focused applications remain mounted in the DOM with `host.hidden = true` and are reported by `manager.hidden()`. Only the focused application's active window is visible.

#### Rationale:
Mesh's fundamental process model (`spec/application.md` §5) states that a background Application is **idle, not stopped**:
> *"It keeps its DOM, its scroll positions, its in-flight requests, its open SSE subscription and its half-typed form. Switching back is instant and lossless."*

In single mode:
1. When a second Application starts and opens a view, that view acquires focus and becomes the visible view.
2. The first Application's window has `hidden = true` set on its frame element. The DOM subtree remains attached inside the host.
3. When focus returns to the first Application (e.g. via app switching or programmatically), the first Application's window has `hidden = false` restored and the second Application's window is hidden.
4. Neither view was torn down or re-created, preserving user state completely.

---

## 3. Lossless Geometry & Document Flow

### 3.1 Unconstrained Geometry (`rectOf() === undefined`)
In `src/window/manager.ts`, `rectOf(id)` returns:
- `rect` from the window's record in `'windowed'` mode.
- `rect` computed from the split-tree layout in `'tiled'` mode.
- `undefined` in `'single'` mode.

When `rectOf(id)` returns `undefined`:
1. The shell (`src/window/shell.ts`) removes inline style assignments:
   - `host.style.position = ''` (clearing `position: absolute`)
   - `host.style.left = ''`
   - `host.style.top = ''`
   - `host.style.width = ''`
   - `host.style.height = ''`
   - `host.style.zIndex = ''`
2. Mutating geometry calls (`manager.move()`, `manager.resize()`, `manager.setViewport()`) are explicit no-ops in single mode and do not touch `record.rect`.
3. When transitioning back to `'windowed'` mode, `rectOf(id)` returns the intact `record.rect`. The shell restores `position: absolute` and re-applies exact coordinates.

### 3.2 Dynamic Frame Chrome Without Re-parenting
In `src/window/shell.ts`, `defaultFrame` manages `.titlebar` and `.grip`:
- When entering `single` mode: `bar.remove()` and `grip.remove()` detach the title bar and resize grip from the DOM.
- When exiting `single` mode: `root.prepend(bar)` and `root.append(grip)` reattach them.
- **The `.content` element is NEVER re-parented**. Re-parenting an element in the DOM resets internal scroll positions and recreates iframe/media contexts. By keeping `.content` attached to its parent window frame throughout mode transitions, all scroll state and input values survive intact.

---

## 4. Page/Document Scrolling Mechanics

### 4.1 CSS Scoping in `kernel.css`
In previous releases, viewport pinning was enforced globally on the root and host:
```css
#mesh-web-root {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 100%;
    overflow: hidden;
}

[data-mesh-window-host] {
    position: relative;
    width: 100%;
    height: 100%;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
}
```
In Dispatch 9, these properties are scoped to non-single modes:
```css
#mesh-web-root {
    position: relative;
    width: 100%;
    min-height: 100%;
}

#mesh-web-root:not([data-mesh-window-mode="single"]):not([data-window-mode="single"]) {
    height: 100%;
    overflow: hidden;
}

[data-mesh-window-host] {
    position: relative;
    width: 100%;
}

[data-mesh-window-host]:not([data-mesh-window-mode="single"]):not([data-window-mode="single"]) {
    height: 100%;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
}
```

For the window and its content:
```css
.window.single,
.window.single.focused {
    display: block;
    border: none;
    border-radius: 0;
    box-shadow: none;
    background: transparent;
    overflow: visible;
}

.window.single .titlebar,
.window.single .grip {
    display: none;
}

.window.single .content {
    overflow: visible;
    flex: none;
    min-height: 0;
}
```

### 4.2 Browser Verification
In `test/browser/single.browser.test.ts`, an Application renders 100 paragraphs (3000px height) in single mode:
1. `document.scrollingElement.scrollHeight` is measured at `> 2500px` (exceeding `window.innerHeight`).
2. `window.scrollTo(0, 350)` is executed via the real browser engine.
3. Assertions confirm:
   - `document.scrollingElement.scrollTop === 350`
   - `#mesh-web-root.scrollTop === 0`
   - `[data-mesh-window-host].scrollTop === 0`
   - `.window.scrollTop === 0`
   - `.content.scrollTop === 0`
This conclusively proves that page scrolling occurs at the document viewport level rather than inside an inner container.

---

## 5. Specification & Documentation Updates

1. **`spec/roadmap.md`**: Updated checklist item A2.4 to detail the three window modes (`windowed`, `tiled`, `single`), the behavior of `rectOf()`, and verified document scrolling.
2. **`spec/application.md` §6**: Added documentation of the third arrangement (`single` mode) alongside `windowed` and `tiled`.
3. **`spec/extension.md` §8**: Updated page chrome documentation explaining how a site with no chrome running in `single` mode produces a standard web document flow with zero window furniture.
4. **Version Bumps**: Bumped version to `0.12.0` in `package.json` and `mesh.json`.
