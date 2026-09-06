/**
 * Components: the vocabulary an Application is allowed to name.
 *
 * spec/view-layer.md section 3. An Application writes `Stack`, `Text`, `Button` — never `div`. This
 * file is where a name becomes an element, and it is deliberately the *only* place in the package
 * below the renderer that knows an element exists.
 *
 * The framework ships primitives; an Extension contributes the rest (view-layer section 3), which is
 * what lets a design system ship separately and a site restyle without touching an Application.
 */

import type { Json, Props } from '../description/types.js';
import { read } from '../description/types.js';
import { canDrop, cancelGrab, drop, grab, hasGrab, isGrabbed } from './drag.js';

export interface ComponentDefinition {
    readonly name: string;

    /** The host element. Called once per node instance. */
    create(props?: Props): Element;

    /**
     * Apply one prop. Called at construction, and again whenever a reactive prop changes.
     *
     * Returning false means "not mine" and falls through to the default handling, so a component
     * only has to describe the props it treats specially.
     */
    apply?(el: Element, name: string, value: Json): boolean | void;

    /** Where children are appended, if not the host element itself. */
    slot?(el: Element): Element;

    /**
     * Whether Space typed into this element counts as text input rather than the `activate` intent.
     *
     * spec/input.md §3 requires every action to have a non-pointer path (so Space activating a button
     * is part of how that holds). But on an element where Space is text entry, pressing Space mid-word
     * must enter a space rather than firing `activate` (roadmap A7.0b).
     *
     * This knowledge belongs on ComponentDefinition rather than as a hardcoded tag-name list in
     * `bindIntents`: components understand their own input semantics, and Extension-contributed
     * custom editors or inputs can declare this without modifying the renderer.
     */
    readonly spaceIsTextInput?: boolean | ((el: Element) => boolean);
}

export interface ComponentRegistry {
    get(name: string): ComponentDefinition | undefined;
    register(definition: ComponentDefinition): void;
    readonly names: readonly string[];
}

export function createRegistry(definitions: readonly ComponentDefinition[] = []): ComponentRegistry {
    const map = new Map<string, ComponentDefinition>();
    for (const d of definitions) map.set(d.name, d);

    return {
        get: (name) => map.get(name),
        register(definition) {
            const existing = map.get(definition.name);
            if (existing !== undefined) {
                throw new Error(
                    `Component "${definition.name}" is already registered. ` +
                    `Two contributors claiming one name is a conflict to resolve at load time, ` +
                    `not a last-one-wins.`,
                );
            }
            map.set(definition.name, definition);
        },
        get names(): readonly string[] {
            return [...map.keys()].sort();
        },
    };
}

// ---------------------------------------------------------------------------- element type guards (zero casts)

interface StyleElement {
    style: CSSStyleDeclaration;
}

function hasStyle(el: object): el is StyleElement {
    return 'style' in el && typeof el.style === 'object' && el.style !== null;
}

interface ValueElement {
    value: string;
}

function hasValue(el: object): el is ValueElement {
    return 'value' in el && typeof el.value === 'string';
}

interface CheckedElement {
    checked: boolean;
}

function hasChecked(el: object): el is CheckedElement {
    return 'checked' in el && typeof el.checked === 'boolean';
}

interface TypedElement {
    type: string;
}

function hasType(el: object): el is TypedElement {
    return 'type' in el && typeof el.type === 'string';
}

interface ScrollableElement {
    scrollHeight: number;
    clientHeight: number;
    scrollWidth: number;
    clientWidth: number;
    scrollTop: number;
    scrollLeft: number;
    tabIndex: number;
    hasAttribute(name: string): boolean;
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
}

function isScrollableElement(el: object): el is ScrollableElement {
    return 'scrollHeight' in el && typeof el.scrollHeight === 'number' &&
           'clientHeight' in el && typeof el.clientHeight === 'number' &&
           'scrollWidth' in el && typeof el.scrollWidth === 'number' &&
           'clientWidth' in el && typeof el.clientWidth === 'number' &&
           'scrollTop' in el && typeof el.scrollTop === 'number' &&
           'scrollLeft' in el && typeof el.scrollLeft === 'number' &&
           'tabIndex' in el && typeof el.tabIndex === 'number' &&
           'hasAttribute' in el && typeof el.hasAttribute === 'function' &&
           'getAttribute' in el && typeof el.getAttribute === 'function' &&
           'setAttribute' in el && typeof el.setAttribute === 'function' &&
           'removeAttribute' in el && typeof el.removeAttribute === 'function';
}

