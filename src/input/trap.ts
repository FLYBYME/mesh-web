/**
 * Focus containment and trap management.
 *
 * spec/input.md "Traps":
 * "A modal traps focus. A window in windowed mode traps until dismissed at the window-manager level.
 * Focus is renderer state, not application state, and not view state in the geometry sense. It is
 * per view instance, restored with it, and moved by the kernel — never set by an Application."
 *
 * A trap ensures:
 * 1. Focus enters the container on open (prioritizing [autofocus], then first focusable, then container).
 * 2. Tab and Shift+Tab cycle exclusively within the container's focusable elements.
 * 3. Focus cannot escape to controls behind the dialog.
 * 4. Closing restores focus to whatever element opened it.
 * 5. Traps form a stack: a nested dialog traps until closed, then restores focus and reactivates the parent trap.
 */

export interface FocusableElement extends Element {
    focus(options?: FocusOptions): void;
}

export function isFocusableElement(target: unknown): target is FocusableElement {
    if (!(target instanceof Element)) return false;
    return 'focus' in target && typeof target.focus === 'function';
}

const FOCUSABLE_SELECTOR = [
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"]):not([disabled])',
    '[contenteditable]:not([contenteditable="false"])',
].join(', ');

function isVisible(el: FocusableElement): boolean {
    if (el.hasAttribute('hidden')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    return true;
}

function isDisabled(el: FocusableElement): boolean {
    if (el.hasAttribute('disabled')) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    if ('disabled' in el && el.disabled === true) return true;
    return false;
}

export function getFocusableElements(container: Element): readonly FocusableElement[] {
    const matched = container.querySelectorAll(FOCUSABLE_SELECTOR);
    const result: FocusableElement[] = [];

    for (let i = 0; i < matched.length; i++) {
        const item = matched[i];
        if (item && isFocusableElement(item) && isVisible(item) && !isDisabled(item)) {
            result.push(item);
        }
    }

    return result;
}

export interface FocusTrap {
    activate(): void;
    deactivate(): void;
    readonly active: boolean;
    readonly container: Element;
}

const trapStack: FocusTrap[] = [];

export function getActiveTrap(): FocusTrap | undefined {
    return trapStack.length > 0 ? trapStack[trapStack.length - 1] : undefined;
}

export function createFocusTrap(container: Element): FocusTrap {
    let active = false;
    let opener: FocusableElement | undefined;

    const onKeyDown = (e: KeyboardEvent): void => {
        if (!active) return;
        if (getActiveTrap() !== trap) return;
        if (e.key !== 'Tab') return;

        const focusables = getFocusableElements(container);
        if (focusables.length === 0) {
            e.preventDefault();
            if (isFocusableElement(container)) {
                container.focus();
            }
            return;
        }

        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const current = document.activeElement;

        if (e.shiftKey) {
            if (current === first || !container.contains(current)) {
                e.preventDefault();
                last?.focus();
            }
        } else {
            if (current === last || !container.contains(current)) {
                e.preventDefault();
                first?.focus();
            }
        }
    };

    const onFocusIn = (e: FocusEvent): void => {
        if (!active) return;
        if (getActiveTrap() !== trap) return;

        const target = e.target;
        if (target instanceof Node && !container.contains(target)) {
            e.preventDefault();
            const focusables = getFocusableElements(container);
            if (focusables.length > 0 && focusables[0] !== undefined) {
                focusables[0].focus();
            } else if (isFocusableElement(container)) {
                container.focus();
            }
        }
    };

    const trap: FocusTrap = {
        get active(): boolean {
            return active;
        },
        get container(): Element {
            return container;
        },
        activate(): void {
            if (active) return;
            active = true;

            const currentActive = document.activeElement;
            if (isFocusableElement(currentActive)) {
                opener = currentActive;
            }

            trapStack.push(trap);

            document.addEventListener('keydown', onKeyDown, true);
            document.addEventListener('focusin', onFocusIn, true);

            // Move initial focus into the container
            const autofocusTarget = container.querySelector('[autofocus]');
            if (autofocusTarget && isFocusableElement(autofocusTarget) && isVisible(autofocusTarget) && !isDisabled(autofocusTarget)) {
                autofocusTarget.focus();
            } else {
                const focusables = getFocusableElements(container);
                if (focusables.length > 0 && focusables[0] !== undefined) {
                    focusables[0].focus();
                } else if (isFocusableElement(container)) {
                    if (!container.hasAttribute('tabindex')) {
                        container.setAttribute('tabindex', '-1');
                    }
                    container.focus();
                }
            }
        },
        deactivate(): void {
            if (!active) return;
            active = false;

            document.removeEventListener('keydown', onKeyDown, true);
            document.removeEventListener('focusin', onFocusIn, true);

            const index = trapStack.indexOf(trap);
            if (index !== -1) {
                trapStack.splice(index, 1);
            }

            // Restore focus to opener
            if (opener && isFocusableElement(opener)) {
                const isConnected = opener.isConnected !== undefined ? opener.isConnected : true;
                if (isConnected) {
                    opener.focus();
                }
            }
            opener = undefined;
        },
    };

    return trap;
}
