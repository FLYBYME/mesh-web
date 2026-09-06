# HTML5 & Web Platform Capabilities

> "The browser is an abstract operating system; HTML5 APIs are its ambient syscalls."

This document inventories HTML5 and modern Web Platform primitives, evaluating how each maps into Mesh's capability-driven architecture (`needs(...)`), extension model, or kernel services.

In standard web development, these APIs exist as ambient globals on `window` and `navigator`. In Mesh, ambient authority is rejected: platform capabilities must be declared, auditable, and isolated.

**Status.** Proposed inventory and capability roadmap.

---

## 1. Connectivity & Network

| Capability | Browser API | Mesh Architectural Mapping | Status |
| :--- | :--- | :--- | :--- |
| **Online / Offline** | `navigator.onLine`, `window.ononline`, `window.onoffline` | Site Extension or `needs('net')` state signal | `[ ]` |
| **Server-Sent Events** | `EventSource` | Kernel capability `needs('events')` via SSE bridge ([network §5](./network.md)) | `[ ]` |
| **WebSockets** | `WebSocket` | Part of mesh cluster transport / stream contracts ([network §5](./network.md)) | `[ ]` |
| **Fetch & Streams** | `fetch()`, `ReadableStream`, `AbortController` | Restricted capability `needs('http')` ([network §2a](./network.md)) | `[x]` |
| **WebRTC** | `RTCPeerConnection`, `RTCDataChannel` | Dedicated extension or transport capability | `[ ]` |
| **Beacon** | `navigator.sendBeacon` | Host lifecycle tear-down / telemetry hook | `[ ]` |

- [ ] **Connectivity Status** (`navigator.onLine`, `online`/`offline` events) — Expose reactive `Signal<boolean>` indicating device connectivity. Informs offline queueing and UI warning badges.
- [ ] **SSE Event Bridge** (`EventSource`) — Stream cluster events typed from the site exposure descriptor.
- [ ] **WebSockets** (`WebSocket`) — Full-duplex streams for interactive mesh contracts.
- [x] **HTTP Client** (`fetch`, `AbortController`) — Declared `needs('http')` with origin scoping; never carries bearer credentials automatically.
- [ ] **WebRTC Data Channels** — Peer-to-peer data transport for local/mesh clustering.
- [ ] **Beacon API** — Reliable last-gasp flush for diagnostics or audit logs on page unload.

---

## 2. Storage & Persistence

| Capability | Browser API | Mesh Architectural Mapping | Status |
| :--- | :--- | :--- | :--- |
| **Session Storage** | `sessionStorage` | Tab-scoped hive in `createSettingsRegistry` ([storage §2](./storage-and-registry.md)) | `[x]` |
| **Local Storage** | `localStorage` | Device hive in `createSettingsRegistry` ([storage §2](./storage-and-registry.md)) | `[x]` |
| **IndexedDB** | `indexedDB` | Backing engine for `needs('storage')` / offline mutation queue | `[ ]` |
| **Cache Storage** | `caches` | Service Worker asset & RPC cache layer ([hosting §3](./hosting.md)) | `[ ]` |
| **OPFS** | Origin Private File System | High-throughput virtual file system for heavy local state / SQLite | `[ ]` |

- [x] **Tab & Device Key-Value Storage** (`sessionStorage`, `localStorage`) — Integrated into the settings registry hives (`session`, `device`).
- [ ] **IndexedDB Scoped Storage** — Asynchronous key-value and object persistence for applications (`needs('storage')`).
- [ ] **Cache Storage API** — Cache contract responses and static bundle assets.
- [ ] **Origin Private File System (OPFS)** — Sandboxed private filesystem for data-intensive applications (e.g. embedded SQLite/Wasm).

---

## 3. Concurrency & Background Execution

| Capability | Browser API | Mesh Architectural Mapping | Status |
| :--- | :--- | :--- | :--- |
| **Web Workers** | `new Worker()` | Worker-isolated headless Application processes ([application §1](./application.md)) | `[ ]` |
| **Shared Workers** | `new SharedWorker()` | Cross-tab kernel coordinator / cluster proxy | `[ ]` |
| **Service Workers** | `navigator.serviceWorker` | CDN fallback, offline shell caching, push notifications | `[ ]` |

- [ ] **Worker-isolated Applications** — Run Application logic in a Web Worker, emitting description trees and receiving intent IDs across `postMessage`.
- [ ] **Shared Worker Coordinator** — Single connection manager shared across tabs on the same origin.
- [ ] **Service Worker PWA / Offline Shell** — Intercept requests when completely disconnected and serve cached kernel bundles.

---

## 4. Hardware, Inputs & Sensors

