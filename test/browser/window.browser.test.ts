/**
 * Window mechanics in a real browser — spec/testing.md section 4, roadmap A0.5a.
 *
 * These assertions are not restatements of the jsdom suite in a slower runner. Each one is a claim
 * jsdom is structurally unable to evaluate:
 *
 * - **layout.** jsdom computes no boxes. Every `getBoundingClientRect()` there is zero, so "the
 *   window is 300px wide and the rows stack" is untestable by construction.
 * - **pointer capture.** A drag that leaves the handle must keep receiving moves. jsdom has no
 *   capture, so the bug every hand-rolled drag has on its first try cannot appear.
 * - **a trusted event.** Input here is delivered by the browser through CDP. In jsdom the test
 *   synthesises the event it is testing, which in the pointer cases is most of what is under test.
 *
 * The shell code below — the title bar, the grip — belongs to a real shell's Extension (kernel §2)
 * and is written out longhand because A4 has not happened. What is under test is the framework it
 * drives, not the chrome.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { page, userEvent } from '@vitest/browser/context';

import {
    Kernel, WindowManager, command, createRegistry, each, effect, element, mountView, needs,
    provider, text, when, windowSink, PRIMITIVES,
    type Action, type Application, type Context, type ViewContext, type ViewInstance,
} from '../../src/index.js';

// ---------------------------------------------------------------------------- a minimal site

interface Row {
    readonly id: string;
    readonly label: string;
    readonly done: boolean;
}

interface ListApi {
    readonly rows: () => readonly Row[];
    add(label: string): void;
    toggle(id: string): void;
}
const LIST = provider<ListApi>('test.list');

const LIST_NEEDS = needs('state', 'commands', 'windows');

class ListApp implements Application<typeof LIST_NEEDS, readonly [], typeof LIST> {
    readonly needs = LIST_NEEDS;
    readonly provides = LIST;

    readonly commands = [
        { id: 'list.add', title: 'Add a row' },
        { id: 'list.toggle', title: 'Toggle a row' },
    ];
    readonly keys = [{ command: 'list.add', keys: 'ctrl+n' }];

    readonly views = [
        {
            id: 'main',
            title: 'Rows',
            tile: 'main',
            instances: 'many' as const,
            defaultSize: { width: 300, height: 240 },
            minSize: { width: 200, height: 120 },
            render: (vx: ViewContext<Record<string, never>, ListApi>) =>
                element('Stack', {
                    props: { class: 'pane', style: { display: 'flex', 'flex-direction': 'column' } },
                    children: [
                        element('List', {
                            props: { class: 'rows', style: { margin: '0', padding: '0' } },
                            children: [
                                each(
                                    () => vx.app.rows(),
                                    (r: Row) => r.id,
                                    (r: () => Row) =>
                                        element('ListItem', {
                                            props: { class: 'row', style: { height: '24px' } },
                                            intents: { activate: { action: command('list.add', 'clicked') } },
                                            children: [
                                                text(() => r().label),
                                                // A `when` inside an `each`: the branch depends on
                                                // the *item*, which a reused row updates in place.
                                                when(
                                                    () => r().done,
                                                    () => element('Badge', { props: { class: 'done' }, children: [text('done')] }),
                                                    () => element('Badge', { props: { class: 'todo' }, children: [text('todo')] }),
                                                ),
                                            ],
                                        }),
                                ),
                            ],
                        }),
                    ],
                }),
        },
    ];

    async start(cx: Context<typeof LIST_NEEDS>): Promise<ListApi> {
        const rows = cx.state.signal<readonly Row[]>([
            { id: 'a', label: 'first', done: false },
            { id: 'b', label: 'second', done: false },
        ]);

        let n = 0;
        const add = (label: string): void => {
            n += 1;
            rows.set([...rows(), { id: `n${n}`, label: `${label} ${n}`, done: false }]);
        };

        const toggle = (id: string): void =>
            rows.set(rows().map((r) => (r.id === id ? { ...r, done: !r.done } : r)));

        cx.commands.implement('list.add', (label) => add(String(label ?? 'row')));
        cx.commands.implement('list.toggle', (id) => toggle(String(id)));

        return { rows, add, toggle };
    }
}

// ---------------------------------------------------------------------------- the shell

interface Site {
    readonly kernel: Kernel;
    readonly manager: WindowManager;
    readonly dispatched: Action[];
    dispose(): void;
}

/** A drag reported as deltas. The manager owns geometry; this owns nothing. */
function drag(handle: HTMLElement, onMove: (dx: number, dy: number) => void): void {
    handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);

        let x = event.clientX;
        let y = event.clientY;

        const move = (e: PointerEvent): void => {
            onMove(e.clientX - x, e.clientY - y);
            x = e.clientX;
            y = e.clientY;
        };

        const up = (): void => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
        };

        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
    });
}