function updateScrollability(el: Element): void {
    if (!isScrollableElement(el)) return;
    const overflows = el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;
    if (overflows) {
        if (!el.hasAttribute('tabindex')) {
            el.tabIndex = 0;
            el.setAttribute('data-mesh-scroll-tabindex', 'auto');
        }
        if (!el.hasAttribute('role')) {
            el.setAttribute('role', 'region');
        }
        if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) {
            el.setAttribute('aria-label', 'Scrollable content');
        }
    } else {
        if (el.getAttribute('data-mesh-scroll-tabindex') === 'auto') {
            el.removeAttribute('tabindex');
            el.removeAttribute('data-mesh-scroll-tabindex');
            if (el.getAttribute('role') === 'region') {
                el.removeAttribute('role');
            }
            if (el.getAttribute('aria-label') === 'Scrollable content') {
                el.removeAttribute('aria-label');
            }
        }
    }
}

function applyScrollPosition(el: Element, value: Json): void {
    if (!isScrollableElement(el)) return;
    if (value === 'bottom' || value === 'end') {
        el.scrollTop = el.scrollHeight;
        el.scrollLeft = el.scrollWidth;
    } else if (value === 'top' || value === 'start') {
        el.scrollTop = 0;
        el.scrollLeft = 0;
    } else if (typeof value === 'number') {
        el.scrollTop = value;
    }
}

// ---------------------------------------------------------------------------- default prop handling

/**
 * What every component gets for free.
 *
 * Kept small on purpose: a prop that means something specific to a component belongs in that
 * component's `apply`, not here, or the default becomes a second uncontrolled vocabulary.
 */
export function applyDefaultProp(el: Element, name: string, value: Json): void {
    if (value === null || value === false) {
        el.removeAttribute(name);
        return;
    }

    if (value === true) {
        el.setAttribute(name, '');
        return;
    }

    if (name === 'style' && typeof value === 'object' && !Array.isArray(value)) {
        /**
         * **`flexDirection` is not a CSS property, and this used to emit it anyway.**
         *
         * The object was serialised key-for-key, so every camelCase name — `flexDirection`,
         * `borderBottom`, `overflowX`, `minHeight` — reached the browser as an unknown declaration
         * and was *silently dropped*. The lowercase ones beside it worked, which is what made it so
         * hard to see: `{ display: 'flex', flexDirection: 'column' }` applied the `display` and
         * ignored the direction, leaving a row that looked like a styling mistake rather than a
         * renderer bug.
         *
         * Found writing the first page chrome. `display:flex` without its direction laid the title
         * bar beside the window area instead of above it, and the window host got whatever width was
         * left over — 469px of 1400. Two version bumps went into chasing it as a CSS problem.
         *
         * A custom property (`--ink`) is passed through untouched: it is already the case-sensitive
         * name the author meant, and hyphenating it would break it.
         */
        const cssName = (property: string): string => (property.startsWith('--')
            ? property
            : property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));

        const css = Object.entries(value)
            .map(([property, v]) => `${cssName(property)}:${String(v)}`)
            .join(';');
        el.setAttribute('style', css);
        return;
    }

    el.setAttribute(name, String(value));
}

// ---------------------------------------------------------------------------- drag & drop helpers

interface DraggableState {
    data?: Json;
    type?: string;
    disabled?: boolean;
}

const draggableStates = new WeakMap<Element, DraggableState>();

interface DropZoneState {
    accepts?: string[];
    disabled?: boolean;
}

const dropZoneStates = new WeakMap<Element, DropZoneState>();

function isInteractiveChild(target: EventTarget | null, root: Element): boolean {
    if (!(target instanceof Element)) return false;
    const interactive = target.closest('button, input, textarea, select, a');
    return interactive !== null && interactive !== root && root.contains(interactive);
}

// ---------------------------------------------------------------------------- primitives

