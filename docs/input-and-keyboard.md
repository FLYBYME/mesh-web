# Input & Keyboard

The input subsystem ([`src/input/`](file:///home/ubuntu/code/mesh-web/src/input/)) provides normalized hotkey parsing, gamepad button mapping, focus containment traps, and default window navigation bindings.

---

## 1. Hotkey Normalization ([`src/input/keys.ts`](file:///home/ubuntu/code/mesh-web/src/input/keys.ts))

To eliminate subtle bugs where hotkey comparisons fail due to casing or modifier order, `@flybyme/mesh-web` parses all hotkeys into an internal normal form:

```ts
export interface Chord {
    readonly key: string;      // Lowercased base key: 'p', 'escape', 'arrowleft'
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
    readonly meta: boolean;     // Command on macOS, Windows key on PC
}
```

### Canonical Normal Form ([`normalizeBinding`](file:///home/ubuntu/code/mesh-web/src/input/keys.ts#L141))
Modifier order and letter casing are unified:
- `'Shift+Ctrl+P'` $\to$ `'ctrl+shift+p'`
- `'Option+Cmd+Down'` $\to$ `'alt+meta+arrowdown'`
- `'escape'` $\to$ `'escape'`

Two declarations written differently collide at load time rather than failing silently at runtime.

### Key and Modifier Aliases
- **Key Aliases**: `esc` $\to$ `escape`, `return` $\to$ `enter`, `del` $\to$ `delete`, `space`/`spacebar` $\to$ `' '`, `up`/`down`/`left`/`right` $\to$ `arrowup`/`arrowdown`/`arrowleft`/`arrowright`.
- **Modifier Aliases**: `control` $\to$ `ctrl`, `option` $\to$ `alt`, `cmd`/`command`/`win`/`super` $\to$ `meta`.

---

## 2. Browser Reserved Shortcuts ([`BROWSER_TAB_RESERVED`](file:///home/ubuntu/code/mesh-web/src/input/keys.ts#L191))

Certain keystrokes belong to the host browser tab and cannot be safely intercepted:
- `ctrl+w` / `ctrl+shift+w` (Close tab / window)
- `ctrl+t` / `ctrl+shift+t` (New tab / reopen tab)
- `ctrl+n` / `ctrl+shift+n` (New window / incognito)
- `ctrl+r` / `ctrl+shift+r` (Reload)
- `ctrl+q` (Quit browser)

When an Application declares a binding claimed by `BROWSER_TAB_RESERVED`, the manifest merger rejects it at boot time with an explicit collision warning:
```
catalog bound "ctrl+n" to "catalog.new", and the host takes that binding first —
preventDefault on it is ignored. Bind something else.
```

---

## 3. Built-in Window Commands

The kernel registers built-in window commands under the `window.*` namespace ([`src/kernel/start.ts`](file:///home/ubuntu/code/mesh-web/src/kernel/start.ts#L737)):

| Hotkey | Command ID | Action |
|---|---|---|
| `alt+w` | `window.close` | Closes the currently focused window. |
| `alt+m` | `window.maximize` | Toggles maximized state for the focused window. |
| `alt+n` | `window.minimize` | Minimizes the focused window. |
| `alt+\`` | `window.cycle` | Cycles focus to the next open window (back to front). |
| `alt+t` | `window.mode` | Toggles between `windowed` and `tiled` layout modes. |
| `ctrl+alt+q` | `kernel.logs` | Toggles the fullscreen system log viewer. |

> [!NOTE]
> Hotkeys are configured with `alt` modifiers rather than `ctrl` to avoid colliding with native browser tab navigation chords.

---

## 4. Text Field Keystroke Protection

Global shortcuts must never eat keystrokes typed by a user into an input field. When a `keydown` event fires, the keyboard listener ([`src/kernel/start.ts`](file:///home/ubuntu/code/mesh-web/src/kernel/start.ts#L807)) checks the event target:

```ts
const target = event.target;
if (target instanceof HTMLElement
    && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) {
    // Plain keystrokes (like 'w', 'm', Space) are passed through to the text field.
    // Chords with modifiers (Ctrl, Meta, Alt) continue to match shortcuts.
    if (!event.ctrlKey && !event.metaKey && !event.altKey) return;
}
```

---

## 5. Focus Containment Traps ([`src/input/trap.ts`](file:///home/ubuntu/code/mesh-web/src/input/trap.ts))

Modal dialogs and confirmation boxes require keyboard focus to remain trapped within the active dialog:

```ts
import { createFocusTrap } from '@flybyme/mesh-web';

const trap = createFocusTrap(dialogElement, {
    initialFocus: '#first-input',
    returnFocusOnDeactivate: true,
    escapeDeactivates: true,
});

trap.activate();

// Later, on close:
trap.deactivate();
```

- When the user presses `Tab` on the last focusable element, focus wraps back to the first focusable element.
- When the user presses `Shift+Tab` on the first element, focus wraps to the last focusable element.
- Deactivating the trap restores focus to the opener element that triggered the modal.