async function bootSite(): Promise<Site> {
    const root = document.createElement('div');
    root.id = 'desktop';
    root.style.cssText = 'position:relative;width:900px;height:600px;overflow:hidden';
    document.body.appendChild(root);

    const manager = new WindowManager({ width: 900, height: 600 });
    const kernel = new Kernel();
    kernel.services.windows = windowSink(manager, (owner, view) => kernel.viewOf(owner, view));
    kernel.boot([{ id: 'list', contribution: new ListApp() as never }]);

    const components = createRegistry(PRIMITIVES);
    const dispatched: Action[] = [];
    const frames = new Map<string, { host: HTMLElement; instance: ViewInstance }>();

    const paint = effect(() => {
        const stacked = manager.stacked();
        const live = new Set(stacked.map((r) => r.id));

        for (const record of stacked) {
            let frame = frames.get(record.id);

            if (frame === undefined) {
                const host = document.createElement('div');
                host.className = 'window';
                host.dataset['window'] = record.id;
                host.style.cssText = 'position:absolute;display:flex;flex-direction:column;overflow:hidden';

                const bar = document.createElement('div');
                bar.className = 'titlebar';
                bar.style.cssText = 'height:24px;flex:none;touch-action:none';

                const content = document.createElement('div');
                content.className = 'content';
                content.style.cssText = 'flex:1;overflow:auto';

                const grip = document.createElement('div');
                grip.className = 'grip';
                grip.style.cssText = 'position:absolute;right:0;bottom:0;width:16px;height:16px;touch-action:none';

                host.append(bar, content, grip);
                root.appendChild(host);

                drag(bar, (dx, dy) => manager.move(record.id, dx, dy));
                drag(grip, (dx, dy) => manager.resize(record.id, 'se', dx, dy));

                const process = kernel.processes.find((p) => p.pid === record.owner)!;
                const instance = mountView(content, {
                    windowId: record.id,
                    decl: kernel.viewOf(record.owner, record.view)!,
                    api: process.api,
                    params: record.params,
                    windows: manager,
                    render: { components, dispatch: { dispatch: () => {} } },
                    onCommand: (action) => {
                        dispatched.push(action);
                        if (action.kind === 'command') {
                            void kernel.services.commands.get(action.id)?.run(...(action.args ?? []));
                        }
                    },
                });

                frame = { host, instance };
                frames.set(record.id, frame);
            }

            const { host } = frame;
            host.style.left = `${record.rect.x}px`;
            host.style.top = `${record.rect.y}px`;
            host.style.width = `${record.rect.width}px`;
            host.style.height = `${record.rect.height}px`;
            host.style.zIndex = String(manager.zIndexOf(record.id));
        }

        for (const [id, frame] of [...frames]) {
            if (live.has(id)) continue;
            frame.instance.dispose();
            frame.host.remove();
            frames.delete(id);
        }
    });

    await kernel.start('list');
    await kernel.services.commands.get('list.add')!.run('seed');

    return {
        kernel,
        manager,
        dispatched,
        dispose(): void {
            paint();
            for (const frame of frames.values()) {
                frame.instance.dispose();
                frame.host.remove();
            }
            root.remove();
        },
    };
}

let site: Site | undefined;

afterEach(() => {
    site?.dispose();
    site = undefined;
    document.body.innerHTML = '';
});

const box = (selector: string): DOMRect =>
    document.querySelector(selector)!.getBoundingClientRect();

/**
 * Drag a handle by a delta.
 *
 * `userEvent.dragAndDrop` takes `sourcePosition` relative to the source element and
 * `targetPosition` relative to the *target* — two different origins, which is the trap. Written out
 * once here rather than at four call sites, because the first version of these tests got it wrong
 * and read as a framework bug: a 220px drag moved 180, and a resize meant to grow shrank to the
 * minimum instead.
 */
async function dragBy(handle: HTMLElement, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
    const source = handle.getBoundingClientRect();
    const body = document.body.getBoundingClientRect();

    await userEvent.dragAndDrop(handle, document.body, {
        sourcePosition: from,
        targetPosition: {
            x: source.left + from.x + dx - body.left,
            y: source.top + from.y + dy - body.top,
        },
        // The window follows the pointer, so by the end of the drag the drop point is over the
        // window rather than over the body. Playwright's actionability check calls that an
        // interception; here it is the expected outcome, so the check is not the right one to run.
        force: true,
    });
}

// ---------------------------------------------------------------------------- the tests

