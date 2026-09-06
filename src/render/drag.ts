/**
 * Unified Drag-and-Drop Coordinator (roadmap A7.3, spec/input.md §3).
 *
 * Core architectural principle: drag is selection (grab) followed by target (drop).
 *
 * Every interaction modality:
 * 1. Keyboard: Space/Enter on Draggable to grab -> Tab -> Space/Enter on DropZone to drop
 * 2. Mouse click: click Draggable to grab -> click DropZone to drop
 * 3. Pointer drag: HTML5 dragstart -> dragover -> drop
 *
 * All three share the exact same state machine, attributes, and drop events.
 * Escape cancels at any point in all modalities.
 */

import type { Json } from '../description/types.js';

export interface GrabbedItem {
    readonly payload?: Json;
    readonly type?: string;
    readonly element: Element;
}

let currentGrab: GrabbedItem | null = null;
let escapeListenerAttached = false;

function onDocumentKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && currentGrab !== null) {
        cancelGrab();
        e.preventDefault();
        e.stopPropagation();
    }
}

function ensureEscapeListener(): void {
    if (typeof document === 'undefined') return;
    if (!escapeListenerAttached) {
        document.addEventListener('keydown', onDocumentKeyDown, true);
        escapeListenerAttached = true;
    }
}

/** Check whether a drop zone element is able to accept the currently grabbed item. */
export function canDrop(dropZone: Element): boolean {
    if (currentGrab === null) return false;
    if (dropZone.hasAttribute('data-mesh-disabled') || dropZone.getAttribute('aria-disabled') === 'true') {
        return false;
    }

    const acceptsAttr = dropZone.getAttribute('data-mesh-accepts');
    if (acceptsAttr === null || acceptsAttr === '' || acceptsAttr === '*') {
        return true;
    }

    const accepted = acceptsAttr.split(',').map((s) => s.trim());
    const grabbedType = currentGrab.type ?? '';
    return accepted.includes(grabbedType) || accepted.includes('*');
}

/** Grab an item with a payload, optional type tag, and source element. */
export function grab(payload: Json | undefined, type: string | undefined, element: Element): void {
    if (currentGrab !== null) {
        cancelGrab();
    }

    currentGrab = { payload, type, element };
    element.setAttribute('data-mesh-grabbed', '');
    element.setAttribute('aria-grabbed', 'true');

    if (typeof document !== 'undefined') {
        const zones = document.querySelectorAll('[data-mesh-dropzone]');
        for (let i = 0; i < zones.length; i++) {
            const zone = zones.item(i);
            if (canDrop(zone)) {
                zone.setAttribute('data-mesh-drop-target', '');
                zone.setAttribute('aria-dropeffect', 'move');
            }
        }
    }

    ensureEscapeListener();
}

/** Cancel any currently active grab and restore dropzone attributes. */
export function cancelGrab(): void {
    if (currentGrab !== null) {
        currentGrab.element.removeAttribute('data-mesh-grabbed');
        currentGrab.element.setAttribute('aria-grabbed', 'false');
        currentGrab = null;
    }

    if (typeof document !== 'undefined') {
        const zones = document.querySelectorAll('[data-mesh-dropzone]');
        for (let i = 0; i < zones.length; i++) {
            const zone = zones.item(i);
            zone.removeAttribute('data-mesh-drop-target');
            zone.removeAttribute('data-mesh-drag-over');
            zone.removeAttribute('aria-dropeffect');
        }
    }
}

/**
 * Drop the currently grabbed item onto a target element.
 * Resolves the enclosing drop zone, verifies acceptance, dispatches `mesh:drop`, and clears grab.
 */
export function drop(targetElement: Element): Json | undefined {
    if (currentGrab === null) return undefined;

    const dropZone = targetElement.closest('[data-mesh-dropzone]');
    if (dropZone === null) return undefined;
    if (!canDrop(dropZone)) return undefined;

    const payload = currentGrab.payload;
    cancelGrab();

    dropZone.dispatchEvent(new CustomEvent('mesh:drop', {
        detail: payload,
        bubbles: true,
        cancelable: true,
    }));

    return payload;
}

export function getGrabbed(): GrabbedItem | null {
    return currentGrab;
}

export function isGrabbed(element: Element): boolean {
    return currentGrab !== null && currentGrab.element === element;
}

export function hasGrab(): boolean {
    return currentGrab !== null;
}

/** Reset coordinator state and detach listeners (used for test teardown and test isolation). */
export function reset(): void {
    cancelGrab();
    if (typeof document !== 'undefined' && escapeListenerAttached) {
        document.removeEventListener('keydown', onDocumentKeyDown, true);
        escapeListenerAttached = false;
    }
}