| Capability | Browser API | Mesh Architectural Mapping | Status |
| :--- | :--- | :--- | :--- |
| **Gamepad API** | `navigator.getGamepads()` | Polled input driver in the input system ([input §9](./input.md)) | `[ ]` |
| **Keyboard & Shortcuts**| `KeyboardEvent`, `navigator.keyboard` | Normalized data bindings via `keys.ts` ([input §2](./input.md)) | `[x]` |
| **Pointer / Touch** | Pointer Events, Touch Events | Normalized gesture and pointer intents ([input §4](./input.md)) | `[ ]` |
| **Geolocation** | `navigator.geolocation` | Privileged capability `needs('geolocation')` | `[ ]` |
| **Screen Wake Lock** | `navigator.wakeLock` | Capability `needs('display')` for presentation / monitor apps | `[ ]` |
| **Device Orientation**| `DeviceOrientationEvent` | Sensor capability for motion/orientation | `[ ]` |
| **WebHID / WebUSB** | `navigator.hid`, `navigator.usb` | Hardware driver extensions | `[ ]` |

- [x] **Normalized Keyboard Input** — Central key normalizer and static manifest bindings (`keys.ts`).
- [ ] **Gamepad Adapter** — Kernel-polled gamepad loop mapping controller inputs to declared command intents.
- [ ] **Touch & Pen Gestures** — Device-agnostic intent dispatching for touchscreens and drawing tablets.
- [ ] **Geolocation Capability** — Declared, audited capability for location services with explicit permission prompts.
- [ ] **Screen Wake Lock** — Prevent display dimming in process monitor and dashboard views.

---

## 5. OS Integration & User Experience

| Capability | Browser API | Mesh Architectural Mapping | Status |
| :--- | :--- | :--- | :--- |
| **History API** | `history.pushState`, `popstate` | URL router mapping URLs to view types ([application §9](./application.md)) | `[ ]` |
| **Desktop Notifications**| `Notification` | System notifications capability `needs('notifications')` | `[x]` |
| **Clipboard** | `navigator.clipboard` | Clipboard capability `needs('clipboard')` | `[ ]` |
| **Drag and Drop** | HTML5 DnD (`dragstart`, `drop`) | Window docking, tile splitting, and external file drops | `[ ]` |
| **Fullscreen** | `element.requestFullscreen()` | Window manager maximised / fullscreen mode | `[ ]` |
| **Web Share** | `navigator.share` | Command integration for native OS sharing sheets | `[ ]` |

- [ ] **URL Router** (`history.pushState`) — Bidirectional URL-to-view mapping with prefix transparency and focus tracking.
- [x] **System Notifications** (`Notification`) — Declared `needs('notifications')` for non-intrusive status and alert updates.
- [ ] **Async Clipboard Access** — Secure copy/paste capability for views and commands.
- [ ] **Drag & Drop Integration** — Window tiling splits, pane re-ordering, and file uploads.
- [ ] **Web Share Sheet** — Native OS sharing dialogs invoked from application commands.

---

## 6. Graphics, Audio & Media

| Capability | Browser API | Mesh Architectural Mapping | Status |
| :--- | :--- | :--- | :--- |
| **Canvas 2D** | `<canvas>`, `CanvasRenderingContext2D`| Surface primitive or [Declarative Canvas](./declarative-canvas.md) | `[ ]` |
| **WebGL / WebGPU** | `WebGL2RenderingContext`, `GPUAdapter` | High-performance graphical and compute surfaces | `[ ]` |
| **Web Audio API** | `AudioContext`, `AudioNode` | Audio synthesizer or notification sound extension | `[ ]` |
| **Media Streams** | `navigator.mediaDevices.getUserMedia` | Camera / microphone input capability | `[ ]` |
| **Screen Capture** | `navigator.mediaDevices.getDisplayMedia` | Screen sharing capability | `[ ]` |
| **Audio / Video** | `<audio>`, `<video>` elements | Media playback primitives | `[ ]` |

- [ ] **Canvas Primitive & Design System** — [Declarative Canvas Extension](./declarative-canvas.md) providing high-level visual primitives (`Sparkline`, `DonutMeter`) and scene graph display lists.
- [ ] **WebGL / WebGPU Context** — Accelerated 3D canvas surface for simulations or visualizations.
- [ ] **Web Audio Manager** — System audio cues and accessible alerts without DOM audio elements.
- [ ] **Media Capture** — Microphone and camera streams gated behind declared capability.
- [ ] **Screen Recording / Capture** — Operator console screen sharing and diagnostics.

---

## 7. DOM & Document Primitives

| Capability | Browser API | Mesh Architectural Mapping | Status |
| :--- | :--- | :--- | :--- |
| **Import Maps** | `<script type="importmap">` | Single-kernel module graph resolution ([hosting §1](./hosting.md))| `[x]` |
| **Custom Elements** | `customElements.define` | Optional host integration layer | `[ ]` |
| **Dialog Element** | `<dialog>` | Native modal and popover surfaces | `[x]` |
| **ResizeObserver** | `ResizeObserver` | WindowManager viewport tracking and responsive tiles | `[x]` |
| **IntersectionObserver**| `IntersectionObserver` | Virtual list scrolling and lazy view hydration | `[ ]` |

- [x] **Browser-Native Import Maps** — Ensure single kernel singleton across all extensions and applications.
- [x] **Resize Observer** — Reactive viewport and tile pane dimension updates.
- [x] **Native Dialog & Popover** — Accessible modal overlays without z-index conflicts.
- [ ] **Intersection Observer** — Keyed list virtual scrolling (`each`) for massive collections.