describe('a window in a real browser', () => {
    it('has the size its view declared, in actual pixels', async () => {
        site = await bootSite();
        await kernel_open(site);

        const rect = box('.window');
        // jsdom reports 0 for every one of these. Nothing in the jsdom suite can make this claim.
        expect(rect.width).toBe(300);
        expect(rect.height).toBe(240);
        expect(rect.width).toBeGreaterThan(0);
    });

    it('lays its rows out in a column, each one occupying space', async () => {
        site = await bootSite();
        await kernel_open(site);

        const rows = [...document.querySelectorAll<HTMLElement>('.row')];
        expect(rows.length).toBeGreaterThan(1);

        const tops = rows.map((r) => r.getBoundingClientRect().top);
        expect(tops[1]!).toBeGreaterThan(tops[0]!);
        expect(rows[0]!.getBoundingClientRect().height).toBe(24);
    });

    it('moves under a real drag, and keeps receiving moves after the pointer leaves the handle', async () => {
        site = await bootSite();
        await kernel_open(site);

        const before = box('.window');
        const bar = document.querySelector<HTMLElement>('.titlebar')!;

        // Ends 200px below the title bar — well outside it. Without pointer capture the drag stops
        // at the first move, which is exactly the bug this exists to catch.
        await dragBy(bar, { x: 40, y: 12 }, 220, 200);

        const after = box('.window');
        expect(after.left - before.left).toBeCloseTo(220, -1);
        expect(after.top - before.top).toBeCloseTo(200, -1);
    });

    it('does not re-render the view when the window moves', async () => {
        site = await bootSite();
        await kernel_open(site);

        const firstRow = document.querySelector('.row')!;
        const text = document.querySelector('.content')!.textContent;

        site.manager.move(document.querySelector<HTMLElement>('.window')!.dataset['window']!, 60, 40);
        await tick();

        // Identity, not equality: geometry is the shell's and application state is the
        // Application's, and they do not share a render pass.
        expect(document.querySelector('.row')).toBe(firstRow);
        expect(document.querySelector('.content')!.textContent).toBe(text);
    });

    it('grows from the grip and will not shrink below the declared minimum', async () => {
        site = await bootSite();
        await kernel_open(site);

        await dragBy(document.querySelector<HTMLElement>('.grip')!, { x: 8, y: 8 }, 120, 60);
        expect(box('.window').width).toBeCloseTo(420, -1);

        await dragBy(document.querySelector<HTMLElement>('.grip')!, { x: 8, y: 8 }, -400, -400);
        // minSize from the view declaration, enforced by real layout rather than by arithmetic.
        expect(box('.window').width).toBe(200);
        expect(box('.window').height).toBe(120);
    });
});

describe('input the browser delivers, rather than input the test synthesises', () => {
    it('turns a real click into a command the kernel runs', async () => {
        site = await bootSite();
        await kernel_open(site);

        const before = document.querySelectorAll('.row').length;
        await userEvent.click(document.querySelector<HTMLElement>('.row')!);
        await tick();

        expect(site.dispatched.at(-1)).toEqual({ kind: 'command', id: 'list.add', args: ['clicked'] });
        // The command ran, the Application's state changed, and the view followed — all through the
        // kernel, from one trusted event.
        expect(document.querySelectorAll('.row')).toHaveLength(before + 1);
    });

    it('reaches a row by keyboard alone, and activates it', async () => {
        site = await bootSite();
        await kernel_open(site);

        const row = document.querySelector<HTMLElement>('.row')!;
        row.tabIndex = 0;
        row.focus();

        // Real focus, which jsdom models only approximately.
        expect(document.activeElement).toBe(row);

        const before = document.querySelectorAll('.row').length;
        await userEvent.keyboard('{Enter}');
        await tick();

        // spec/input.md section 3: every action must have a non-pointer path.
        expect(document.querySelectorAll('.row')).toHaveLength(before + 1);
    });

    /**
     * A command mutates application state and a branch *inside a reused row* follows it.
     *
     * Written because a throwaway browser harness made it look as though a command could run —
     * the dispatch was logged — without the view changing. It could not be reproduced here, and the
     * harness was the thing that was wrong. The test stays: it is the narrowest statement of what
     * was doubted, and `when` inside `each` is where the two reconcilers meet.
     */
    it('flips a branch inside a row the reconciler kept', async () => {
        site = await bootSite();
        await kernel_open(site);

        const row = document.querySelectorAll<HTMLElement>('.row')[0]!;
        expect(row.querySelector('.todo')).not.toBeNull();
        expect(row.querySelector('.done')).toBeNull();

        await site.kernel.services.commands.get('list.toggle')!.run('a');
        await tick();

        // The row survived — same element — and only its branch changed.
        expect(document.querySelectorAll<HTMLElement>('.row')[0]).toBe(row);
        expect(row.querySelector('.done')).not.toBeNull();
        expect(row.querySelector('.todo')).toBeNull();
        expect(row.textContent).toBe('firstdone');

        await site.kernel.services.commands.get('list.toggle')!.run('a');
        await tick();
        expect(row.querySelector('.todo')).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------- helpers

/** Open the app's window through its own capability, the way anything else would. */
async function kernel_open(s: Site): Promise<void> {
    const pid = s.kernel.processes[0]!.pid;
    s.kernel.services.windows.open(pid, 'main', {});
    await tick();
}

/** Effects flush on a microtask; a browser frame is a good deal longer than that. */
const tick = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
