# Declarative Canvas: Design System Extension

> "A view produces descriptions, not pixels. A canvas primitive bridges data to draw commands without handing an Application a DOM handle."

**Status.** Proposed. Companion to [the view layer](./view-layer.md), [the roadmap](./roadmap.md) (A7.4 / A7.5), and [HTML5 capabilities](./html5.md).

---

## 1. The Conflict: Pure Descriptions vs Imperative Pixels

HTML5 `<canvas>` is inherently stateful and imperative:
```js
// ❌ Imperative canvas access — forbidden to Application views
const ctx = canvas.getContext('2d');
ctx.beginPath();
ctx.arc(50, 50, 20, 0, Math.PI * 2);
ctx.fillStyle = '#58a6ff';
ctx.fill();
```

Per [view-layer §1](./view-layer.md), **a view is a pure function from state to a description**. A view cannot:
- Hold an `HTMLCanvasElement` reference.
- Run an imperative `requestAnimationFrame` loop.
- Directly query `window.devicePixelRatio` or manage resize listeners.

While [view-layer §8](./view-layer.md) provides the raw `needs('dom')` + `Surface` escape hatch for heavy external engines (Monaco editor, Three.js), using that escape hatch for simple visualizations (charts, sparklines, gauges, progress rings) would force an application to opt out of isolation and declare DOM privileges it doesn't need.

The solution is a **Declarative Canvas Extension**.

---

## 2. Two Tiers of Declarative Canvas

Following [view-layer §3](./view-layer.md), canvas capabilities split into two distinct tiers:

### Tier 1: High-Level Visual Primitives (Domain Components)
The application declares *what* data to visualize, not how to render pixels:

```ts
element('Sparkline', {
    data: [12, 45, 28, 60, 42, 85],
    width: 140,
    height: 36,
    color: 'accent',
    fill: true,
})
```

```ts
element('DonutMeter', {
    value: 78,
    max: 100,
    size: 64,
    strokeWidth: 6,
    label: '78%',
})
```

The Application remains 100% declarative:
- The data is a plain array of numbers.
- No canvas handles are created or held.
- The description serializes cleanly over Web Worker boundaries or SSR.

### Tier 2: Scene-Graph Display Lists (Low-Level Vector Description)
For custom charts or diagrams where fixed domain components are insufficient, the extension provides a `Canvas` primitive accepting a declarative **display list**:

```ts
element('Canvas', {
    width: 320,
    height: 180,
    draw: [
        { kind: 'rect', x: 0, y: 0, width: 320, height: 180, fill: 'surface' },
        { kind: 'grid', step: 20, stroke: 'border' },
        { kind: 'path', points: [[0, 50], [80, 20], [160, 90], [240, 40]], stroke: 'accent', width: 2 },
        { kind: 'circle', cx: 240, cy: 40, r: 4, fill: 'accent' },
    ],
})
```

---

## 3. How the Extension Works

The canvas design system is an **Extension** contributing to the `ComponentRegistry`:

```
┌─────────────────────────────────────────────────────────────┐
│                      Application View                       │
│           returns description data (e.g. Sparkline)         │
└──────────────────────────────┬──────────────────────────────┘
                               │ description node
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                       Kernel Renderer                       │
│            ComponentRegistry.get('Sparkline')               │
└──────────────────────────────┬──────────────────────────────┘
                               │ apply(canvas, prop, value)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Canvas Extension Primitive                  │
│  - Handles devicePixelRatio (Retina scaling)                │
│  - Resolves CSS theme tokens (accent -> #58a6ff)            │
│  - Executes 2D drawing pass                                 │
│  - Maintains accessibility subtree                          │
└─────────────────────────────────────────────────────────────┘
```

### Component Definition Implementation

```ts
import type { ComponentDefinition } from '@flybyme/mesh-web';

export const SparklinePrimitive: ComponentDefinition = {
    name: 'Sparkline',

    create(): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.setAttribute('role', 'img');
        return canvas;
    },

    apply(el: Element, name: string, value: unknown): boolean {
        const canvas = el as HTMLCanvasElement;
        
        // Handle redraw on prop update
        if (name === 'data' && Array.isArray(value)) {
            renderSparkline(canvas, value as number[]);
            return true;
        }

        return false; // Fall through to default attribute handler
    },
};
```

---

## 4. Key Architectural Responsibilities

A declarative canvas primitive handles four responsibilities that Application views are prohibited from managing:

### 1. High-DPI / Retina Scaling
Raw `<canvas>` on a 2x display is blurry unless resized to physical device pixels and scaled by CSS. The extension handles this automatically:
```ts
const dpr = window.devicePixelRatio || 1;
canvas.width = cssWidth * dpr;
canvas.height = cssHeight * dpr;
canvas.style.width = `${cssWidth}px`;
canvas.style.height = `${cssHeight}px`;
ctx.scale(dpr, dpr);
```
The application specifies `width: 200, height: 100` in logical points and never cares about physical screen pixels.

### 2. Theme Token Resolution
Views declare colors as semantic tokens (`'accent'`, `'surface'`, `'danger'`). The canvas primitive reads the computed CSS variables from the container element:
```ts
const resolvedColor = getComputedStyle(canvas).getPropertyValue('--accent-color');
ctx.fillStyle = resolvedColor;
```
When the user or OS switches from dark to light mode, the canvas updates automatically without the Application invalidating its data state.

### 3. Accessibility & Semantics
A canvas element is an accessibility barrier unless fallback content is provided. The declarative primitive generates an accessible DOM subtree inside `<canvas>`:
```html
<canvas role="img" aria-label="Performance metric: 78%">
    <table>
        <caption>Historical trend data</caption>
        <tr><th>Index</th><th>Value</th></tr>
        <tr><td>0</td><td>12</td></tr>
        ...
    </table>
</canvas>
```

### 4. Interactive Hit Testing via Intents
When user interaction is required (e.g. hovering a data point on a line chart):
- The canvas primitive registers pointer listeners on the element.
- It maps the `(x, y)` coordinate to data indices.
- It dispatches a normalized Mesh **Intent** or **Command**:
  ```ts
  dispatcher.dispatch('chart.selectPoint', { index: 3, value: 60 });
  ```
The Application receives the typed intent without handling raw mouse events or canvas bounding rect math.

---

## 5. Worker Boundaries & `OffscreenCanvas`

Because declarative canvas primitives produce plain serializable descriptions:
- **Zero-DOM Worker Execution**: An Application process running in a Web Worker generates the description tree `{ name: 'Sparkline', props: { data: [...] } }`.
- **Main-Thread Render**: The main-thread renderer receives the description across `postMessage` and paints to the physical canvas.
- **Offscreen Transfer (Optional)**: For continuous animations or frame-heavy visualizations, the kernel can transfer an `OffscreenCanvas` to the worker, allowing direct rendering without blocking the UI compositor.

---

## 6. Specification Checklist

- [ ] **A7.4c Canvas Primitive Registration** — Register canvas-backed primitives (`Sparkline`, `Canvas`) into the site `ComponentRegistry`.
- [ ] **A7.4d CSS Theme Bridge** — Auto-resolve CSS color variables into canvas draw styles.
- [ ] **A7.4e HiDPI DPI Management** — Automatic `devicePixelRatio` buffer sizing and coordinate normalization.
- [ ] **A7.4f Canvas Intent Hit-Testing** — Map pointer interactions into declared command intents.
- [ ] **A7.4g Accessible Table Fallback** — Auto-render semantic data tables inside the canvas DOM subtree for screen readers.
