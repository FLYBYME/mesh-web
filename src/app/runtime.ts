/**
 * The app runtime: constructs services once, and views and components once per mount
 * (docs/app-model.md, phase 2).
 *
 * One runtime per App. It holds the App's granted context — every capability the App declared — and
 * everything below it gets a *projection* of that: exactly the capabilities the unit declared, and
 * its own `onDispose`. A unit that asks for more than its host was granted is refused here, at run
 * time, the same rule the types enforce at compile time — so a hand-erased call cannot get round it.
 *
 * Deliberately not tied to the kernel's broker: it takes a granted context and a place to register
 * handlers, which is all it needs. Phase 4 has the router construct it; until then a legacy
 * Application can host it (see test/browser/app-runtime.browser.test.ts).
 */

import type { CapabilityName } from '../contribution/capabilities.js';
import type { Action, IntentValue, MountNode, MountedUnit, Node } from '../description/types.js';
import { element, text } from '../description/build.js';
import { computed } from '../reactivity/computed.js';
import { createCommandRegistry, type CommandRegistry, type CommandRegistryOptions } from './registry.js';
import { attachRouter, Router, type RouterBackend } from './router.js';
import type {
    ComponentClass, ErasedInit, Injectables, MountableInstance, ServiceClass, UnitHost, UnitSpec, ViewClass,
} from './types.js';

/** Where a root registers its handlers: a window's table, today through `vx.on` / `vx.off`. */
export interface HandlerRegistry {
    on(fn: (value?: IntentValue) => void): Action;
    off(action: Action): void;
}

/** What the runtime needs of an App class. */
export interface AppClass {
    readonly kind: 'app';
    readonly name: string;
    /** `routes` is named so a spec holding only routes still matches — TypeScript's weak-type rule. */
    readonly spec: UnitSpec & {
        readonly routes: { readonly [path: string]: ViewClass };
        readonly services?: readonly ServiceClass[];
        readonly fallback?: (failure: MountFailure) => Node;
    };
    create(init: ErasedInit): object;
}

/** What failed to mount, handed to the App's `fallback`. */
export interface MountFailure {
    /** The class name of the view or component that threw. */
    readonly unit: string;
    readonly error: unknown;
}

/**
 * What stands in for a unit that threw while being constructed or rendered. Says which unit, not
 * why: the error itself goes to the console, where the log viewer shows it — a visitor gets a gap
 * with a label rather than a stack trace, and the rest of the page.
 */
function defaultFallback(failure: MountFailure): Node {
    return element('Stack', {
        props: { role: 'alert', 'data-mount-error': failure.unit },
        children: [text(`${failure.unit} could not be shown.`)],
    });
}

/**
 * The context the App was granted. Typed by capability name so a legacy `Context<N>` is assignable
 * as-is; a capability the App was not granted is simply absent.
 */
export type GrantedContext = { readonly [K in CapabilityName]?: unknown };

export interface AppRuntime {
    /** The App instance. */
    readonly app: object;
    /** Every command on a live unit — services and the app for the page's life, views and components while mounted. */
    readonly commands: CommandRegistry;
    /**
     * A root node for a view, with raw params (from a URL) parsed through the view's schema.
     * `scope` names the window it is in, on a desktop; everything mounted beneath it inherits it.
     *
     * `rawQuery` is read reactively and parsed through the view's `query` schema on every change, so
     * the instance follows the query string without being rebuilt. A query that stops parsing keeps
     * the last good value — the router has already turned that URL into a 404, which disposes the view.
     */
    view(view: ViewClass, rawParams: unknown, handlers: HandlerRegistry, scope?: string, rawQuery?: () => unknown): MountNode;
    /** A root node for a component. */
    component(component: ComponentClass, props: unknown, handlers: HandlerRegistry, scope?: string): MountNode;
    /** The page is going: every service's `onDispose` and `dispose()`, last constructed first. */
    dispose(): void;
}

export interface AppRuntimeOptions {
    readonly commands?: CommandRegistryOptions;
    /** What the built-in `Router` service answers for. Supplied by `mountSite`. */
    readonly router?: RouterBackend;
}

