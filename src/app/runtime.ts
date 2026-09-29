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
import { createCommandRegistry, type CommandRegistry, type CommandRegistryOptions } from './registry.js';
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
    readonly spec: UnitSpec & { readonly routes: object; readonly services?: readonly ServiceClass[] };
    create(init: ErasedInit): object;
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
    /** A root node for a view, with raw params (from a URL) parsed through the view's schema. */
    view(view: ViewClass, rawParams: unknown, handlers: HandlerRegistry): MountNode;
    /** A root node for a component. */
    component(component: ComponentClass, props: unknown, handlers: HandlerRegistry): MountNode;
    /** The page is going: every service's `onDispose` and `dispose()`, last constructed first. */
    dispose(): void;
}

export interface AppRuntimeOptions {
    readonly commands?: CommandRegistryOptions;
}

export function createAppRuntime(App: AppClass, granted: GrantedContext, options: AppRuntimeOptions = {}): AppRuntime {
    const grant = needsOf(App.spec);
    const services = new Map<ServiceClass, object>();
    const constructing: ServiceClass[] = [];
    const teardowns: (() => void)[] = [];
    const commands = createCommandRegistry(options.commands);

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
        extra: Pick<ErasedInit, 'params' | 'props'>,
        handlers: HandlerRegistry,
        hostNeeds: readonly CapabilityName[],
        hostName: string,
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
                        return mount(child, { props }, handlers, needs, Class.name);
                    },
                };

                try {
                    instance = Class.create({
                        cx: project(Class.name, needs, cleanups),
                        inject: resolve(Class.spec.inject),
                        host,
                        ...extra,
                    });
                    retire = commands.add(Class.name, instance);
                    const node: Node = instance.render();
                    return { node, dispose: teardown };
                } catch (error) {
                    // Whatever it registered before failing goes with it.
                    teardown();
                    throw error;
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
        view(view, rawParams, handlers) {
            const schema = view.spec.params;
            let params: unknown = {};
            if (schema !== undefined) {
                const parsed = schema.safeParse(rawParams ?? {});
                if (!parsed.success) throw new Error(`${view.name}: params rejected — ${parsed.error.message}`);
                params = parsed.data;
            }
            return mount(view, { params }, handlers, grant, `the app (${App.name})`);
        },
        component(component, props, handlers) {
            return mount(component, { props }, handlers, grant, `the app (${App.name})`);
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
