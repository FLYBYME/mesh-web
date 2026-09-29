/**
 * The type machinery under the app model (docs/app-model.md).
 *
 * Nothing here runs. It is what lets `class X extends View({ needs, inject, params })` give `X` a
 * fully typed `this.cx`, `this.inject` and `this.params`, and what turns "mounted a component its
 * host could not grant" and "a route whose `:param` the view never declared" into compile errors.
 */

import type { CapabilityContext, CapabilityName } from '../contribution/capabilities.js';
import type { Action, IntentValue, Node } from '../description/types.js';
import type { Models } from '../models/types.js';
import type { MeshClient } from '../net/client.js';
import type { AnyApiCall, Api } from '../net/api.js';

// ---------------------------------------------------------------------------- schemas

/**
 * **Any schema with zod's `safeParse` shape.**
 *
 * Structural rather than `import { z } from 'zod'`: mesh-web's `src/` has never depended on zod, the
 * kernel is bundled without it, and a generated client already uses whichever zod the site has
 * installed. A zod schema satisfies this as-is; so would anything else with the same shape.
 */
export interface SchemaLike<T> {
    safeParse(value: unknown):
        | { readonly success: true; readonly data: T }
        | { readonly success: false; readonly error: SchemaError };
}

/**
 * What a failed parse says. `issues` is optional because only some schema libraries itemise; zod
 * does, and it is what lets a form put "must be a number" beside the one field it is about.
 */
export interface SchemaError {
    readonly message: string;
    readonly issues?: readonly SchemaIssue[];
}

export interface SchemaIssue {
    readonly path: readonly PropertyKey[];
    readonly message: string;
}

/** What a schema produces — what `run` receives once the input has been parsed. */
export type Infer<S> = S extends SchemaLike<infer T> ? T : never;

/**
 * What a schema accepts — what a caller passes.
 *
 * Not the same as `Infer`: `z.object({ ttl: z.number().default(300) })` accepts `{}` and produces
 * `{ ttl: 300 }`. Typing callers with the output would demand every defaulted field. zod carries the
 * input type as the `_input` phantom; a schema without one is taken to accept what it produces.
 */
export type InferInput<S> = S extends { readonly _input: infer I } ? I : Infer<S>;

// ---------------------------------------------------------------------------- props

declare const PROPS: unique symbol;

/**
 * A component's props, declared as a type only — the same phantom pattern as `schema<T>()` in
 * `contribution/api.ts`. Props carry closures and signals, so there is nothing to validate at run
 * time; this exists so `Component({ props: props<{ onDone: () => void }>() })` can name the type
 * without a second generic argument the compiler could not infer.
 */
export interface PropsDecl<P> {
    readonly [PROPS]?: P;
}

// ---------------------------------------------------------------------------- capabilities

/**
 * What `this.cx` is for a unit that declared `N` and talks to API `A`.
 *
 * `mesh` and `models` are typed by the API, as in `contribution/contract.ts`; every other capability
 * has one type for everybody. A capability not in `N` is not a key at all — at the type level here,
 * and at run time because the kernel builds `cx` from exactly `N`.
 */
export type Capabilities<N extends readonly CapabilityName[], A> =
    & CapabilityContext<N>
    & ('mesh' extends N[number] ? { readonly mesh: MeshClient<A> } : unknown)
    & ('models' extends N[number] ? { readonly models: Models<A> } : unknown);

/** The capabilities in `Child` that `Host` does not have. `never` means the child fits. */
export type MissingNeeds<Child extends readonly CapabilityName[], Host extends readonly CapabilityName[]> =
    Exclude<Child[number], Host[number]>;

// ---------------------------------------------------------------------------- specs

/** What every unit's spec may say. */
export interface UnitSpec {
    readonly needs?: readonly CapabilityName[];
    readonly inject?: Injectables;
    /** The API `cx.mesh` and `cx.models` are typed by. */
    readonly api?: Api<Record<string, AnyApiCall>>;
}