export function createAppRuntime(App: AppClass, granted: GrantedContext, options: AppRuntimeOptions = {}): AppRuntime {
    const grant = needsOf(App.spec);
    const services = new Map<ServiceClass, object>();
    const constructing: ServiceClass[] = [];
    const teardowns: (() => void)[] = [];
    const commands = createCommandRegistry(options.commands);
    const fallback = App.spec.fallback ?? defaultFallback;

    /** A unit's `cx`: the declared capabilities out of the grant, plus its own `onDispose`. */
    const project = (who: string, needs: readonly CapabilityName[], cleanups: (() => void)[]): object => {
        const cx: Record<string, unknown> = {
            id: who,
            onDispose(fn: () => void): void {
                cleanups.push(fn);
            },
        };
        for (const name of needs) {
            if (granted[name] === undefined) {
                throw new Error(`${who} needs '${name}', which the app's context does not carry.`);
            }
            cx[name] = granted[name];
        }
        return cx;
    };

    const refuse = (who: string, needs: readonly CapabilityName[], host: readonly CapabilityName[], hostName: string): void => {
        const missing = needs.filter((n) => !host.includes(n));
        if (missing.length > 0) {
            throw new Error(
                `${who} needs ${missing.map((n) => `'${n}'`).join(', ')}, which ${hostName} was not granted. ` +
                'Capabilities only narrow going down.',
            );
        }
    };

    const service = (Class: ServiceClass): object => {
        const existing = services.get(Class);
        if (existing !== undefined) return existing;

        // Cannot be written with class declarations (a service can only inject one declared before
        // it), but two modules importing each other can still produce one at run time.
        if (constructing.includes(Class)) {
            const path = [...constructing.slice(constructing.indexOf(Class)), Class].map((c) => c.name).join(' → ');
            throw new Error(`Service injection cycle: ${path}.`);
        }

        refuse(Class.name, needsOf(Class.spec), grant, `the app (${App.name})`);

        constructing.push(Class);
        try {
            const cleanups: (() => void)[] = [];
            const instance = Class.create({
                cx: project(Class.name, needsOf(Class.spec), cleanups),
                inject: resolve(Class.spec.inject),
            });
            if (Class === Router && options.router !== undefined) attachRouter(instance, options.router);
            const retire = commands.add(Class.name, instance);
            services.set(Class, instance);
            teardowns.push(() => {
                retire();
                disposeOf(instance)?.();
                runAll(cleanups);
            });
            return instance;
        } finally {
            constructing.pop();
        }
    };

    const resolve = (inject: Injectables | undefined): { readonly [name: string]: object } => {
        const out: Record<string, object> = {};
        for (const [name, Class] of Object.entries(inject ?? {})) out[name] = service(Class);
        return out;
    };

    const mount = (
        Class: ViewClass | ComponentClass,
        extra: Pick<ErasedInit, 'params' | 'query' | 'props'>,
        handlers: HandlerRegistry,
        hostNeeds: readonly CapabilityName[],
        hostName: string,
        scope: string | undefined,
    ): MountNode => {
        const needs = needsOf(Class.spec);
        refuse(Class.name, needs, hostNeeds, hostName);

        return {
            kind: 'mount',
            name: Class.name,
            instantiate(): MountedUnit {
                const actions: Action[] = [];
                const cleanups: (() => void)[] = [];
                let instance: MountableInstance | undefined;
                let retire: (() => void) | undefined;

                // Commands go first: nothing may run a command on a unit that is already going.
                const teardown = (): void => {
                    try {
                        retire?.();
                        instance?.dispose?.();
                    } finally {
                        runAll(cleanups);
                        for (const action of actions.splice(0)) handlers.off(action);
                    }
                };

                const host: UnitHost = {
                    on(fn) {
                        const action = handlers.on(fn);
                        actions.push(action);
                        return action;
                    },
                    mount(child, props) {
                        return mount(child, { props }, handlers, needs, Class.name, scope);
                    },
                };

                try {
                    instance = Class.create({
                        cx: project(Class.name, needs, cleanups),
                        inject: resolve(Class.spec.inject),
                        host,
                        ...extra,
                    });
                    retire = commands.add(Class.name, instance, scope);
                    const node: Node = instance.render();
                    return { node, dispose: teardown };
                } catch (error) {
                    // Whatever it registered before failing goes with it — and then this mount is the
                    // error boundary: the unit that failed is replaced by the fallback, and its
                    // siblings, its parent and the rest of the page carry on.
                    teardown();
                    console.error(`${Class.name} failed to mount:`, error);
                    return { node: fallback({ unit: Class.name, error }), dispose: () => undefined };
                }
            },
        };
    };

    const appCleanups: (() => void)[] = [];
    for (const Class of App.spec.services ?? []) service(Class);
    const app = App.create({ cx: project(App.name, grant, appCleanups), inject: resolve(App.spec.inject) });
    const retireApp = commands.add(App.name, app);

    return {
        app,
        commands,
        view(view, rawParams, handlers, scope, rawQuery) {
            const schema = view.spec.params;
            let params: unknown = {};
            if (schema !== undefined) {
                const parsed = schema.safeParse(rawParams ?? {});
                if (!parsed.success) throw new Error(`${view.name}: params rejected — ${parsed.error.message}`);
                params = parsed.data;
            }
            return mount(view, { params, query: parseQuery(view, rawQuery ?? (() => ({}))) }, handlers, grant, `the app (${App.name})`, scope);
        },
        component(component, props, handlers, scope) {
            return mount(component, { props }, handlers, grant, `the app (${App.name})`, scope);
        },
        dispose() {
            retireApp();
            disposeOf(app)?.();
            runAll(appCleanups);
            for (const teardown of teardowns.splice(0).reverse()) teardown();
            services.clear();
        },
    };
}

/**
 * A view's `this.query`: the raw query through its schema, recomputed only when the raw query
 * changes. The first parse must succeed — a view is never constructed from a query it rejects.
 */
function parseQuery(view: ViewClass, rawQuery: () => unknown): () => unknown {
    const schema = view.spec.query;
    if (schema === undefined) return () => ({});

    const first = schema.safeParse(rawQuery() ?? {});
    if (!first.success) throw new Error(`${view.name}: query rejected — ${first.error.message}`);
    let last: unknown = first.data;
    return computed(() => {
        const parsed = schema.safeParse(rawQuery() ?? {});
        if (parsed.success) last = parsed.data;
        return last;
    });
}

function needsOf(spec: UnitSpec): readonly CapabilityName[] {
    return spec.needs ?? [];
}

/** Every cleanup runs even if one throws; the first error is rethrown after. */
function runAll(fns: (() => void)[]): void {
    let first: unknown;
    for (const fn of fns.splice(0)) {
        try {
            fn();
        } catch (error) {
            first ??= error;
        }
    }
    if (first !== undefined) throw first;
}

/** A service or app may define `dispose()`; nothing requires it to. */
function disposeOf(instance: object): (() => void) | undefined {
    if ('dispose' in instance && typeof instance.dispose === 'function') {
        const dispose: unknown = instance.dispose;
        return typeof dispose === 'function' ? () => { Reflect.apply(dispose, instance, []); } : undefined;
    }
    return undefined;
}
