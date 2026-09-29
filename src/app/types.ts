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
        | { readonly success: false; readonly error: { readonly message: string } };
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
    readonly api?: unknown;
}

/**
 * A service class, as something else names it in `inject`.
 *
 * `init: never` so that any service's constructor is assignable here whatever its own init type —
 * parameters are contravariant, and nothing can call a constructor typed this way, which is correct:
 * only the kernel constructs a service.
 */
export interface ServiceClass {
    readonly kind: 'service';
    readonly spec: UnitSpec;
    new (init: never): object;
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
export type PropsOf<S> = S extends { readonly props: PropsDecl<infer P> } ? P : None;

/** `inject: { auth: AuthService }` → `this.inject.auth: AuthService`. */
export type Injected<I extends Injectables> = {
    readonly [K in keyof I]: I[K] extends abstract new (init: never) => infer T ? T : never;
};

// ---------------------------------------------------------------------------- mounting

/** What a mountable class looks like from outside, before its own types are known. */
export interface ComponentClass {
    readonly kind: 'component';
    readonly spec: UnitSpec & { readonly props?: PropsDecl<unknown> };
    new (init: never): { render(): Node };
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
    readonly spec: UnitSpec & { readonly params?: SchemaLike<object> };
    new (init: never): { render(): Node };
}

type RouteCheck<P extends string, V, AppNeeds extends readonly CapabilityName[]> =
    V extends ViewClass
        ? [Exclude<PathParams<P>, keyof ParamsOf<V['spec']>>] extends [never]
            ? [MissingNeeds<NeedsOf<V['spec']>, AppNeeds>] extends [never]
                ? V
                : {
                    readonly __error: 'this view needs capabilities the app was not granted';
                    readonly missing: MissingNeeds<NeedsOf<V['spec']>, AppNeeds>;
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