/** A tag, plus an optional prop mapping. The shorthand most primitives need. */
function tag(name: string, tagName: string, extra?: Partial<ComponentDefinition>): ComponentDefinition {
    return {
        name,
        create: () => document.createElement(tagName),
        ...extra,
    };
}

/**
 * The primitive component vocabulary (spec/roadmap.md A7.3).
 *
 * Every primitive satisfies "every action has a non-pointer path" (spec/input.md §3).
 * Primitives understand their own DOM properties and semantics (such as dirty value flags,
 * keyboard accessibility, and semantic heading tags) while preserving fine-grained reactivity.
 */
export const PRIMITIVES: readonly ComponentDefinition[] = [
    tag('Stack', 'div', {
        apply(el, name, value) {
            if (name === 'gap') {
                if (hasStyle(el)) {
                    el.style.gap = typeof value === 'number' ? `${value}px` : String(value);
                }
                return true;
            }
            return false;
        },
    }),
    tag('Row', 'div'),
    tag('Text', 'span'),
    {
        name: 'Dialog',
        spaceIsTextInput: false,
        create() {
            const el = document.createElement('dialog');
            el.setAttribute('data-mesh-dialog', '');
            return el;
        },
        apply(_el, name) {
            if (name === 'open') return true;
            return false;
        },
    },
    {
        name: 'Heading',
        create(props) {
            const raw = props?.level !== undefined ? read(props.level) : undefined;
            const lvl = typeof raw === 'number' ? raw : (typeof raw === 'string' ? parseInt(raw, 10) : 2);
            const tag = Number.isInteger(lvl) && lvl >= 1 && lvl <= 6 ? `h${lvl}` : 'h2';
            return document.createElement(tag);
        },
        apply(_el, name) {
            if (name === 'level') return true;
            return false;
        },
    },
    tag('Button', 'button'),
    tag('Input', 'input', {
        spaceIsTextInput(el) {
            // Checkbox and radio inputs are toggled by Space; for text/search/password/etc., Space is text entry.
            if (!hasType(el)) return true;
            const type = el.type;
            return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'reset';
        },
        apply(el, name, value) {
            if (name === 'value') {
                if (!hasValue(el)) return false;
                const next = value === null ? '' : String(value);
                // Assigning input.value moves the caret/cursor to the end of the text box. If the
                // signal write was triggered by an `input` event while the user is typing mid-word,
                // re-assigning .value on every keystroke throws the caret to the end of the word.
                // Checking input.value !== next is therefore a correctness requirement for cursor
                // preservation, not a performance optimization.
                if (el.value !== next) {
                    el.value = next;
                }
                return true;
            }

            if (name === 'checked') {
                if (!hasChecked(el)) return false;
                const next = Boolean(value);
                // Like value, HTMLInputElement.checked has a dirty checked flag in the DOM. Once
                // toggled by the user, setAttribute('checked', ...) only updates defaultChecked,
                // leaving the live .checked unchanged. Assigning the DOM property directly fixes this.
                if (el.checked !== next) {
                    el.checked = next;
                }
                return true;
            }

            // Note on other DOM properties with dirty flags (roadmap A7.0):
            // `selected` on an <option> and `indeterminate` on a checkbox cannot arise here yet.
            // There is currently no Option or Select primitive, and `indeterminate` is not yet
            // declared in the primitive vocabulary (which is deferred to the A7.1 audit).
            // They are deliberately omitted rather than added speculatively.

            return false;
        },
    }),
    tag('TextArea', 'textarea', {
        spaceIsTextInput: true,
        apply(el, name, value) {
            if (name === 'value') {
                if (!hasValue(el)) return false;
                const next = value === null ? '' : String(value);
                // HTMLTextAreaElement has the same dirty value flag as HTMLInputElement (roadmap A7.0).
                // Once edited by the user, setAttribute('value', ...) has no effect on visible text.
                // Direct property assignment is required, and checking el.value !== next prevents
                // caret jumping mid-word on reactive updates while typing.
                if (el.value !== next) {
                    el.value = next;
                }
                return true;
            }
            return false;
        },
    }),
    tag('ScrollView', 'div', {
        create() {
            const el = document.createElement('div');
            el.setAttribute('data-mesh-scrollview', '');
            if (hasStyle(el)) {
                el.style.overflowY = 'auto';
                el.style.overflowX = 'hidden';
                el.style.boxSizing = 'border-box';
            }
            if (typeof MutationObserver === 'function') {
                const observer = new MutationObserver(() => {
                    updateScrollability(el);
                    const autoScroll = el.getAttribute('data-mesh-autoscroll');
                    if (autoScroll !== null) {
                        applyScrollPosition(el, autoScroll);
                    }
                });
                observer.observe(el, { childList: true, subtree: true, characterData: true });
            }
            if (typeof ResizeObserver === 'function') {
                const ro = new ResizeObserver(() => {
                    updateScrollability(el);
                });
                ro.observe(el);
            }
            el.addEventListener('pointerenter', () => updateScrollability(el));
            el.addEventListener('focus', () => updateScrollability(el));
            el.addEventListener('scroll', () => updateScrollability(el));
            queueMicrotask(() => updateScrollability(el));
            return el;
        },
        apply(el, name, value) {
            if (name === 'orientation') {
                if (hasStyle(el)) {
                    const val = String(value);
                    if (val === 'horizontal') {
                        el.style.overflowX = 'auto';
                        el.style.overflowY = 'hidden';
                    } else if (val === 'both') {
                        el.style.overflowX = 'auto';
                        el.style.overflowY = 'auto';
                    } else {
                        el.style.overflowX = 'hidden';
                        el.style.overflowY = 'auto';
                    }
                }
                queueMicrotask(() => updateScrollability(el));
                return true;
            }
            if (name === 'maxHeight') {
                if (hasStyle(el)) {
                    el.style.maxHeight = typeof value === 'number' ? `${value}px` : String(value);
                }
                queueMicrotask(() => updateScrollability(el));
                return true;
            }
            if (name === 'maxWidth') {
                if (hasStyle(el)) {
                    el.style.maxWidth = typeof value === 'number' ? `${value}px` : String(value);
                }
                queueMicrotask(() => updateScrollability(el));
                return true;
            }
            if (name === 'height') {
                if (hasStyle(el)) {
                    el.style.height = typeof value === 'number' ? `${value}px` : String(value);
                }
                queueMicrotask(() => updateScrollability(el));
                return true;
            }
            if (name === 'width') {
                if (hasStyle(el)) {
                    el.style.width = typeof value === 'number' ? `${value}px` : String(value);
                }
                queueMicrotask(() => updateScrollability(el));
                return true;
            }
            if (name === 'autoScroll') {
                if (value === null || value === false) {
                    el.removeAttribute('data-mesh-autoscroll');
                } else {
                    el.setAttribute('data-mesh-autoscroll', String(value));
                    queueMicrotask(() => applyScrollPosition(el, value));
                }
                return true;
            }
            if (name === 'scrollTo') {
                queueMicrotask(() => applyScrollPosition(el, value));
                return true;
            }
            return false;
        },
    }),
    tag('Grid', 'div', {
        create() {
            const el = document.createElement('div');
            el.setAttribute('data-mesh-grid', '');
            if (hasStyle(el)) {
                el.style.display = 'grid';
                el.style.boxSizing = 'border-box';
            }
            return el;
        },
        apply(el, name, value) {
            if (!hasStyle(el)) return false;
            if (name === 'columns') {
                el.style.gridTemplateColumns = typeof value === 'number'
                    ? `repeat(${value}, minmax(0, 1fr))`
                    : String(value);
                return true;
            }
            if (name === 'rows') {
                el.style.gridTemplateRows = typeof value === 'number'
                    ? `repeat(${value}, minmax(0, 1fr))`
                    : String(value);
                return true;
            }
            if (name === 'gap') {
                el.style.gap = typeof value === 'number' ? `${value}px` : String(value);
                return true;
            }
            if (name === 'columnGap') {
                el.style.columnGap = typeof value === 'number' ? `${value}px` : String(value);
                return true;
            }
            if (name === 'rowGap') {
                el.style.rowGap = typeof value === 'number' ? `${value}px` : String(value);
                return true;
            }
            if (name === 'alignItems') {
                el.style.alignItems = String(value);
                return true;
            }
            if (name === 'justifyItems') {
                el.style.justifyItems = String(value);
                return true;
            }
            if (name === 'alignContent') {
                el.style.alignContent = String(value);
                return true;
            }
            if (name === 'justifyContent') {
                el.style.justifyContent = String(value);
                return true;
            }
            if (name === 'autoFlow') {
                el.style.gridAutoFlow = String(value);
                return true;
            }
            if (name === 'areas') {
                el.style.gridTemplateAreas = String(value);
                return true;
            }
            return false;
        },
    }),
    tag('Divider', 'hr', {
        apply(el, name, value) {
            if (name === 'orientation') {
                const isVertical = String(value) === 'vertical';
                if (isVertical) {
                    el.setAttribute('data-orientation', 'vertical');
                    if (hasStyle(el)) {
                        el.style.borderTop = '0';
                        el.style.borderLeft = '1px solid var(--edge, #30363d)';
                        el.style.height = '100%';
                        el.style.width = '0';
                        el.style.display = 'inline-block';
                    }
                } else {
                    el.setAttribute('data-orientation', 'horizontal');
                    if (hasStyle(el)) {
                        el.style.borderTop = '1px solid var(--edge, #30363d)';
                        el.style.borderLeft = '0';
                        el.style.height = '0';
                        el.style.width = '100%';
                        el.style.display = 'block';
                    }
                }
                return true;
            }
            return false;
        },
    }),
    tag('Span', 'span', {
        apply(el, name, value) {
            if (name === 'bold') {
                if (hasStyle(el)) {
                    el.style.fontWeight = value ? '600' : 'normal';
                }
                return true;
            }
            if (name === 'italic') {
                if (hasStyle(el)) {
                    el.style.fontStyle = value ? 'italic' : 'normal';
                }
                return true;
            }
            if (name === 'code') {
                if (value) {
                    el.setAttribute('data-code', '');
                } else {
                    el.removeAttribute('data-code');
                }
                return true;
            }
            if (name === 'color') {
                if (hasStyle(el)) {
                    el.style.color = String(value);
                }
                return true;
            }
            if (name === 'size') {
                if (hasStyle(el)) {
                    el.style.fontSize = typeof value === 'number' ? `${value}px` : String(value);
                }
                return true;
            }
            return false;
        },
    }),
    tag('Form', 'form'),
    tag('List', 'ul'),
    tag('ListItem', 'li'),
    tag('Card', 'section'),
    tag('Badge', 'span'),
    {
        name: 'Draggable',
        spaceIsTextInput: false,
        create() {
            const el = document.createElement('div');
            el.setAttribute('data-mesh-draggable', '');
            el.setAttribute('tabindex', '0');
            el.setAttribute('role', 'button');
            el.setAttribute('aria-grabbed', 'false');
            el.setAttribute('draggable', 'true');

            el.addEventListener('click', (e) => {
                if (isInteractiveChild(e.target, el)) return;
                const state = draggableStates.get(el);
                if (state?.disabled) return;

                e.preventDefault();
                e.stopPropagation();

                if (isGrabbed(el)) {
                    cancelGrab();
                } else {
                    grab(state?.data, state?.type, el);
                }
            });

            el.addEventListener('keydown', (e) => {
                if (isInteractiveChild(e.target, el)) return;
                const state = draggableStates.get(el);
                if (state?.disabled) return;

                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();

                    if (isGrabbed(el)) {
                        cancelGrab();
                    } else {
                        grab(state?.data, state?.type, el);
                    }
                }
            });

            el.addEventListener('dragstart', (e) => {
                const state = draggableStates.get(el);
                if (state?.disabled) {
                    e.preventDefault();
                    return;
                }
                grab(state?.data, state?.type, el);
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    try {
                        const json = JSON.stringify(state?.data);
                        e.dataTransfer.setData('application/json', json);
                        e.dataTransfer.setData('text/plain', typeof state?.data === 'string' ? state.data : json);
                    } catch {
                        // In case payload cannot be stringified
                    }
                }
            });

            el.addEventListener('dragend', () => {
                if (isGrabbed(el)) {
                    cancelGrab();
                }
            });

            return el;
        },
        apply(el, name, value) {
            if (name === 'data') {
                const state = draggableStates.get(el) ?? {};
                state.data = value;
                draggableStates.set(el, state);
                return true;
            }
            if (name === 'type') {
                const state = draggableStates.get(el) ?? {};
                state.type = typeof value === 'string' ? value : undefined;
                draggableStates.set(el, state);
                if (state.type !== undefined) {
                    el.setAttribute('data-mesh-type', state.type);
                } else {
                    el.removeAttribute('data-mesh-type');
                }
                return true;
            }
            if (name === 'disabled') {
                const state = draggableStates.get(el) ?? {};
                state.disabled = Boolean(value);
                draggableStates.set(el, state);
                if (state.disabled) {
                    el.setAttribute('data-mesh-disabled', '');
                    el.setAttribute('aria-disabled', 'true');
                    el.setAttribute('draggable', 'false');
                    el.removeAttribute('tabindex');
                } else {
                    el.removeAttribute('data-mesh-disabled');
                    el.removeAttribute('aria-disabled');
                    el.setAttribute('draggable', 'true');
                    el.setAttribute('tabindex', '0');
                }
                return true;
            }
            return false;
        },
    },
    {
        name: 'DropZone',
        spaceIsTextInput: false,
        create() {
            const el = document.createElement('div');
            el.setAttribute('data-mesh-dropzone', '');
            el.setAttribute('tabindex', '0');
            el.setAttribute('role', 'region');
            el.setAttribute('aria-label', 'Drop zone');

            el.addEventListener('click', (e) => {
                if (isInteractiveChild(e.target, el)) return;
                const state = dropZoneStates.get(el);
                if (state?.disabled) return;

                if (hasGrab() && canDrop(el)) {
                    e.preventDefault();
                    e.stopPropagation();
                    drop(el);
                }
            });

            el.addEventListener('keydown', (e) => {
                if (isInteractiveChild(e.target, el)) return;
                const state = dropZoneStates.get(el);
                if (state?.disabled) return;

                if (e.key === 'Enter' || e.key === ' ') {
                    if (hasGrab() && canDrop(el)) {
                        e.preventDefault();
                        e.stopPropagation();
                        drop(el);
                    }
                }
            });

            el.addEventListener('dragover', (e) => {
                const state = dropZoneStates.get(el);
                if (state?.disabled) return;

                if (canDrop(el)) {
                    e.preventDefault();
                    if (e.dataTransfer) {
                        e.dataTransfer.dropEffect = 'move';
                    }
                    el.setAttribute('data-mesh-drag-over', '');
                }
            });

            el.addEventListener('dragleave', (e) => {
                if (!(e.relatedTarget instanceof Node) || !el.contains(e.relatedTarget)) {
                    el.removeAttribute('data-mesh-drag-over');
                }
            });

            el.addEventListener('drop', (e) => {
                const state = dropZoneStates.get(el);
                if (state?.disabled) return;

                if (canDrop(el)) {
                    e.preventDefault();
                    drop(el);
                }
            });

            return el;
        },
        apply(el, name, value) {
            if (name === 'accepts') {
                const state = dropZoneStates.get(el) ?? {};
                if (Array.isArray(value)) {
                    state.accepts = value.map(String);
                    el.setAttribute('data-mesh-accepts', state.accepts.join(','));
                } else if (value !== null && value !== undefined) {
                    state.accepts = [String(value)];
                    el.setAttribute('data-mesh-accepts', String(value));
                } else {
                    state.accepts = undefined;
                    el.removeAttribute('data-mesh-accepts');
                }
                dropZoneStates.set(el, state);
                return true;
            }
            if (name === 'disabled') {
                const state = dropZoneStates.get(el) ?? {};
                state.disabled = Boolean(value);
                dropZoneStates.set(el, state);
                if (state.disabled) {
                    el.setAttribute('data-mesh-disabled', '');
                    el.setAttribute('aria-disabled', 'true');
                    el.removeAttribute('tabindex');
                } else {
                    el.removeAttribute('data-mesh-disabled');
                    el.removeAttribute('aria-disabled');
                    el.setAttribute('tabindex', '0');
                }
                return true;
            }
            return false;
        },
    },
];
