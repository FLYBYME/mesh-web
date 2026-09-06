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

import type { Json } from '../description/types.js';

export interface ComponentDefinition {
    readonly name: string;

    /** The host element. Called once per node instance. */
    create(): Element;

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
        const css = Object.entries(value)
            .map(([property, v]) => `${property}:${String(v)}`)
            .join(';');
        el.setAttribute('style', css);
        return;
    }

    el.setAttribute(name, String(value));
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
 * A first cut, not the audit.
 *
 * spec/roadmap.md A7.1 is the real vocabulary decision, and it is gated on the focus graph — every
 * primitive has to satisfy "every action has a non-pointer path" (spec/input.md section 3). These
 * exist so the renderer has something to render and are expected to change.
 */
export const PRIMITIVES: readonly ComponentDefinition[] = [
    tag('Stack', 'div', {
        apply(el, name, value) {
            if (name === 'gap') {
                (el as HTMLElement).style.gap = typeof value === 'number' ? `${value}px` : String(value);
                return true;
            }
            return false;
        },
    }),
    tag('Row', 'div'),
    tag('Text', 'span'),
    tag('Heading', 'h2'),
    tag('Button', 'button'),
    tag('Input', 'input', {
        spaceIsTextInput(el) {
            // Checkbox and radio inputs are toggled by Space; for text/search/password/etc., Space is text entry.
            if (!('type' in el)) return true;
            const type = (el as HTMLInputElement).type;
            return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit' && type !== 'reset';
        },
        apply(el, name, value) {
            if (!('value' in el) || !('checked' in el)) return false;
            const input = el as HTMLInputElement;

            if (name === 'value') {
                const next = value === null ? '' : String(value);
                // Assigning input.value moves the caret/cursor to the end of the text box. If the
                // signal write was triggered by an `input` event while the user is typing mid-word,
                // re-assigning .value on every keystroke throws the caret to the end of the word.
                // Checking input.value !== next is therefore a correctness requirement for cursor
                // preservation, not a performance optimization.
                if (input.value !== next) {
                    input.value = next;
                }
                return true;
            }

            if (name === 'checked') {
                const next = Boolean(value);
                // Like value, HTMLInputElement.checked has a dirty checked flag in the DOM. Once
                // toggled by the user, setAttribute('checked', ...) only updates defaultChecked,
                // leaving the live .checked unchanged. Assigning the DOM property directly fixes this.
                if (input.checked !== next) {
                    input.checked = next;
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
    tag('Form', 'form'),
    tag('List', 'ul'),
    tag('ListItem', 'li'),
    tag('Card', 'section'),
    tag('Badge', 'span'),
];
