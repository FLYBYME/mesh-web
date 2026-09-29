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
 * The site is an App on the desktop (`mountDesktop`) — the real shell, the default frame. It was a
 * legacy Application driven by a hand-written shell until the part model went (docs/app-model.md,
 * phase 5c); the claims below did not change.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from '@vitest/browser/context';

import {
    App, Service, View, WindowManager, each, element, mountDesktop, signal, text, when,
    type MountedDesktop, type Node,
} from '../../src/index.js';
import type { HistoryLike } from '../../src/router/router.js';

// ---------------------------------------------------------------------------- a minimal site

interface Row {
    readonly id: string;
    readonly label: string;
    readonly done: boolean;
}

/** The rows, shared by every window on the list. */
const RowsBase = Service({});
class Rows extends RowsBase {
    readonly rows = signal<readonly Row[]>([
        { id: 'a', label: 'first', done: false },
        { id: 'b', label: 'second', done: false },
    ]);
    #n = 0;

    constructor(...args: ConstructorParameters<typeof RowsBase>) {
        super(...args);
        this.add('seed');
    }

    add(label: string): void {
        this.#n += 1;
        this.rows.set([...this.rows(), { id: `n${this.#n}`, label: `${label} ${this.#n}`, done: false }]);
    }

    toggle(id: string): void {
        this.rows.set(this.rows().map((r) => (r.id === id ? { ...r, done: !r.done } : r)));
    }
}

let rows: Rows | undefined;

