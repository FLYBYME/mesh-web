# Composite components and encapsulated forms: the missing layer between an Application and the DOM

Written 2026-09-08.

**Status.** Proposed. The findings in §1 and §2 are measured from `mesh-core` today. The design in §3 and §4 resolves the gap between low-level `ComponentDefinition` and application bloat.

Companions: [Components and styling](./components.md) · [The view layer](./view-layer.md) · [Applications](./application.md) · [Schema-driven UI](./schema-driven-ui.md).

---

## 1. The problem, as observed

Two complaints that look separate and turn out to be the same missing layer:

> *"entityListComponent is too low level. entityListComponent should be built of primitives?"*

and:

> *"i want something that is like a login form. it includes the view and logic for the login form. all the logic right now lives in /home/ubuntu/code/mesh-core/src/fleet/index.ts files like"*

Between the Application process and the DOM renderer, the framework currently has **only two extremes**:

1. **The Application / View layer**: writes pure data description trees (`element('Stack')`, `element('ui.EntityList')`). It is strictly barred from touching DOM elements, `document`, or window events.
2. **The `ComponentDefinition` layer**: implements the vocabulary in the kernel registry (`create(): Element`, `apply(el, name, value)`, `slot(el)`). It must return a real browser `Element`.

Because there is no intermediate concept of a **Composite Component** (a component declared once, registered, but authored purely out of primitives), authors building reusable UI elements are forced into low-level HTML plumbing. And because there is no pattern for an **Encapsulated Form Unit**, application `start(cx)` methods are overwhelmed with form state boilerplate.

---

## 2. What exists today — measured

### A. Low-level HTML in `src/ui/views/entityList.ts` (211 lines)

`ui.EntityList` is not a browser primitive like a canvas or a native dialog. It is a sidebar container with a heading, an item list, and loading/error/empty presentation states. 

Yet, because it was registered as a `ComponentDefinition`, its implementation dropped all the way down to imperative DOM construction:

```ts
// src/ui/views/entityList.ts
export const entityListComponent: ComponentDefinition = {
    name: 'ui.EntityList',
    create(): Element {
        const el = document.createElement('aside');
        const header = document.createElement('div');
        const heading = document.createElement('h2');
        const titleSpan = document.createElement('span');
        const countSpan = document.createElement('span');
        ...
        el.appendChild(loading);
        el.appendChild(error);
        el.appendChild(items);
        return el;
    }
};
```

To coordinate updating titles, counts, and error text without re-rendering, `entityList.ts` relies on `WeakMap<Element, HTMLElement>`, manual DOM detachment (`header.remove()`), and CSS attribute toggles (`[data-status="loading"]`).

### B. Form signal sprawl in application `start(cx)`

In `src/fleet/index.ts` (503 lines), the provisioning card alone requires **11 signals and 7 commands** declared and implemented directly inside `FleetApp.start(cx)`:

```ts
// src/fleet/index.ts:86-98
const provisionHostname = cx.state.signal("");
const provisionName = cx.state.signal("");
const provisionRepository = cx.state.signal("");
const provisionRef = cx.state.signal("");
const provisionPath = cx.state.signal("");
const provisionDependsOn = cx.state.signal("");
const provisionMountKey = cx.state.signal("");
const provisionStatus = cx.state.signal<"idle" | "provisioning" | "success" | "error">("idle");
const provisionResult = cx.state.signal<NodeProvisionOutput | null>(null);
const provisionError = cx.state.signal<string | null>(null);
const provisionFieldErrors = cx.state.signal<Record<string, string>>({});
```

The same pattern repeats in `src/catalog/index.ts` (662 lines, 14 form signals across import and declaration editors) and `src/chrome/index.ts` (sign-in signals).

`start(cx)` becomes a dumping ground for transient form plumbing that no other part of the application cares about, and those signals must be drilled through function arguments into `views/fleet.ts`.

---

## 3. The distinction: Primitives vs. Compositions

[view-layer.md §3.1](./view-layer.md) originally drew this distinction, but the contribution layer only implemented half of it:

| | **Native Primitive (`ComponentDefinition`)** | **Composite Component (`CompositeDefinition`)** |
| :--- | :--- | :--- |
| **What it is** | A Monaco editor canvas, a native `<dialog>`, a virtualized scroller | An `EntityList`, an `ActionCard`, a `Navbar`, a `LoginForm` |
| **Why it touches the DOM** | It must access native layout, measurements, focus traps, or canvas contexts | **It does not need to touch the DOM at all** |
| **Authored with** | `document.createElement`, `apply()`, `slot()` | Description primitives: `Stack`, `Row`, `Text`, `when`, `each` |
| **Registration** | Registered in `ComponentRegistry` for late-binding | Registered in `ComponentRegistry` or exported as a typed function |
| **Typing** | Dynamic string tag (`element('ui.EntityList')`) | Typed function or checked component contract |

### The rule

> **A part only writes a `ComponentDefinition` if the component cannot be expressed using existing primitives.**
>
> If a component can be built from `Stack`, `Row`, `Text`, `Heading`, `ScrollView`, `when`, and `each`, writing `document.createElement` is a defect.

---

## 4. The two proposed abstractions

### A. Composite Components built of Primitives

A composite component produces a pure description tree. It can be authored as a plain TypeScript function or registered with the kernel:

```ts
export interface EntityListProps {
    readonly title?: string | (() => string);
    readonly count?: number | (() => number);
    readonly status?: EntityListStatus | (() => EntityListStatus);
    readonly errorMessage?: string | null | (() => string | null);
    readonly emptyMessage?: string | (() => string);
}

export function EntityList(props: EntityListProps, children: readonly Described[]): Described {
    return element('Stack', {
        props: {
            class: 'ui-entity-list',
            'data-status': props.status,
        },
        children: [
            when(
                () => Boolean(props.title),
                () => element('Row', {
                    props: { class: 'ui-entity-list-header' },
                    children: [
                        element('Heading', {
                            props: { level: 2, class: 'ui-entity-list-heading' },
                            children: [text(() => props.title ? String(props.title) : '')],
                        }),
                        when(
                            () => props.count !== undefined,
                            () => element('Span', {
                                props: { class: 'ui-entity-list-count' },
                                children: [text(() => `(${props.count})`)],
                            }),
                        ),
                    ],
                }),
            ),
            when(
                () => props.status?.() === 'loading',
                () => element('Text', {
                    props: { class: 'ui-entity-list-loading' },
                    children: [text('Loading…')],
                }),
            ),
            when(
                () => props.status?.() === 'error',
                () => element('Text', {
                    props: { class: 'ui-entity-list-error' },
                    children: [text(() => props.errorMessage?.() ?? 'Error loading items')],
                }),
            ),
            element('ScrollView', {
                props: { class: 'ui-entity-list-items' },
                children,
            }),
        ],
    });
}
```

**Benefits:**
1. Zero `document.createElement`, zero `WeakMap`, zero manual DOM syncing.
2. The renderer's fine-grained binding handles all reactivity automatically via `when()` and `text()`.
3. Fully testable without a DOM or browser.

---

### B. Encapsulated Form Units (e.g. `LoginForm`, `ProvisionForm`)

Instead of defining 10 loose signals and commands in `Application.start(cx)`, a form is packaged as a self-contained unit pairing **private state**, **submit logic**, and **view rendering**:

```ts
export interface FormUnit<TOutput> {
    readonly view: () => Described;
    readonly status: ReadonlySignal<'idle' | 'submitting' | 'success' | 'error'>;
    readonly error: ReadonlySignal<string | null>;
    submit(): Promise<TOutput | null>;
    reset(): void;
}
```

#### Example: `createLoginForm`

```ts
export interface LoginFormUnit {
    readonly view: () => Described;
    readonly email: Signal<string>;
    readonly password: Signal<string>;
    readonly error: Signal<string | null>;
    readonly submitting: Signal<boolean>;
    submit(): Promise<boolean>;
}

export function createLoginForm(
    cx: Context<any, any>,
    auth: AuthApi,
    onSuccess?: () => void,
): LoginFormUnit {
    // 1. Private State
    const email = cx.state.signal('');
    const password = cx.state.signal('');
    const error = cx.state.signal<string | null>(null);
    const submitting = cx.state.signal(false);

    // 2. Encapsulated Logic
    const submit = async (): Promise<boolean> => {
        if (submitting()) return false;
        const e = email().trim();
        const p = password();
        if (!e || !p) {
            error.set('Email and password are required.');
            return false;
        }

        submitting.set(true);
        error.set(null);
        try {
            await auth.signIn({ email: e, password: p });
            password.set(''); // forget sensitive data
            onSuccess?.();
            return true;
        } catch (err: any) {
            error.set(err?.message ?? 'Sign in failed');
            return false;
        } finally {
            submitting.set(false);
        }
    };

    // 3. View Function
    const view = (): Described => {
        return element('Form', {
            props: { class: 'login-form' },
            intents: { commit: { action: submit, preventDefault: true } },
            children: [
                when(
                    () => error() !== null,
                    () => element('Text', {
                        props: { class: 'form-error' },
                        children: [text(() => error() ?? '')],
                    }),
                ),
                element('TextInput', {
                    props: {
                        type: 'email',
                        placeholder: 'Email',
                        value: email,
                        disabled: submitting,
                    },
                }),
                element('TextInput', {
                    props: {
                        type: 'password',
                        placeholder: 'Password',
                        value: password,
                        disabled: submitting,
                    },
                }),
                element('Button', {
                    props: { type: 'submit', disabled: submitting },
                    children: [text(() => submitting() ? 'Signing in…' : 'Sign in')],
                }),
            ],
        });
    };

    return { email, password, error, submitting, submit, view };
}
```

---

## 5. Where logic lives: The four-tier contract

This cleanly partitions responsibility across the stack:

| Layer | Where it lives | What it owns | What it never touches |
| :--- | :--- | :--- | :--- |
| **1. Application Process** | `src/<app>/index.ts` | Process lifecycle, `cx.models` collections, routes, shared selection | Form field validation, transient input buffers, DOM nodes |
| **2. Form / Action Unit** | `src/<app>/forms/<form>.ts` | Form signals, field validation, submission handlers, dirty/busy states | Process management, global window layout, DOM nodes |
| **3. Composite Component** | `src/ui/views/<component>.ts` | Assembling layout primitives, slots, presentation states (`when`, `each`) | Direct DOM elements, `document.createElement`, business logic |
| **4. Native Primitive** | `src/render/component.ts` | Native elements (`<dialog>`, canvas, native input bindings) | Business state, application queries |

---

## 6. What this deletes from applications

Applying this pattern to `FleetApp` and `CatalogApp`:

1. **Deletes 50–120 lines of signal boilerplate from `start(cx)`**:
   An application instantiates `const provisionForm = createProvisionForm(cx, { onProvision: ... })` in a single line.
2. **Eliminates prop drilling to view files**:
   `views/fleet.ts` simply calls `provisionForm.view()` rather than accepting 11 separate signals as props.
3. **Replaces imperative DOM manipulation in `src/ui/` with pure descriptions**:
   `entityListComponent` shrinks from 211 lines of `document.createElement` to ~50 lines of composable TypeScript primitives.
