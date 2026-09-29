/**
 * The app runtime (docs/app-model.md, phase 2) without a browser: services, per-mount instances,
 * disposal order, handler cleanup and the run-time half of every refusal the types make.
 *
 * `flatten` stands in for the renderer here — it instantiates a mount node, reads what it renders
 * and disposes it — and the handler registry is a plain map, so a test can see exactly which
 * handlers are live and fire one the way a click would.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { element, flatten, signal, text, type Action, type IntentValue, type Node } from '../src/index.js';
import { needs } from '../src/contribution/capabilities.js';
import {
    App, Component, createAppRuntime, props, Service, View,
    type GrantedContext, type HandlerRegistry, type ServiceClass,
} from '../src/app/index.js';

function registry(): HandlerRegistry & { readonly live: Map<string, (v?: IntentValue) => void>; fire(action: Action): void } {
    const live = new Map<string, (v?: IntentValue) => void>();
    let next = 0;
    return {
        live,
        on(fn) {
            const id = `h${next++}`;
            live.set(id, fn);
            return { kind: 'handler', id };
        },
        off(action) {
            if (action.kind === 'handler') live.delete(action.id);
        },
        fire(action) {
            if (action.kind !== 'handler') throw new Error('not a handler');
            const fn = live.get(action.id);
            if (fn === undefined) throw new Error(`handler ${action.id} is not live`);
            fn();
        },
    };
}

const granted: GrantedContext = { storage: { kind: 'fake-storage' }, mesh: { kind: 'fake-mesh' } };

/** The text a mounted Clicker is showing right now. */
function label(unit: { readonly node: Node }): string {
    const [button] = flatten(unit.node);
    if (button?.kind !== 'element') throw new Error('expected an element');
    const [first] = button.children;
    if (first?.kind !== 'text') throw new Error('expected text');
    return first.value;
}
const nothing = (): Node => element('Stack', { children: [] });

// ---------------------------------------------------------------------------- units under test

const log: string[] = [];

class Counter extends Service({}) {
    constructed = log.push('Counter constructed');
    readonly total = signal(0);
}

class Clicker extends Component({ inject: { counter: Counter }, props: props<{ label: string }>() }) {
    readonly mine = signal(0);
    readonly press: Action = this.on(() => {
        this.mine.set(this.mine() + 1);
        this.inject.counter.total.set(this.inject.counter.total() + 1);
    });

    render(): Node {
        this.cx.onDispose(() => log.push(`${this.props.label} cx.onDispose`));
        return element('Button', {
            children: [text(() => `${this.props.label} mine=${this.mine()} total=${this.inject.counter.total()}`)],
        });
    }

    dispose(): void {
        log.push(`${this.props.label} dispose`);
    }
}

class Pair extends Component({}) {
    render(): Node {
        return element('Stack', {
            children: [this.mount(Clicker, { label: 'left' }), this.mount(Clicker, { label: 'right' })],
        });
    }
    dispose(): void {
        log.push('Pair dispose');
    }
}

class Needy extends Component({ needs: needs('mesh') }) {
    render(): Node { return nothing(); }
}

class Zone extends View({ params: z.object({ zone: z.string().min(1) }) }) {
    render(): Node { return element('Text', { children: [text(`zone ${this.params.zone}`)] }); }
}

class Site extends App({ needs: needs('storage'), services: [Counter], routes: { '/zones/:zone': Zone } }) {}

// ---------------------------------------------------------------------------- tests