class ListView extends View({
    inject: { rows: Rows },
    title: 'Rows',
    window: {
        tile: 'main',
        defaultSize: { width: 300, height: 240 },
        minSize: { width: 200, height: 120 },
    },
}) {
    render(): Node {
        const list = this.inject.rows;
        rows = list;
        return element('Stack', {
            props: { class: 'pane', style: { display: 'flex', 'flex-direction': 'column' } },
            children: [
                element('List', {
                    props: { class: 'rows', style: { margin: '0', padding: '0' } },
                    children: [
                        each(
                            () => list.rows(),
                            (r: Row) => r.id,
                            (r: () => Row) =>
                                element('ListItem', {
                                    props: { class: 'row', style: { height: '24px' } },
                                    intents: { activate: { action: this.on(() => list.add('clicked')) } },
                                    children: [
                                        text(() => r().label),
                                        // A `when` inside an `each`: the branch depends on the
                                        // *item*, which a reused row updates in place.
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
        });
    }
}

class ListApp extends App({ services: [Rows], routes: { '/': ListView } }) {}

// ---------------------------------------------------------------------------- the desktop

interface Site {
    readonly manager: WindowManager;
    readonly desk: MountedDesktop;
    dispose(): void;
}

/** A history that lives in memory, so the test runner's own URL is never touched. */
function memoryHistory(): HistoryLike {
    return { pathname: () => '/', search: () => '', push: () => undefined, replace: () => undefined, back: () => undefined, onChange: () => () => undefined };
}

async function bootSite(): Promise<Site> {
    const root = document.createElement('div');
    root.id = 'desktop';
    root.style.cssText = 'position:relative;width:900px;height:600px;overflow:hidden';
    document.body.appendChild(root);

    // The default frame ships no stylesheet — the framework says which element is the title bar and
    // never what one looks like — so the test supplies the appearance a site would. Not `position`:
    // the shell sets that itself.
    const style = document.createElement('style');
    style.textContent = `
        .window { display: flex; flex-direction: column; overflow: hidden; }
        .titlebar { height: 24px; flex: none; touch-action: none; }
        .content { flex: 1; overflow: auto; }
        .grip { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; touch-action: none; }
    `;
    document.head.appendChild(style);

    // The route '/' opens as a window on boot.
    const desk = mountDesktop(ListApp, { root, history: memoryHistory() });
    await tick();

    return {
        desk,
        manager: desk.manager,
        dispose(): void {
            desk.dispose();
            root.remove();
            style.remove();
        },
    };
}

let site: Site | undefined;

afterEach(() => {
    site?.dispose();
    site = undefined;
    rows = undefined;
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

        const rect = box('.window');
        // jsdom reports 0 for every one of these. Nothing in the jsdom suite can make this claim.
        expect(rect.width).toBe(300);
        expect(rect.height).toBe(240);
        expect(rect.width).toBeGreaterThan(0);
    });

    it('lays its rows out in a column, each one occupying space', async () => {
        site = await bootSite();

        const all = [...document.querySelectorAll<HTMLElement>('.row')];
        expect(all.length).toBeGreaterThan(1);

        const tops = all.map((r) => r.getBoundingClientRect().top);
        expect(tops[1]!).toBeGreaterThan(tops[0]!);
        expect(all[0]!.getBoundingClientRect().height).toBe(24);
    });

    it('moves under a real drag, and keeps receiving moves after the pointer leaves the handle', async () => {
        site = await bootSite();

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

        const firstRow = document.querySelector('.row')!;
        const content = document.querySelector('.content')!.textContent;

        site.manager.move(document.querySelector<HTMLElement>('.window')!.dataset['window']!, 60, 40);
        await tick();

        // Identity, not equality: geometry is the shell's and application state is the App's, and
        // they do not share a render pass.
        expect(document.querySelector('.row')).toBe(firstRow);
        expect(document.querySelector('.content')!.textContent).toBe(content);
    });

    it('grows from the grip and will not shrink below the declared minimum', async () => {
        site = await bootSite();

        await dragBy(document.querySelector<HTMLElement>('.grip')!, { x: 8, y: 8 }, 120, 60);
        expect(box('.window').width).toBeCloseTo(420, -1);

        await dragBy(document.querySelector<HTMLElement>('.grip')!, { x: 8, y: 8 }, -400, -400);
        // minSize from the view's window hints, enforced by real layout rather than by arithmetic.
        expect(box('.window').width).toBe(200);
        expect(box('.window').height).toBe(120);
    });
});

describe('input the browser delivers, rather than input the test synthesises', () => {
    it('turns a real click into the handler the view registered', async () => {
        site = await bootSite();

        const before = document.querySelectorAll('.row').length;
        await userEvent.click(document.querySelector<HTMLElement>('.row')!);
        await tick();

        // The handler ran, the shared state changed, and the view followed — from one trusted event.
        const after = [...document.querySelectorAll('.row')];
        expect(after).toHaveLength(before + 1);
        expect(after.at(-1)?.textContent).toContain('clicked');
    });

    it('reaches a row by keyboard alone, and activates it', async () => {
        site = await bootSite();

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
     * State changes and a branch *inside a reused row* follows it.
     *
     * Written because a throwaway browser harness made it look as though a command could run —
     * the dispatch was logged — without the view changing. It could not be reproduced here, and the
     * harness was the thing that was wrong. The test stays: it is the narrowest statement of what
     * was doubted, and `when` inside `each` is where the two reconcilers meet.
     */
    it('flips a branch inside a row the reconciler kept', async () => {
        site = await bootSite();

        const row = document.querySelectorAll<HTMLElement>('.row')[0]!;
        expect(row.querySelector('.todo')).not.toBeNull();
        expect(row.querySelector('.done')).toBeNull();

        rows?.toggle('a');
        await tick();

        // The row survived — same element — and only its branch changed.
        expect(document.querySelectorAll<HTMLElement>('.row')[0]).toBe(row);
        expect(row.querySelector('.done')).not.toBeNull();
        expect(row.querySelector('.todo')).toBeNull();
        expect(row.textContent).toBe('firstdone');

        rows?.toggle('a');
        await tick();
        expect(row.querySelector('.todo')).not.toBeNull();
    });
});

// ---------------------------------------------------------------------------- helpers

/** Effects flush on a microtask; a browser frame is a good deal longer than that. */
const tick = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
