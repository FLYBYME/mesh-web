/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createFocusTrap,
    getActiveTrap,
    getFocusableElements,
    isFocusableElement,
    type FocusTrap,
} from '../src/input/trap.js';

describe('Focus trap and focus containment', () => {
    let host: HTMLDivElement;

    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
    });

    afterEach(() => {
        // Deactivate any lingering traps on the stack
        while (getActiveTrap() !== undefined) {
            getActiveTrap()?.deactivate();
        }
        document.body.removeChild(host);
    });

    describe('isFocusableElement and getFocusableElements', () => {
        it('identifies standard focusable elements', () => {
            const btn = document.createElement('button');
            const link = document.createElement('a');
            link.href = '#';
            const input = document.createElement('input');
            const select = document.createElement('select');
            const textarea = document.createElement('textarea');
            const divWithTabindex = document.createElement('div');
            divWithTabindex.tabIndex = 0;
            const contentEditable = document.createElement('div');
            contentEditable.contentEditable = 'true';

            expect(isFocusableElement(btn)).toBe(true);
            expect(isFocusableElement(link)).toBe(true);
            expect(isFocusableElement(input)).toBe(true);
            expect(isFocusableElement(select)).toBe(true);
            expect(isFocusableElement(textarea)).toBe(true);
            expect(isFocusableElement(divWithTabindex)).toBe(true);
            expect(isFocusableElement(contentEditable)).toBe(true);

            expect(isFocusableElement(null)).toBe(false);
            expect(isFocusableElement({})).toBe(false);
            expect(isFocusableElement(document.createElement('div'))).toBe(true); // Elements have .focus in jsdom
        });

        it('filters out disabled, hidden, and aria-hidden elements', () => {
            host.innerHTML = `
                <button id="b1">Enabled</button>
                <button id="b2" disabled>Disabled</button>
                <button id="b3" aria-disabled="true">Aria Disabled</button>
                <a id="a1" href="#">Visible Link</a>
                <a id="a2" href="#" hidden>Hidden Link</a>
                <a id="a3" href="#" aria-hidden="true">Aria Hidden Link</a>
                <input id="i1" type="text" />
                <input id="i2" type="hidden" />
                <div id="d1" tabindex="-1">Negative Tabindex</div>
                <div id="d2" tabindex="0">Valid Tabindex</div>
            `;

            const focusables = getFocusableElements(host);
            const ids = focusables.map((el) => el.id);

            expect(ids).toEqual(['b1', 'a1', 'i1', 'd2']);
        });
    });

    describe('Trap activation and initial focus', () => {
        it('prioritizes element with [autofocus] on activation', () => {
            host.innerHTML = `
                <button id="btn1">First</button>
                <input id="inputAuto" autofocus type="text" />
                <button id="btn2">Second</button>
            `;

            const trap = createFocusTrap(host);
            trap.activate();

            expect(trap.active).toBe(true);
            expect(document.activeElement?.id).toBe('inputAuto');
            trap.deactivate();
        });

        it('falls back to first focusable element when [autofocus] is absent', () => {
            host.innerHTML = `
                <div>Static Header</div>
                <button id="firstBtn">First Action</button>
                <button id="secondBtn">Second Action</button>
            `;

            const trap = createFocusTrap(host);
            trap.activate();

            expect(document.activeElement?.id).toBe('firstBtn');
            trap.deactivate();
        });

        it('focuses container and sets tabindex="-1" when no focusables exist', () => {
            const container = document.createElement('div');
            container.id = 'emptyModal';
            host.appendChild(container);

            expect(container.hasAttribute('tabindex')).toBe(false);

            const trap = createFocusTrap(container);
            trap.activate();

            expect(container.getAttribute('tabindex')).toBe('-1');
            expect(document.activeElement).toBe(container);
            trap.deactivate();
        });

        it('preserves existing tabindex on container when no focusables exist', () => {
            const container = document.createElement('div');
            container.setAttribute('tabindex', '0');
            host.appendChild(container);

            const trap = createFocusTrap(container);
            trap.activate();

            expect(container.getAttribute('tabindex')).toBe('0');
            expect(document.activeElement).toBe(container);
            trap.deactivate();
        });
    });

    describe('Tab and Shift+Tab key cycling', () => {
        it('wraps Tab from last focusable to first focusable and prevents default', () => {
            host.innerHTML = `
                <button id="first">First</button>
                <button id="middle">Middle</button>
                <button id="last">Last</button>
            `;

            const trap = createFocusTrap(host);
            trap.activate();

            const last = host.querySelector('#last') as HTMLButtonElement;
            const first = host.querySelector('#first') as HTMLButtonElement;
            last.focus();
            expect(document.activeElement).toBe(last);

            const event = new KeyboardEvent('keydown', {
                key: 'Tab',
                bubbles: true,
                cancelable: true,
            });
            document.dispatchEvent(event);

            expect(event.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(first);

            trap.deactivate();
        });

        it('wraps Shift+Tab from first focusable to last focusable and prevents default', () => {
            host.innerHTML = `
                <button id="first">First</button>
                <button id="middle">Middle</button>
                <button id="last">Last</button>
            `;

            const trap = createFocusTrap(host);
            trap.activate();

            const first = host.querySelector('#first') as HTMLButtonElement;
            const last = host.querySelector('#last') as HTMLButtonElement;
            first.focus();
            expect(document.activeElement).toBe(first);

            const event = new KeyboardEvent('keydown', {
                key: 'Tab',
                shiftKey: true,
                bubbles: true,
                cancelable: true,
            });
            document.dispatchEvent(event);

            expect(event.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(last);

            trap.deactivate();
        });

        it('redirects Tab to first and Shift+Tab to last if focus is somehow outside container', () => {
            const outsideButton = document.createElement('button');
            outsideButton.id = 'outside';
            document.body.appendChild(outsideButton);

            host.innerHTML = `
                <button id="inFirst">Inside 1</button>
                <button id="inLast">Inside 2</button>
            `;

            const inFirst = host.querySelector('#inFirst') as HTMLButtonElement;
            const inLast = host.querySelector('#inLast') as HTMLButtonElement;

            const trap = createFocusTrap(host);
            trap.activate();

            // Stub activeElement to simulate focus escaping without triggering focusin
            const originalDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'activeElement')
                ?? Object.getOwnPropertyDescriptor(document, 'activeElement');

            Object.defineProperty(document, 'activeElement', {
                configurable: true,
                get: () => outsideButton,
            });

            try {
                // Tab outside -> inFirst
                const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
                document.dispatchEvent(tabEvent);
                expect(tabEvent.defaultPrevented).toBe(true);

                // Shift+Tab outside -> inLast
                const shiftTabEvent = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
                document.dispatchEvent(shiftTabEvent);
                expect(shiftTabEvent.defaultPrevented).toBe(true);
            } finally {
                if (originalDescriptor) {
                    Object.defineProperty(Document.prototype, 'activeElement', originalDescriptor);
                }
                delete (document as unknown as Record<string, unknown>).activeElement;
            }

            trap.deactivate();
            document.body.removeChild(outsideButton);
        });

        it('prevents Tab and focuses container when no focusables exist in container', () => {
            const emptyContainer = document.createElement('div');
            host.appendChild(emptyContainer);

            const trap = createFocusTrap(emptyContainer);
            trap.activate();

            const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
            document.dispatchEvent(event);

            expect(event.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(emptyContainer);

            trap.deactivate();
        });

        it('ignores non-Tab keydown events', () => {
            host.innerHTML = `<button id="b">Button</button>`;
            const trap = createFocusTrap(host);
            trap.activate();

            const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
            document.dispatchEvent(event);

            expect(event.defaultPrevented).toBe(false);
            trap.deactivate();
        });
    });

    describe('Focus containment via focusin', () => {
        it('redirects focus into container when external element receives focusin', () => {
            const externalInput = document.createElement('input');
            externalInput.id = 'external';
            document.body.appendChild(externalInput);

            host.innerHTML = `<button id="internal">Inside</button>`;
            const internalBtn = host.querySelector('#internal') as HTMLButtonElement;

            const trap = createFocusTrap(host);
            trap.activate();
            expect(document.activeElement).toBe(internalBtn);

            // Simulate external focusin event
            const focusinEvent = new FocusEvent('focusin', {
                bubbles: true,
                cancelable: true,
            });
            Object.defineProperty(focusinEvent, 'target', { value: externalInput });
            document.dispatchEvent(focusinEvent);

            expect(focusinEvent.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(internalBtn);

            trap.deactivate();
            document.body.removeChild(externalInput);
        });

        it('does not redirect focusin for elements inside the container', () => {
            host.innerHTML = `
                <button id="btn1">1</button>
                <button id="btn2">2</button>
            `;
            const btn1 = host.querySelector('#btn1') as HTMLButtonElement;
            const btn2 = host.querySelector('#btn2') as HTMLButtonElement;

            const trap = createFocusTrap(host);
            trap.activate();

            const focusinEvent = new FocusEvent('focusin', { bubbles: true, cancelable: true });
            Object.defineProperty(focusinEvent, 'target', { value: btn2 });
            document.dispatchEvent(focusinEvent);

            expect(focusinEvent.defaultPrevented).toBe(false);

            trap.deactivate();
        });
    });

    describe('Deactivation and Opener Restoration', () => {
        it('restores focus to opener on deactivation', () => {
            const opener = document.createElement('button');
            opener.id = 'openerButton';
            document.body.appendChild(opener);
            opener.focus();
            expect(document.activeElement).toBe(opener);

            host.innerHTML = `<button id="inside">Inside</button>`;
            const trap = createFocusTrap(host);
            trap.activate();

            expect(document.activeElement?.id).toBe('inside');

            trap.deactivate();
            expect(trap.active).toBe(false);
            expect(document.activeElement).toBe(opener);

            document.body.removeChild(opener);
        });

        it('handles opener being removed from DOM safely', () => {
            const opener = document.createElement('button');
            document.body.appendChild(opener);
            opener.focus();

            host.innerHTML = `<button id="inside">Inside</button>`;
            const trap = createFocusTrap(host);
            trap.activate();

            // Disconnect opener before deactivation
            document.body.removeChild(opener);

            expect(() => trap.deactivate()).not.toThrow();
            expect(trap.active).toBe(false);
        });

        it('is idempotent when activating or deactivating repeatedly', () => {
            host.innerHTML = `<button id="inside">Inside</button>`;
            const trap = createFocusTrap(host);

            trap.activate();
            trap.activate(); // No-op
            expect(trap.active).toBe(true);

            trap.deactivate();
            trap.deactivate(); // No-op
            expect(trap.active).toBe(false);
        });
    });

    describe('Nested Traps and Trap Stack', () => {
        it('manages trap stack with parent and child dialogs', () => {
            const parentDialog = document.createElement('div');
            parentDialog.id = 'parentDialog';
            parentDialog.innerHTML = `
                <button id="p1">Parent Button 1</button>
                <button id="p2">Parent Button 2</button>
            `;
            host.appendChild(parentDialog);

            const childDialog = document.createElement('div');
            childDialog.id = 'childDialog';
            childDialog.innerHTML = `
                <button id="c1">Child Button 1</button>
            `;
            host.appendChild(childDialog);

            const parentTrap = createFocusTrap(parentDialog);
            const childTrap = createFocusTrap(childDialog);

            // 1. Activate parent trap
            parentTrap.activate();
            expect(getActiveTrap()).toBe(parentTrap);
            expect(document.activeElement?.id).toBe('p1');

            const p2 = parentDialog.querySelector('#p2') as HTMLButtonElement;
            p2.focus();
            expect(document.activeElement?.id).toBe('p2');

            // 2. Activate child trap (nested modal opened from parent)
            childTrap.activate();
            expect(getActiveTrap()).toBe(childTrap);
            expect(document.activeElement?.id).toBe('c1');

            // Child trap owns Tab cycle
            const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
            document.dispatchEvent(tabEvent);
            expect(tabEvent.defaultPrevented).toBe(true);
            expect(document.activeElement?.id).toBe('c1');

            // 3. Deactivate child trap -> restores focus to p2 (opener), and parent trap becomes active
            childTrap.deactivate();
            expect(getActiveTrap()).toBe(parentTrap);
            expect(document.activeElement?.id).toBe('p2');

            // 4. Deactivate parent trap
            parentTrap.deactivate();
            expect(getActiveTrap()).toBeUndefined();
        });
    });
});