describe('app runtime', () => {
    it('constructs a boot service once and shares it with every unit that injects it', () => {
        log.length = 0;
        const runtime = createAppRuntime(Site, granted);
        expect(log).toEqual(['Counter constructed']);

        const reg = registry();
        const a = runtime.component(Clicker, { label: 'a' }, reg).instantiate();
        const b = runtime.component(Clicker, { label: 'b' }, reg).instantiate();
        expect(log.filter((l) => l === 'Counter constructed')).toHaveLength(1);

        const [pressA, pressB] = [...reg.live.keys()].map((id): Action => ({ kind: 'handler', id }));
        reg.fire(pressA!);
        reg.fire(pressA!);
        reg.fire(pressB!);

        // Each instance counts its own presses; the service they share counts all of them.
        expect(label(a)).toBe('a mine=2 total=3');
        expect(label(b)).toBe('b mine=1 total=3');
        a.dispose();
        b.dispose();
        runtime.dispose();
    });

    it('gives every mount its own state, and a remount starts fresh', () => {
        const runtime = createAppRuntime(Site, granted);
        const reg = registry();
        const node = runtime.component(Clicker, { label: 'x' }, reg);

        const first = node.instantiate();
        reg.fire({ kind: 'handler', id: [...reg.live.keys()][0]! });
        expect(label(first)).toBe('x mine=1 total=1');
        first.dispose();
        expect(reg.live.size).toBe(0);

        // Same node, mounted again (a `when` flipping back): a new instance, a new count — and the
        // page-lifetime service still remembers.
        const second = node.instantiate();
        expect(label(second)).toBe('x mine=0 total=1');
        expect(reg.live.size).toBe(1);
        second.dispose();
        runtime.dispose();
    });

    it('disposes children before their parent, and removes every handler they registered', () => {
        log.length = 0;
        const runtime = createAppRuntime(Site, granted);
        const reg = registry();

        const unit = runtime.component(Pair, {}, reg).instantiate();
        log.length = 0;
        flatten(unit.node); // builds — and disposes — the two Clickers, as a `when` flip would
        expect(log).toEqual([
            'left dispose', 'left cx.onDispose',
            'right dispose', 'right cx.onDispose',
        ]);
        expect(reg.live.size).toBe(0);

        unit.dispose();
        expect(log.at(-1)).toBe('Pair dispose');
        runtime.dispose();
    });

    it('removes what a constructor registered before it threw', () => {
        class Broken extends Component({}) {
            readonly first = this.on(() => undefined);
            render(): Node { throw new Error('render failed'); }
        }
        const runtime = createAppRuntime(Site, granted);
        const reg = registry();
        expect(() => runtime.component(Broken, {}, reg).instantiate()).toThrow('render failed');
        expect(reg.live.size).toBe(0);
        runtime.dispose();
    });

    it('refuses a component that needs what the app was not granted — at run time too', () => {
        const runtime = createAppRuntime(Site, granted);
        // Site has 'storage' only. The typed path cannot write this; the erased path must still refuse.
        expect(() => runtime.component(Needy, {}, registry())).toThrow(/needs 'mesh', which the app \(Site\) was not granted/);
        runtime.dispose();
    });

    it('refuses a service that needs what the app was not granted', () => {
        class Mailer extends Service({ needs: needs('mesh') }) {}
        class Uses extends Component({ inject: { mailer: Mailer } }) {
            render(): Node { return nothing(); }
        }
        const runtime = createAppRuntime(Site, granted);
        expect(() => runtime.component(Uses, {}, registry()).instantiate()).toThrow(/Mailer needs 'mesh'/);
        runtime.dispose();
    });

    it('reports an injection cycle rather than recursing — the backstop for cross-module cycles', () => {
        // Class declarations cannot express this; objects with the same shape can, as two modules
        // importing each other effectively do.
        const A: ServiceClass = { kind: 'service', name: 'A', spec: { get inject() { return { b: B }; } }, create: () => ({}) };
        const B: ServiceClass = { kind: 'service', name: 'B', spec: { get inject() { return { a: A }; } }, create: () => ({}) };
        class Loop extends App({ services: [A], routes: {} }) {}
        expect(() => createAppRuntime(Loop, granted)).toThrow('Service injection cycle: A → B → A.');
    });

    it('parses a view\'s params through its schema, and refuses ones that do not parse', () => {
        const runtime = createAppRuntime(Site, granted);
        const unit = runtime.view(Zone, { zone: 'example.com' }, registry()).instantiate();
        expect(flatten(unit.node)).toEqual([
            { kind: 'element', component: 'Text', props: {}, children: [{ kind: 'text', value: 'zone example.com' }] },
        ]);
        unit.dispose();
        expect(() => runtime.view(Zone, { zone: '' }, registry())).toThrow(/Zone: params rejected/);
        runtime.dispose();
    });

    it('gives each unit exactly the capabilities it declared', () => {
        let seen: string[] = [];
        class Peek extends Component({ needs: needs('storage') }) {
            render(): Node {
                seen = Object.keys(this.cx).sort();
                return nothing();
            }
        }
        const runtime = createAppRuntime(Site, granted);
        runtime.component(Peek, {}, registry()).instantiate().dispose();
        // 'mesh' is in the grant but Peek did not ask for it, so it is not there.
        expect(seen).toEqual(['id', 'onDispose', 'storage']);
        runtime.dispose();
    });
});