/**
 * **What the runtime passes a constructor, with every unit's own types erased.**
 *
 * Each unit's constructor takes its precise init (`ServiceInit<S>`, `ViewInit<S>`, ...), and every
 * one of those is assignable to this. The runtime constructs through each class's static
 * `create(init)` **method**, not through a construct signature, and that is the whole point:
 * construct signatures compare parameters strictly, so no class is assignable to
 * `new (init: ErasedInit)`; methods compare them bivariantly, so every class's `create` is
 * assignable to `create(init: ErasedInit)` — the same reason `ViewDecl.render` is a method. That is
 * what lets the runtime construct with no cast anywhere. It is sound because the runtime is the one
 * place that builds an init, and builds it from the class's own spec.
 */
export interface ErasedInit {
    readonly cx: object;
    readonly inject: { readonly [name: string]: object };
    readonly params?: unknown;
    readonly query?: () => unknown;
    readonly props?: unknown;
    readonly host?: UnitHost;
}

/** A service class, as something else names it in `inject`. Only the runtime constructs one. */
export interface ServiceClass {
    readonly kind: 'service';
    readonly name: string;
    readonly spec: UnitSpec;
    create(init: ErasedInit): object;
}

export type Injectables = { readonly [name: string]: ServiceClass };

/**
 * "Declared nothing" is `None`, not `Record<string, never>`: `keyof` of the latter is `string`, so a
 * view with no params would satisfy every `:param` a route could name, and a component with no props
 * would demand a props argument. `keyof None` is `never`, which is what "nothing" has to mean.
 */
export type None = Record<never, never>;

export type NeedsOf<S> = S extends { readonly needs: infer N extends readonly CapabilityName[] } ? N : readonly [];
export type InjectOf<S> = S extends { readonly inject: infer I extends Injectables } ? I : None;
export type ApiOfSpec<S> = S extends { readonly api: infer A } ? A : unknown;
export type ParamsOf<S> = S extends { readonly params: infer P } ? Infer<P> : None;
/** A view's parsed `query`. Not `QueryOf`: that is the models' find-query type, exported beside this. */
export type SearchOf<S> = S extends { readonly query: infer Q } ? Infer<Q> : None;
export type PropsOf<S> = S extends { readonly props: PropsDecl<infer P> } ? P : None;

/** `inject: { auth: AuthService }` → `this.inject.auth: AuthService`. */
export type Injected<I extends Injectables> = {
    readonly [K in keyof I]: I[K] extends abstract new (init: never) => infer T ? T : never;
};

// ---------------------------------------------------------------------------- mounting

/** What a mountable class looks like from outside, before its own types are known. */
export interface ComponentClass {
    readonly kind: 'component';
    readonly name: string;
    readonly spec: UnitSpec & { readonly props?: PropsDecl<unknown> };
    create(init: ErasedInit): MountableInstance;
}

/** What a layout is handed: the page inside it, which changes while the layout stays. */
export interface LayoutProps {
    readonly outlet: Node;
}

/**
 * A layout is an ordinary component whose props are `LayoutProps` — `props<LayoutProps>()`. Required
 * rather than optional, so a component that takes no outlet (and so would drop the page) is refused.
 */
export interface LayoutClass extends ComponentClass {
    readonly spec: UnitSpec & { readonly props: PropsDecl<LayoutProps> };
}

/** What the runtime needs from a constructed view or component. */
export interface MountableInstance {
    render(): Node;
    /**
     * Called once when the instance leaves, after everything it mounted has gone. An author just
     * writes `dispose()`; it is deliberately not declared on the base classes, where
     * `noImplicitOverride` would make every author write `override` for a hook they never inherited.
     */
    dispose?(): void;
}

/**
 * Passes through when the component fits the host; otherwise an object type the class cannot
 * satisfy, whose property names say what went wrong. That is the whole trick: the error a person
 * sees at the `mount` call names `__error` and `missing`, not a wall of generics.
 */
