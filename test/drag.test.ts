/**
 * @vitest-environment jsdom
 *
 * Roadmap A7.3 & spec/input.md §3: Draggable and DropZone.
 *
 * Requirement: Every action must have a non-pointer path (§3).
 *
 * Drag is modeled as selection (grab) followed by target (drop).
 * Keyboard (Enter/Space on Draggable -> Tab -> Enter/Space on DropZone),
 * mouse click-to-grab / click-to-drop, and HTML5 pointer drag-and-drop
 * all share the exact same state machine, coordinator, and drop events.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    command,
    createHandlerTable,
    createRegistry,
    element,
    flushSync,
    getGrabbed,
    hasGrab,
    isGrabbed,
    PRIMITIVES,
    render,
    resetDrag,
    signal,
    text,
    type Action,
    type IntentValue,
    type Json,
} from '../src/index.js';

describe('Draggable and DropZone (A7.3)', () => {
    let host: HTMLDivElement;
    const tick = (): void => flushSync();

    beforeEach(() => {
        resetDrag();
        host = document.createElement('div');
        document.body.appendChild(host);
    });

    afterEach(() => {
        resetDrag();
        host.remove();
    });

    it('satisfies spec/input.md §3: keyboard drag (grab with Space/Enter -> drop with Space/Enter) moves payload', () => {
        // This test would completely FAIL on any pointer-only DnD implementation.
        // It exercises keyboard selection and drop through the unified coordinator.
        const droppedPayloads: Json[] = [];
        const handlers = createHandlerTable('kanban-view');
        const dropAction = handlers.on((val) => {
            if (val !== undefined) droppedPayloads.push(val);
        });

        const registry = createRegistry(PRIMITIVES);
        const cardPayload = { id: 'card-42', title: 'Task 42' };

        const view = element('Stack', {
            children: [
                element('Draggable', {
                    props: { data: cardPayload, type: 'card', class: 'card-draggable' },
                    children: [text('Grab me with Space')],
                }),
                element('DropZone', {
                    props: { accepts: 'card', class: 'column-dropzone' },
                    intents: { drop: { action: dropAction } },
                    children: [text('Drop column')],
                }),
            ],
        });

        const dispatch = {
            dispatch(action: Action, value?: IntentValue) {
                if (action.kind === 'handler') {
                    handlers.invoke(action.id, value);
                }
            },
        };

        const mounted = render(view, host, { components: registry, dispatch });

        const draggableEl = host.querySelector('.card-draggable');
        const dropzoneEl = host.querySelector('.column-dropzone');
        expect(draggableEl).not.toBeNull();
        expect(dropzoneEl).not.toBeNull();

        // 1. Initial state: focusable, not grabbed, not drop target
        expect(draggableEl?.getAttribute('tabindex')).toBe('0');
        expect(draggableEl?.getAttribute('data-mesh-draggable')).toBe('');
        expect(draggableEl?.getAttribute('aria-grabbed')).toBe('false');
        expect(dropzoneEl?.getAttribute('tabindex')).toBe('0');
        expect(dropzoneEl?.getAttribute('data-mesh-dropzone')).toBe('');
        expect(dropzoneEl?.hasAttribute('data-mesh-drop-target')).toBe(false);

        // 2. Keyboard Grab: focus draggable, press Space
        draggableEl?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));

        expect(hasGrab()).toBe(true);
        expect(getGrabbed()?.payload).toEqual(cardPayload);
        expect(isGrabbed(draggableEl!)).toBe(true);
        expect(draggableEl?.getAttribute('aria-grabbed')).toBe('true');
        expect(draggableEl?.hasAttribute('data-mesh-grabbed')).toBe(true);
        // Compatible dropzone gains target affordance
        expect(dropzoneEl?.hasAttribute('data-mesh-drop-target')).toBe(true);
        expect(dropzoneEl?.getAttribute('aria-dropeffect')).toBe('move');

        // 3. User tabs to DropZone and presses Enter to drop
        dropzoneEl?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

        // 4. Assert payload moved and state cleaned up!
        expect(droppedPayloads).toHaveLength(1);
        expect(droppedPayloads[0]).toEqual(cardPayload);
        expect(hasGrab()).toBe(false);
        expect(draggableEl?.hasAttribute('data-mesh-grabbed')).toBe(false);
        expect(draggableEl?.getAttribute('aria-grabbed')).toBe('false');
        expect(dropzoneEl?.hasAttribute('data-mesh-drop-target')).toBe(false);

        mounted.dispose();
    });

    it('supports mouse click-to-grab and click-to-drop', () => {
        const droppedPayloads: Json[] = [];
        const handlers = createHandlerTable('kanban-view');
        const dropAction = handlers.on((val) => {
            if (val !== undefined) droppedPayloads.push(val);
        });

        const registry = createRegistry(PRIMITIVES);
        const cardPayload = 'item-101';

        const view = element('Stack', {
            children: [
                element('Draggable', {
                    props: { data: cardPayload, class: 'draggable-click' },
                    children: [text('Click item')],
                }),
                element('DropZone', {
                    props: { class: 'dropzone-click' },
                    intents: { drop: { action: dropAction } },
                    children: [text('Click drop')],
                }),
            ],
        });

        const dispatch = {
            dispatch(action: Action, value?: IntentValue) {
                if (action.kind === 'handler') {
                    handlers.invoke(action.id, value);
                }
            },
        };

        const mounted = render(view, host, { components: registry, dispatch });
        const draggableEl = host.querySelector('.draggable-click');
        const dropzoneEl = host.querySelector('.dropzone-click');

        // Click to grab
        draggableEl?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(hasGrab()).toBe(true);
        expect(getGrabbed()?.payload).toBe(cardPayload);

        // Click to drop
        dropzoneEl?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(droppedPayloads).toEqual(['item-101']);
        expect(hasGrab()).toBe(false);

        mounted.dispose();
    });

    it('supports HTML5 pointer drag and drop (dragstart -> dragover -> drop)', () => {
        const droppedPayloads: Json[] = [];
        const handlers = createHandlerTable('dnd-view');
        const dropAction = handlers.on((val) => {
            if (val !== undefined) droppedPayloads.push(val);
        });

        const registry = createRegistry(PRIMITIVES);
        const cardPayload = { title: 'Dragged Card' };

        const view = element('Stack', {
            children: [
                element('Draggable', {
                    props: { data: cardPayload, type: 'card', class: 'drag-ptr' },
                    children: [text('Drag pointer')],
                }),
                element('DropZone', {
                    props: { accepts: 'card', class: 'drop-ptr' },
                    intents: { drop: { action: dropAction } },
                    children: [text('Drop pointer')],
                }),
            ],
        });

        const dispatch = {
            dispatch(action: Action, value?: IntentValue) {
                if (action.kind === 'handler') {
                    handlers.invoke(action.id, value);
                }
            },
        };

        const mounted = render(view, host, { components: registry, dispatch });
        const draggableEl = host.querySelector('.drag-ptr')!;
        const dropzoneEl = host.querySelector('.drop-ptr')!;

        // 1. dragstart on Draggable
        const dragStartEvent = new Event('dragstart', { bubbles: true, cancelable: true });
        draggableEl.dispatchEvent(dragStartEvent);
        expect(hasGrab()).toBe(true);
        expect(getGrabbed()?.payload).toEqual(cardPayload);

        // 2. dragover on DropZone
        const dragOverEvent = new Event('dragover', { bubbles: true, cancelable: true });
        dropzoneEl.dispatchEvent(dragOverEvent);
        expect(dropzoneEl.hasAttribute('data-mesh-drag-over')).toBe(true);

        // 3. drop on DropZone
        const dropEvent = new Event('drop', { bubbles: true, cancelable: true });
        dropzoneEl.dispatchEvent(dropEvent);

        expect(droppedPayloads).toEqual([cardPayload]);
        expect(hasGrab()).toBe(false);
        expect(dropzoneEl.hasAttribute('data-mesh-drag-over')).toBe(false);

        mounted.dispose();
    });

    it('Escape cancels grab at any point in any modality', () => {
        const registry = createRegistry(PRIMITIVES);
        const view = element('Stack', {
            children: [
                element('Draggable', {
                    props: { data: 'escape-test', class: 'drag-esc' },
                }),
                element('DropZone', {
                    props: { class: 'drop-esc' },
                }),
            ],
        });

        const mounted = render(view, host, {
            components: registry,
            dispatch: { dispatch() {} },
        });

        const draggableEl = host.querySelector('.drag-esc')!;
        const dropzoneEl = host.querySelector('.drop-esc')!;

        // Grab
        draggableEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(hasGrab()).toBe(true);
        expect(dropzoneEl.hasAttribute('data-mesh-drop-target')).toBe(true);

        // Press Escape
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        // Assert cancelled
        expect(hasGrab()).toBe(false);
        expect(draggableEl.hasAttribute('data-mesh-grabbed')).toBe(false);
        expect(dropzoneEl.hasAttribute('data-mesh-drop-target')).toBe(false);

        mounted.dispose();
    });

    it('enforces type matching with accepts prop', () => {
        const dropped: Json[] = [];
        const handlers = createHandlerTable('type-match');
        const action = handlers.on((v) => { if (v !== undefined) dropped.push(v); });

        const registry = createRegistry(PRIMITIVES);

        const view = element('Stack', {
            children: [
                element('Draggable', {
                    props: { data: 'img-file', type: 'image', class: 'drag-img' },
                }),
                element('Draggable', {
                    props: { data: 'text-file', type: 'document', class: 'drag-doc' },
                }),
                element('DropZone', {
                    props: { accepts: 'image', class: 'drop-img-only' },
                    intents: { drop: { action } },
                }),
            ],
        });

        const dispatch = {
            dispatch(a: Action, v?: IntentValue) {
                if (a.kind === 'handler') handlers.invoke(a.id, v);
            },
        };

        const mounted = render(view, host, { components: registry, dispatch });
        const dragImg = host.querySelector('.drag-img')!;
        const dragDoc = host.querySelector('.drag-doc')!;
        const dropZone = host.querySelector('.drop-img-only')!;

        // Grab document: dropZone should NOT be target and drop should fail
        dragDoc.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(dropZone.hasAttribute('data-mesh-drop-target')).toBe(false);
        dropZone.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(dropped).toHaveLength(0);

        // Grab image: dropZone IS target and drop succeeds
        dragImg.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(dropZone.hasAttribute('data-mesh-drop-target')).toBe(true);
        dropZone.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(dropped).toEqual(['img-file']);

        mounted.dispose();
    });

    it('respects disabled state on Draggable and DropZone', () => {
        const dropped: Json[] = [];
        const handlers = createHandlerTable('disabled-test');
        const action = handlers.on((v) => { if (v !== undefined) dropped.push(v); });

        const registry = createRegistry(PRIMITIVES);

        const view = element('Stack', {
            children: [
                element('Draggable', {
                    props: { data: 'cant-drag', disabled: true, class: 'drag-dis' },
                }),
                element('Draggable', {
                    props: { data: 'can-drag', disabled: false, class: 'drag-ok' },
                }),
                element('DropZone', {
                    props: { disabled: true, class: 'drop-dis' },
                    intents: { drop: { action } },
                }),
            ],
        });

        const dispatch = {
            dispatch(a: Action, v?: IntentValue) {
                if (a.kind === 'handler') handlers.invoke(a.id, v);
            },
        };

        const mounted = render(view, host, { components: registry, dispatch });
        const dragDis = host.querySelector('.drag-dis')!;
        const dragOk = host.querySelector('.drag-ok')!;
        const dropDis = host.querySelector('.drop-dis')!;

        expect(dragDis.hasAttribute('data-mesh-disabled')).toBe(true);
        expect(dragDis.hasAttribute('tabindex')).toBe(false);

        // Clicking disabled draggable does nothing
        dragDis.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(hasGrab()).toBe(false);

        // Grab ok draggable, attempt to drop on disabled dropzone
        dragOk.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(hasGrab()).toBe(true);
        expect(dropDis.hasAttribute('data-mesh-drop-target')).toBe(false);

        dropDis.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(dropped).toHaveLength(0);

        mounted.dispose();
    });

    it('falls back to intents.activate on DropZone if intents.drop is not specified', () => {
        const activatedPayloads: Json[] = [];
        const handlers = createHandlerTable('activate-fallback');
        const activateAction = handlers.on((val) => {
            if (val !== undefined) activatedPayloads.push(val);
        });

        const registry = createRegistry(PRIMITIVES);
        const view = element('Stack', {
            children: [
                element('Draggable', {
                    props: { data: 'fallback-item', class: 'drag-fb' },
                }),
                element('DropZone', {
                    props: { class: 'drop-fb' },
                    intents: { activate: { action: activateAction } },
                }),
            ],
        });

        const dispatch = {
            dispatch(action: Action, value?: IntentValue) {
                if (action.kind === 'handler') handlers.invoke(action.id, value);
            },
        };

        const mounted = render(view, host, { components: registry, dispatch });
        const dragEl = host.querySelector('.drag-fb')!;
        const dropEl = host.querySelector('.drop-fb')!;

        dragEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        dropEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(activatedPayloads).toEqual(['fallback-item']);

        mounted.dispose();
    });

    it('updates payload reactively when Draggable data prop changes', () => {
        const itemSignal = signal<Json>({ step: 1 });
        const dropped: Json[] = [];
        const handlers = createHandlerTable('reactive-drag');
        const dropAction = handlers.on((val) => {
            if (val !== undefined) dropped.push(val);
        });

        const registry = createRegistry(PRIMITIVES);
        const view = element('Stack', {
            children: [
                element('Draggable', {
                    props: { data: () => itemSignal(), class: 'drag-rx' },
                }),
                element('DropZone', {
                    props: { class: 'drop-rx' },
                    intents: { drop: { action: dropAction } },
                }),
            ],
        });

        const dispatch = {
            dispatch(action: Action, value?: IntentValue) {
                if (action.kind === 'handler') handlers.invoke(action.id, value);
            },
        };

        const mounted = render(view, host, { components: registry, dispatch });
        const dragEl = host.querySelector('.drag-rx')!;
        const dropEl = host.querySelector('.drop-rx')!;

        // Update signal
        itemSignal.set({ step: 2 });
        tick();

        dragEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        dropEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(dropped).toEqual([{ step: 2 }]);

        mounted.dispose();
    });
});
