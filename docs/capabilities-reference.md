# Capabilities Reference

Capabilities define what a contribution may reach. A contribution requests capabilities via the [`needs(...)`](file:///home/ubuntu/code/mesh-web/src/contribution/capabilities.ts#L442) declaration. The capability broker creates an isolated context ([`createContext`](file:///home/ubuntu/code/mesh-web/src/kernel/broker.ts#L358)) containing strictly the requested capabilities.

```ts
export type CapabilityName = keyof CapabilityMap | 'mesh' | 'models';
```

---

## 1. `state` ([`State`](file:///home/ubuntu/code/mesh-web/src/contribution/capabilities.ts#L20))

Provides fine-grained reactive primitives bound to the contributor's lifecycle scope.

```ts
export interface State {
    signal<T>(initial: T): Signal<T>;
    computed<T>(fn: () => T): ReadonlySignal<T>;
    effect(fn: () => void | (() => void)): void;
}
```

- **Automatic Teardown**: Every signal, computed, and effect created via `cx.state` is attached to a reactive scope. When the Application process stops or the context is disposed, all effects and subscribers are automatically destroyed.
- **Computed Returns ReadonlySignal**: `computed` returns an observable `ReadonlySignal<T>`, allowing derived values to be passed cleanly to published contracts without exposing mutation methods.

---

## 2. `log` ([`Log`](file:///home/ubuntu/code/mesh-web/src/contribution/capabilities.ts#L43))

Structured, tagged logging into the central system log buffer.

```ts
export interface Log {
    debug(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
    error(message: string, error?: unknown): void;
}
```

- **Pre-Tagged Source**: Entries are automatically attributed to the calling part's ID or PID. Callers do not pass an arbitrary source string and cannot forge attribution.
- **Buffer Integration**: Writes into the kernel's bounded 1,000-entry log buffer viewable in the system log viewer (`ctrl+alt+q`).

---

## 3. `commands` ([`Commands`](file:///home/ubuntu/code/mesh-web/src/contribution/capabilities.ts#L59))

Registers implementations for declared palette/menu commands and invokes system commands.

```ts
export type CommandImpl = (...args: readonly Json[]) => void | Promise<void>;

export interface Commands {
    implement(id: string, run: CommandImpl): void;
    run(id: string, ...args: readonly Json[]): Promise<void>;
}
```

- **Strict Declaration Check**: An Application may only `implement()` commands that were declared in its own `commands` manifest. Implementing an undeclared command or a command declared by another part throws immediately.
- **Global Invocation**: `cx.commands.run(id, ...args)` can execute any command registered on the page, regardless of which part declared or implemented it.

---

## 4. `notifications` ([`Notifications`](file:///home/ubuntu/code/mesh-web/src/contribution/capabilities.ts#L78))

Displays reactive banner messages on the kernel's notification surface.

```ts
export interface NotificationHandle {
    update(message: string): void;
    dismiss(): void;
}

export interface Notifications {
    info(message: string): NotificationHandle;
    warn(message: string): NotificationHandle;
    error(message: string, error?: unknown): NotificationHandle;
}
```

- **Reactive Handles**: Methods return a `NotificationHandle` with `update(text)` and `dismiss()` methods.
- **No Dismissed Tombstones**: Dismissing a notification removes it from the live signal immediately. Historical records are preserved in the system logs.

---

## 5. `windows` ([`Windows`](file:///home/ubuntu/code/mesh-web/src/contribution/capabilities.ts#L128))

Allows an Application to manage its own windows.

```ts
export interface WindowHandle {
    readonly id: string;
    focus(): void;
    close(): void;
}

export interface Windows {
    open(options: { readonly view: string; readonly params?: Readonly<Record<string, Json>> }): WindowHandle;
    readonly own: () => readonly WindowHandle[];
}
```

- **Ownership Isolation**: `cx.windows.own()` returns only windows opened by this specific process instance.
- **No Direct Geometry Access**: An Application cannot call `move()`, `resize()`, or `maximize()`. Window placement and sizing are kernel concerns controlled by the window manager and page chrome.

---

## 6. `display` ([`Display`](file:///home/ubuntu/code/mesh-web/src/contribution/capabilities.ts#L115))

Observes the available viewport area in CSS pixels.

```ts
export interface Display {
    readonly size: ReadonlySignal<{ readonly width: number; readonly height: number }>;
}
```

- **Concrete Dimensions**: Exposes live `{ width, height }` dimensions rather than arbitrary `isMobile` booleans.
- **Reactive Layouts**: Components and chrome read `cx.display.size()` inside effects or computed getters to adapt layouts dynamically when the browser window or container box resizes.

---

## 7. `credentials` ([`Credentials`](file:///home/ubuntu/code/mesh-web/src/contribution/capabilities.ts#L230))

The singleton seam for attaching authentication tokens to outgoing API traffic.

```ts
export interface Credentials {
    readonly origin: string;
    attach(
        headers: () => Readonly<Record<string, string>>,
        session?: ReadonlySignal<Session | null>,
    ): void;
    clear(): void;
}
```

- **Single Owner**: Only one extension per page may call `attach()`. A second call by another part throws immediately, preventing credential interception.
- **Per-Request Header Resolution**: `headers` is a function invoked on every network request, ensuring refreshed tokens are transmitted without restarting applications.

---

## 8. `chrome` ([`Chrome`](file:///home/ubuntu/code/mesh-web/src/contribution/capabilities.ts#L182))

Allows shell extensions to inspect all open windows and draw desktop furniture.

```ts
export interface ChromeWindow {
    readonly id: string;
    readonly owner: string;
    readonly view: string;
    readonly title: string;
    readonly tile: string | undefined;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly closable: boolean;
}

export interface Chrome {
    windows(): readonly ChromeWindow[];
    focused(): string | undefined;
    mode(): WindowMode;
    host(): Node;
    focus(id: string): void;
    close(id: string): void;
    move(id: string, dx: number, dy: number): void;
    resize(id: string, edge: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw', dx: number, dy: number): void;
    setMode(mode: WindowMode): void;
}
```

- **Global Visibility**: Unlike `cx.windows`, `cx.chrome` sees all windows across all applications in order to render taskbars, dock strips, and window frames.
- **The Window Host Marker**: `cx.chrome.host()` returns the description node marking where window frames should be rendered.

---

## 9. `http` ([`Http`](file:///home/ubuntu/code/mesh-web/src/contribution/capabilities.ts#L305))

Generic network access to external endpoints outside the site's primary API gateway.

```ts
export interface HttpRequest {
    readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
}

export interface HttpResponse<T> {
    readonly ok: boolean;
    readonly status: number;
    readonly body: T | undefined;
}

export interface Http {
    request<T>(url: string, init?: HttpRequest): Promise<HttpResponse<T>>;
    get<T>(url: string, init?: Omit<HttpRequest, 'method' | 'body'>): Promise<HttpResponse<T>>;
    post<T>(url: string, body?: unknown, init?: Omit<HttpRequest, 'method' | 'body'>): Promise<HttpResponse<T>>;
}
```

- **Zero Credentials Attached**: `credentials: 'omit'` is enforced on all requests. Ambient cookies and cluster bearer tokens are never sent to external origins.
- **Non-Throwing Status Codes**: HTTP status codes (`401`, `404`, `500`) are returned inside `HttpResponse<T>` without throwing. Only network transport drops throw.

---

## 10. `storage` ([`Storage`](file:///home/ubuntu/code/mesh-web/src/storage/storage.ts#L28))

Scoped key-value persistence across browser reloads.

```ts
export interface Storage {
    store<T>(name: string, options?: StoreOptions<T>): BoundStore<T>;
}

export interface BoundStore<T> {
    get(key: string): Promise<T | undefined>;
    set(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
    clear(): Promise<void>;
}
```

- **Automatic Namespacing**: Keys are automatically prefixed with the declaring contributor ID, preventing cross-part storage collisions.
- **Hive Integration**: Stores can be backed by any configured hive (`system`, `user`, `device`, or `session`).

---

## 11. `dom` ([`Dom`](file:///home/ubuntu/code/mesh-web/src/contribution/capabilities.ts#L337))

Escape hatch for rendering raw HTML elements into the declarative view tree.

```ts
export interface SurfaceOptions {
    setup(el: HTMLElement): (() => void) | void;
    readonly key?: string | number;
    readonly style?: Reactive<Json>;
    readonly class?: Reactive<string>;
    readonly props?: Props;
}

export interface Dom {
    Surface(options: SurfaceOptions): Node;
    surface(options: SurfaceOptions): Node;
}
```

- **Auditable Seam**: Direct DOM manipulation is impossible without declaring `needs('dom')`.
- **Teardown Tracking**: Any cleanup function returned by `setup()` is invoked when the surface unmounts or the contributor's context is disposed.

---

## 12. `confirmation` ([`Confirmation`](file:///home/ubuntu/code/mesh-web/src/contribution/capabilities.ts#L398))

Asks the user a modal yes/no question before executing destructive operations.

```ts
export interface ConfirmOptions {
    readonly title?: string;
    readonly message: string;
    readonly confirmLabel?: string;
    readonly cancelLabel?: string;
    readonly destructive?: boolean;
    readonly requiresUser?: boolean;
    readonly actor?: IntentActor;
}

export interface Confirmation {
    ask(options: ConfirmOptions | string): Promise<boolean>;
}
```

- **Human Safety Guard**: When `requiresUser: true` is set, calls made by automated scripts or agents (`actor !== 'user'`) are immediately refused (`false`) without displaying a dialog.
- **Attribution Display**: The dialog displays `asked by <partName>`, preventing disguised confirmation prompts.

---

## 13. `mesh` ([`MeshClient<TApi>`](file:///home/ubuntu/code/mesh-web/src/net/client.ts#L86))

Typed RPC client communicating with the backend cluster API declared in `Declarations.api`.

```ts
// On Context when declaring needs('mesh') and api:
cx.mesh.call(action, input): Promise<Output>;
```

- **Static Type Inference**: Method names, input shapes, and return types are inferred directly from the declared API definition without runtime reflection.
- **Error Discrimination**: Throws [`MeshCallError`](file:///home/ubuntu/code/mesh-web/src/net/result.ts#L127) containing a typed, discriminated [`CallError`](file:///home/ubuntu/code/mesh-web/src/net/result.ts#L89) (`unauthorized`, `forbidden`, `not_found`, `invalid`, `conflict`, `stale`, `offline`, `server`, `declared`).
- **Staleness Protection**: Verifies backend `x-exposure-shape` headers against build hashes to detect API drift.

---

## 14. `models` ([`Models<TApi>`](file:///home/ubuntu/code/mesh-web/src/models/types.ts#L102))

Reactive, streaming CRUD collections over the backend API declared in `Declarations.api`.

```ts
// On Context when declaring needs('models') and api:
const posts = cx.models('post');

// Reactive signals for views:
posts.rows();     // readonly Post[]
posts.loading();  // boolean
posts.error();    // CallError | null
posts.empty();    // boolean
posts.status();   // 'idle' | 'loading' | 'ready' | 'empty' | 'error'

// Direct mutation operations (throw MeshCallError on failure):
await posts.create({ title: 'New Post' });
await posts.update({ id: '123', title: 'Updated' });
await posts.delete({ id: '123' });
```

- **Live Streaming**: Connects to the server's SSE `/events` stream and automatically updates collection rows on `<domain>.created`, `<domain>.updated`, and `<domain>.deleted` events.
- **Automatic Reconnection**: Re-fetches collections upon network reconnection to recover from missed events.