export type CheckNeeds<C extends ComponentClass, HostNeeds extends readonly CapabilityName[]> =
    [MissingNeeds<NeedsOf<C['spec']>, HostNeeds>] extends [never]
        ? unknown
        : {
            readonly __error: 'this component needs capabilities its host was not granted';
            readonly missing: MissingNeeds<NeedsOf<C['spec']>, HostNeeds>;
        };

/** A component with no props is mounted as `mount(C)`; one with props requires them. */
export type MountArgs<C extends ComponentClass> =
    keyof PropsOf<C['spec']> extends never ? [props?: PropsOf<C['spec']>] : [props: PropsOf<C['spec']>];

// ---------------------------------------------------------------------------- routes

/** `'/domains/:zone/records'` → `'zone'`. */
export type PathParams<P extends string> =
    P extends `${string}:${infer Name}/${infer Rest}`
        ? Name | PathParams<`/${Rest}`>
        : P extends `${string}:${infer Name}`
            ? Name
            : never;

/** What a routable class looks like from outside. */
export interface ViewClass {
    readonly kind: 'view';
    readonly name: string;
    /**
     * Every key a view spec can have, listed: an interface of only optional properties is a "weak
     * type", and a spec sharing none of them (`{ title }` alone, if `title` were missing here) is
     * refused as having nothing in common with it.
     */
    readonly spec: UnitSpec & {
        readonly params?: SchemaLike<object>;
        readonly query?: SchemaLike<object>;
        readonly title?: string;
        readonly layout?: LayoutClass;
        readonly window?: {
            readonly tile?: string;
            readonly defaultSize?: { readonly width?: number; readonly height?: number };
            readonly minSize?: { readonly width?: number; readonly height?: number };
            readonly closable?: boolean;
        };
    };
    create(init: ErasedInit): MountableInstance;
}

type LayoutSpecOf<S> = S extends { readonly layout: infer L extends LayoutClass } ? L['spec'] : unknown;

type RouteCheck<P extends string, V, AppNeeds extends readonly CapabilityName[]> =
    V extends ViewClass
        ? [Exclude<PathParams<P>, keyof ParamsOf<V['spec']>>] extends [never]
            ? [Exclude<keyof ParamsOf<V['spec']>, PathParams<P>>] extends [never]
                ? [MissingNeeds<NeedsOf<V['spec']>, AppNeeds>] extends [never]
                    ? [MissingNeeds<NeedsOf<LayoutSpecOf<V['spec']>>, AppNeeds>] extends [never]
                        ? V
                        : {
                            readonly __error: 'this view\'s layout needs capabilities the app was not granted';
                            readonly missing: MissingNeeds<NeedsOf<LayoutSpecOf<V['spec']>>, AppNeeds>;
                        }
                    : {
                        readonly __error: 'this view needs capabilities the app was not granted';
                        readonly missing: MissingNeeds<NeedsOf<V['spec']>, AppNeeds>;
                    }
                : {
                    // `params` is the path; the query string is `query`. A `params` field the path
                    // does not have could never be filled.
                    readonly __error: 'this view declares params the route path does not have (query-string values belong in `query`)';
                    readonly missing: Exclude<keyof ParamsOf<V['spec']>, PathParams<P>>;
                }
            : {
                readonly __error: 'this route has path params the view does not declare in `params`';
                readonly missing: Exclude<PathParams<P>, keyof ParamsOf<V['spec']>>;
            }
        : never;

/** Every route checked against its view. Intersected with the spec in `App()`. */
export type CheckRoutes<R, AppNeeds extends readonly CapabilityName[]> = {
    readonly [P in keyof R]: P extends string ? RouteCheck<P, R[P], AppNeeds> : never;
};

// ---------------------------------------------------------------------------- the host

/**
 * What the kernel hands a view or component besides `cx`: the two things only a mounted instance
 * can do. Erased here; the typed signatures are on the base classes.
 */
export interface UnitHost {
    on(fn: (value?: IntentValue) => void): Action;
    mount(component: ComponentClass, props: unknown): Node;
}
