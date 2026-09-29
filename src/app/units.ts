/**
 * The four units an author extends: `Service`, `View`, `Component`, `App` (docs/app-model.md).
 *
 * Each is a function from a spec to a base class, because a class cannot name its own statics in
 * its `extends` clause — `class A extends View<typeof A>` is a circularity error. Passing the spec
 * in instead gives the subclass a fully typed `this.cx`, `this.inject` and `this.params`/`this.props`,
 * and leaves the spec readable as a static (`RecordsView.spec`) without constructing anything.
 *
 * Nobody but the kernel constructs these. The constructor takes what the kernel built — a `cx` with
 * exactly the declared capabilities, the injected services, the parsed params or the props — and
 * subclass field initializers run after it, so `readonly x = this.cx.models.collection(...)` works
 * (`useDefineForClassFields` is on).
 */

import type { Action, IntentValue, Node } from '../description/types.js';
import type {
    ApiOfSpec, Capabilities, CheckNeeds, CheckRoutes, ComponentClass, Injectables, Injected, InjectOf,
    MountArgs, NeedsOf, ParamsOf, PropsDecl, PropsOf, SchemaLike, ServiceClass, UnitHost, UnitSpec,
    ViewClass,
} from './types.js';

// ---------------------------------------------------------------------------- what the kernel passes

export interface ServiceInit<S> {
    readonly cx: Capabilities<NeedsOf<S>, ApiOfSpec<S>>;
    readonly inject: Injected<InjectOf<S>>;
}

export interface ViewInit<S> extends ServiceInit<S> {
    readonly params: ParamsOf<S>;
    readonly host: UnitHost;
}

export interface ComponentInit<S> extends ServiceInit<S> {
    readonly props: PropsOf<S>;
    readonly host: UnitHost;
}

/**
 * The host is kept off the instance. `on` and `mount` are the public face of it; the table behind
 * them is the kernel's, and a field would put it one `this.` away from every author.
 */
const hosts = new WeakMap<object, UnitHost>();

function hostOf(unit: object): UnitHost {
    const host = hosts.get(unit);
    if (host === undefined) {
        throw new Error('This view or component was not constructed by the kernel, so it has nowhere to mount or register.');
    }
    return host;
}

// ---------------------------------------------------------------------------- specs

export type ServiceSpec = UnitSpec;

export interface ViewSpec extends UnitSpec {
    /** Parsed from the URL — path params and query — before the view is constructed. */
    readonly params?: SchemaLike<object>;
    readonly title?: string;
}

export interface ComponentSpec extends UnitSpec {
    readonly props?: PropsDecl<unknown>;
}

export interface AppSpec extends UnitSpec {
    readonly routes: { readonly [path: string]: ViewClass };
    /** Constructed at boot. Any other service is constructed on first injection. */
    readonly services?: readonly ServiceClass[];
}

// ---------------------------------------------------------------------------- Service

/** One instance per page, shared by every unit that injects it. */
export function Service<const S extends ServiceSpec>(spec: S) {
    class ServiceBase {
        static readonly kind = 'service';
        static readonly spec: S = spec;

        readonly cx: Capabilities<NeedsOf<S>, ApiOfSpec<S>>;
        readonly inject: Injected<InjectOf<S>>;

        constructor(init: ServiceInit<S>) {
            this.cx = init.cx;
            this.inject = init.inject;
        }
    }
    return ServiceBase;
}

// ---------------------------------------------------------------------------- View

/**
 * **Named, at module level, and not a class expression inside `View()` — and that is load-bearing.**
 *
 * A class expression returned from a function is written into the `.d.ts` as an object type, and
 * `abstract render()` comes out as a plain `render(): Node`. A consumer — who only ever sees the
 * `.d.ts` — could then declare a view with no `render` at all and get no error: a view that mounts
 * and draws nothing, silently. Found by compiling a probe against the emitted declarations; the
 * source-level type tests could not see it. A named abstract class keeps `abstract` in the `.d.ts`.
 */
export abstract class ViewBase<S extends ViewSpec> {
    readonly cx: Capabilities<NeedsOf<S>, ApiOfSpec<S>>;
    readonly inject: Injected<InjectOf<S>>;
    readonly params: ParamsOf<S>;

    constructor(init: ViewInit<S>) {
        this.cx = init.cx;
        this.inject = init.inject;
        this.params = init.params;
        hosts.set(this, init.host);
    }

    abstract render(): Node;

    /** Register a closure for an intent. Removed when this instance is disposed. */
    on(fn: (value?: IntentValue) => void): Action {
        return hostOf(this).on(fn);
    }

    /** Mount a component here. It may need only capabilities this view has. */
    mount<C extends ComponentClass>(component: C & CheckNeeds<C, NeedsOf<S>>, ...args: MountArgs<C>): Node {
        return hostOf(this).mount(component, args[0]);
    }
}

/** What a route mounts. Its state is its own: two windows on one route are two instances. */
export function View<const S extends ViewSpec>(spec: S): typeof ViewBase<S> & { readonly kind: 'view'; readonly spec: S } {
    abstract class WithSpec extends ViewBase<S> {
        static readonly kind = 'view';
        static readonly spec: S = spec;
    }
    return WithSpec;
}

// ---------------------------------------------------------------------------- Component

/** Named at module level for the same reason as `ViewBase`. */
export abstract class ComponentBase<S extends ComponentSpec> {
    readonly cx: Capabilities<NeedsOf<S>, ApiOfSpec<S>>;
    readonly inject: Injected<InjectOf<S>>;
    readonly props: PropsOf<S>;

    constructor(init: ComponentInit<S>) {
        this.cx = init.cx;
        this.inject = init.inject;
        this.props = init.props;
        hosts.set(this, init.host);
    }

    abstract render(): Node;

    on(fn: (value?: IntentValue) => void): Action {
        return hostOf(this).on(fn);
    }

    /** Capabilities only narrow going down: a child may need at most what this component has. */
    mount<C extends ComponentClass>(component: C & CheckNeeds<C, NeedsOf<S>>, ...args: MountArgs<C>): Node {
        return hostOf(this).mount(component, args[0]);
    }
}

/** Reusable, with its own state; constructed per mount, disposed when its node leaves. */
export function Component<const S extends ComponentSpec>(spec: S): typeof ComponentBase<S> & { readonly kind: 'component'; readonly spec: S } {
    abstract class WithSpec extends ComponentBase<S> {
        static readonly kind = 'component';
        static readonly spec: S = spec;
    }
    return WithSpec;
}

// ---------------------------------------------------------------------------- App

/**
 * Routes, boot-time services, and anything app-wide. The spec is checked route by route: every
 * `:param` in a path must be in its view's `params`, and every view may need only what the app has.
 */
export function App<const S extends AppSpec>(spec: S & { readonly routes: CheckRoutes<S['routes'], NeedsOf<S>> }) {
    class AppBase {
        static readonly kind = 'app';
        static readonly spec: S = spec;

        readonly cx: Capabilities<NeedsOf<S>, ApiOfSpec<S>>;
        readonly inject: Injected<InjectOf<S>>;

        constructor(init: ServiceInit<S>) {
            this.cx = init.cx;
            this.inject = init.inject;
        }
    }
    return AppBase;
}

/** Declare a component's props by type: `Component({ props: props<{ onDone: () => void }>() })`. */
export function props<P>(): PropsDecl<P> {
    return {};
}

export type { Injectables };
