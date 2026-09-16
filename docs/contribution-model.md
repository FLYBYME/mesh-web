# Contribution Model

All modular functionality in `@flybyme/mesh-web` is implemented as **Contributions**. The framework defines two distinct contribution contracts:
- **`Extension`**: A singleton system service that activates once and provides shared capabilities or page chrome.
- **`Application`**: A runnable user process that can have multiple running instances, own private state, open windows, and render views.

Both contracts implement [`Declarations`](file:///home/ubuntu/code/mesh-web/src/contribution/contract.ts#L247).

---

## The `Declarations` Manifest

The kernel inspects what a contribution declares before any code runs or activates. This allows tools, reviews, and page generators to understand a part's dependencies, shortcuts, and APIs statically:

```ts
export interface Declarations {
    /** Capabilities this contribution requires (e.g. 'state', 'mesh', 'windows'). */
    readonly needs?: readonly CapabilityName[];
    /** Provider tokens this contribution consumes from Extensions. */
    readonly consumes?: ProviderTokens;
    /** Provider token this contribution publishes for others to consume. */
    readonly provides?: ProviderToken<unknown> | undefined;
    /** 'required' means unusable without sign-in; 'optional' means can run signed out. */
    readonly session?: 'required' | 'optional';
    /** Inward cluster API definition this contribution communicates with. */
    readonly api?: Api<Record<string, AnyApiCall>>;
    /** Tiled split-tree layout for this application's views. */
    readonly layout?: LayoutNode;
    /** Palette commands declared by this part. */
    readonly commands?: readonly CommandDecl[];
    /** Keyboard/gamepad/gesture bindings for declared commands. */
    readonly keys?: readonly KeyDecl[];
    /** Menu placements ('menubar' | 'window' | 'status' | `context:${string}`). */
    readonly menus?: readonly MenuDecl[];
    /** Registry setting keys with hives, defaults, and schemas. */
    readonly settings?: readonly SettingDecl[];
    /** Storage store declarations. */
    readonly stores?: readonly StoreDecl[];
    /** Custom components contributed to the shared vocabulary. */
    readonly components?: readonly ComponentDefinition[];
    /** Views declared by an Application. */
    readonly views?: readonly ViewDecl<never, never, never>[];
    /** Outward surface offered to other parts and tool callers. */
    readonly publishes?: ApiDecl;
}
```

---

## Anatomy of an Extension

An [`Extension`](file:///home/ubuntu/code/mesh-web/src/contribution/contract.ts#L395) is a singleton infrastructure service. It activates once during boot step 7 and is **never deactivated** while the page is running:

```ts
import { Extension, Context, provider, consumes, needs } from '@flybyme/mesh-web';

export interface ThemeApi {
    readonly mode: Signal<'dark' | 'light'>;
    toggle(): void;
}

export const THEME = provider<ThemeApi>('theme');

export default class ThemeExtension implements Extension<['state'], [], typeof THEME> {
    readonly needs = needs('state');
    readonly provides = THEME;

    activate(cx: Context<['state'], [], typeof THEME>): ThemeApi {
        const mode = cx.state.signal<'dark' | 'light'>('dark');
        return {
            mode,
            toggle() {
                mode.set(mode() === 'dark' ? 'light' : 'dark');
            },
        };
    }
}
```

---

## Anatomy of an Application

An [`Application`](file:///home/ubuntu/code/mesh-web/src/contribution/contract.ts#L416) is a process that can be started, stopped, or restarted. It returns an [`ApplicationInstance`](file:///home/ubuntu/code/mesh-web/src/contribution/contract.ts#L336) containing its public API and its private internal state:

```ts
import { 
    Application, Context, ViewContext, ViewDecl, 
    needs, element, text 
} from '@flybyme/mesh-web';

interface CounterInternal {
    readonly count: Signal<number>;
}

export default class CounterApp implements Application<['state', 'windows'], [], undefined, any, CounterInternal> {
    readonly needs = needs('state', 'windows');

    readonly views: readonly ViewDecl<Record<string, never>, CounterInternal>[] = [{
        id: 'main',
        title: 'Counter',
        window: {
            defaultSize: { width: 300, height: 200 },
            closable: true,
        },
        render(vx: ViewContext<Record<string, never>, CounterInternal>) {
            return element('Stack', {
                children: [
                    text(() => `Count: ${vx.internal.count()}`),
                    element('Button', {
                        props: { title: 'Increment' },
                        intents: {
                            activate: { action: vx.on(() => vx.internal.count.update(n => n + 1)) }
                        },
                        children: [text('+1')]
                    })
                ]
            });
        }
    }];

    async start(cx: Context<['state', 'windows']>): Promise<ApplicationInstance<void, CounterInternal>> {
        const count = cx.state.signal(0);
        return {
            internal: { count }
        };
    }

    async stop(): Promise<void> {
        // Optional process cleanup
    }
}
```

---

## Public vs. Internal State: Eliminating Over-Publication

A core security innovation in `@flybyme/mesh-web` is the strict separation between what a part publishes and what it keeps private:

```ts
export interface ApplicationInstance<TPublic = unknown, TInternal = unknown> {
    readonly api?: TPublic;
    readonly internal: TInternal;
}
```

### The Three Slots of `ViewContext`
When a view's `render(vx)` function executes, [`ViewContext`](file:///home/ubuntu/code/mesh-web/src/contribution/contract.ts#L112) provides three distinct data slots:

1. **`vx.params`** (*Input*): Serializable URL parameters or invocation arguments.
2. **`vx.internal`** (*State*): The part's own private state returned from `start()`. **Views should almost always read `internal`**.
3. **`vx.app`** (*Output*): The part's public `api`. Only read when rendering a component that reflects a publicly published contract.

```mermaid
flowchart LR
    subgraph PartRuntime ["Application Process"]
        Start["start(cx)"] --> Out["ApplicationInstance"]
        Out --> Pub["api (Public Surface)"]
        Out --> Priv["internal (Private State)"]
    end

    subgraph ViewScope ["View Rendering (render(vx))"]
        vxP["vx.params (Route / Args)"]
        vxI["vx.internal (Private State)"]
        vxA["vx.app (Public API)"]
    end

    subgraph OutsideWorld ["Outside Consumers & Tools"]
        Tool["External Parts / Tool Callers"]
    end

    Priv --> vxI
    Pub --> vxA
    Pub --> Tool
    Priv -.x|Blocked| Tool
```

### Parts That Keep No State: `KEEPS_NOTHING`
If a part holds no private internal state, it returns [`KEEPS_NOTHING`](file:///home/ubuntu/code/mesh-web/src/contribution/contract.ts#L375):

```ts
import { KEEPS_NOTHING } from '@flybyme/mesh-web';

// A part that publishes an API but holds no internal state:
return { ...KEEPS_NOTHING, api: myPublicApi };

// A part that holds nothing and publishes nothing:
return KEEPS_NOTHING;
```

---

## Published APIs & Static Verification (`checkBindings`)

When an Application publishes functionality for other parts or AI tool callers, it declares its contracts statically on `publishes` ([`ApiDecl`](file:///home/ubuntu/code/mesh-web/src/contribution/api.ts#L232)):

```ts
export interface PartApi {
    readonly commands: Readonly<Record<string, AnyBoundCommand>>;
    readonly components: Readonly<Record<string, AnyBoundComponent>>;
    readonly state: Readonly<Record<string, ReadonlySignal<unknown>>>;
}
```

### Foundational Design Rule: Read is a Value. Write is a Command.
- **`state` is always `ReadonlySignal<T>`**: Other parts and tool callers may observe values, but can **never** mutate a published signal directly.
- **Mutations require `commands`**: All state modifications must be executed through explicit, callable commands ([`BoundCommand`](file:///home/ubuntu/code/mesh-web/src/contribution/api.ts#L152)).

### Static vs. Runtime Verification ([`checkBindings`](file:///home/ubuntu/code/mesh-web/src/contribution/api.ts#L254))
When `kernel.start(appId)` runs, it invokes `checkBindings`:
1. Every command, component, and state key declared in `publishes` **must be present** in the returned `instance.api`. An unimplemented declaration is rejected as false advertising.
2. Every command, component, and state key present in `instance.api` **must have been declared** in `publishes`. An undeclared runtime binding is rejected because it cannot be statically reviewed or audited.

---

## Provider Tokens & The `AUTH` Seam

### Decoupled Interfaces via `ProviderToken<T>`
[`ProviderToken<T>`](file:///home/ubuntu/code/mesh-web/src/contribution/provider.ts#L15) allows two parts to share a typed contract without importing each other:

```ts
export function provider<T>(id: string): ProviderToken<T>;
export function consumes<const T extends ProviderTokens>(...tokens: T): T;
```

A consumer imports only the token and interface from a shared contract module. The provider implementation is resolved dynamically at runtime by the kernel.

### The `AUTH` Seam ([`src/contribution/session.ts`](file:///home/ubuntu/code/mesh-web/src/contribution/session.ts))
Authentication is **not implemented by the kernel**, but the kernel defines the standard seam:

```ts
export interface Session {
    readonly userId: string;
    readonly displayName: string;
    readonly roles: readonly string[];
    readonly expiresAt: number;
}

export interface AuthApi {
    readonly session: Signal<Session | null>;
    signIn(credentials: Credentialed): Promise<Session>;
    signOut(): Promise<void>;
}

export const AUTH: ProviderToken<AuthApi> = provider<AuthApi>('mesh-web/auth');
```

- An auth extension in `mesh-core` implements `AuthApi`, declares `needs('credentials')`, and calls `cx.credentials.attach()`.
- Applications declare `needs('mesh')` without knowing who provides auth. Outgoing calls automatically receive bearer tickets through the credential seam.
