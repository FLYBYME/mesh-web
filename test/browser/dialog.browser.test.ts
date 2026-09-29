/**
 * Dialog and focus trap mechanics in a real browser — roadmap A7.6.
 *
 * What is under test here requires a real browser:
 * - HTML5 <dialog> top-layer promotion and stacking (no z-index arithmetic)
 * - ::backdrop rendering
 * - Focus containment (Tab cannot reach controls behind the dialog)
 * - Focus entry on open and restoration to the opener element on close
 * - Escape key dismissal delivered through the dismiss intent rather than DOM key handlers
 * - Nested dialog stacking where only the topmost dialog traps focus
 */

import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from '@vitest/browser/context';
import '../../src/kernel.css';

import { App, dialog, element, flushSync, mountSite, signal, text, View, type MountedApp, type Node } from '../../src/index.js';

/**
 * The page under test, as an app-model View: which dialog is open is the view's own state, and
 * every button's handler is the view's own. (As a legacy Application this was a provider token,
 * four declared commands and four `implement` calls for the same two booleans.)
 */
class DialogPage extends View({}) {
    readonly first = signal(false);
    readonly second = signal(false);

    render(): Node {
        return element('Stack', {
            props: { class: 'page-content' },
            children: [
                element('Button', {
                    props: { id: 'open-dialog-1-btn' },
                    intents: { activate: { action: this.on(() => this.first.set(true)) } },
                    children: [text('Open Dialog 1')],
                }),
                element('Button', {
                    props: { id: 'behind-page-btn' },
                    children: [text('Control Behind Dialog')],
                }),
                dialog({
                    open: () => this.first(),
                    props: { class: 'modal-1' },
                    intents: { dismiss: { action: this.on(() => this.first.set(false)) } },
                    children: [
                        element('Button', {
                            props: { id: 'dialog-1-btn-1' },
                            children: [text('Dialog 1 First Action')],
                        }),
                        element('Button', {
                            props: { id: 'dialog-1-open-2-btn' },
                            intents: { activate: { action: this.on(() => this.second.set(true)) } },
                            children: [text('Open Dialog 2')],
                        }),
                        element('Button', {
                            props: { id: 'dialog-1-close-btn' },
                            intents: { activate: { action: this.on(() => this.first.set(false)) } },
                            children: [text('Close Dialog 1')],
                        }),
                        dialog({
                            open: () => this.second(),
                            props: { class: 'modal-2' },
                            intents: { dismiss: { action: this.on(() => this.second.set(false)) } },
                            children: [
                                element('Button', {
                                    props: { id: 'dialog-2-btn-1' },
                                    children: [text('Dialog 2 First Action')],
                                }),
                                element('Button', {
                                    props: { id: 'dialog-2-close-btn' },
                                    intents: { activate: { action: this.on(() => this.second.set(false)) } },
                                    children: [text('Close Dialog 2')],
                                }),
                            ],
                        }),
                    ],
                }),
            ],
        });
    }
}

class DialogTestApp extends App({ routes: { '/': DialogPage } }) {}

let root: HTMLElement | undefined;
let original = '';

function mountDialogs(): MountedApp {
    original = `${location.pathname}${location.search}`;
    history.replaceState(null, '', '/');
    root = document.createElement('div');
    document.body.appendChild(root);
    return mountSite(DialogTestApp, { root });
}

afterEach(() => {
    root?.remove();
    root = undefined;
    history.replaceState(null, '', original);
});

const tick = (): Promise<void> =>
    new Promise((resolve) => requestAnimationFrame(() => resolve()));

describe('dialog and focus trap in a real browser', () => {
    it('opens and closes from declared state, and content is not in tree when closed', async () => {
        const site = mountDialogs();
        await tick();

        const openBtn = document.querySelector<HTMLElement>('#open-dialog-1-btn')!;
        expect(openBtn).not.toBeNull();

        // Initially closed
        const initialDialog = document.querySelector<HTMLDialogElement>('dialog');
        expect(initialDialog).not.toBeNull();
        expect(initialDialog?.open).toBe(false);
        expect(document.querySelector('#dialog-1-btn-1')).toBeNull();

        // Click to open
        await userEvent.click(openBtn);
        flushSync();
        await tick();

        const openDialog = document.querySelector<HTMLDialogElement>('dialog')!;
        expect(openDialog.open).toBe(true);
        expect(document.querySelector('#dialog-1-btn-1')).not.toBeNull();

        // Click close inside dialog
        const closeBtn = document.querySelector<HTMLElement>('#dialog-1-close-btn')!;
        await userEvent.click(closeBtn);
        flushSync();
        await tick();

        expect(openDialog.open).toBe(false);
        // Children removed from the tree
        expect(document.querySelector('#dialog-1-btn-1')).toBeNull();

        site.dispose();
    });

    it('focus enters on open and returns to the opener on close', async () => {
        const site = mountDialogs();
        await tick();

        const openBtn = document.querySelector<HTMLElement>('#open-dialog-1-btn')!;
        openBtn.focus();
        expect(document.activeElement).toBe(openBtn);

        // Open by activating the focused button
        await userEvent.keyboard('{Enter}');
        flushSync();
        await tick();

        // Focus moved into the dialog's first focusable element
        const dialogBtn1 = document.querySelector<HTMLElement>('#dialog-1-btn-1')!;
        expect(document.activeElement).toBe(dialogBtn1);

        // Close dialog
        const closeBtn = document.querySelector<HTMLElement>('#dialog-1-close-btn')!;
        await userEvent.click(closeBtn);
        flushSync();
        await tick();

        // Focus restored to the opener
        expect(document.activeElement).toBe(openBtn);

        site.dispose();
    });

    it('Tab cannot reach anything behind it', async () => {
        const site = mountDialogs();
        await tick();

        const openBtn = document.querySelector<HTMLElement>('#open-dialog-1-btn')!;
        await userEvent.click(openBtn);
        flushSync();
        await tick();

        const btn1 = document.querySelector<HTMLElement>('#dialog-1-btn-1')!;
        const btn2 = document.querySelector<HTMLElement>('#dialog-1-open-2-btn')!;
        const btnClose = document.querySelector<HTMLElement>('#dialog-1-close-btn')!;
        const behindBtn = document.querySelector<HTMLElement>('#behind-page-btn')!;

        expect(document.activeElement).toBe(btn1);

        // Tab to second button
        await userEvent.keyboard('{Tab}');
        expect(document.activeElement).toBe(btn2);

        // Tab to close button
        await userEvent.keyboard('{Tab}');
        expect(document.activeElement).toBe(btnClose);

        // Tab from the last button wraps to the first button
        await userEvent.keyboard('{Tab}');
        expect(document.activeElement).toBe(btn1);

        // Tab did NOT reach the control behind the dialog
        expect(document.activeElement).not.toBe(behindBtn);
        expect(document.activeElement).not.toBe(openBtn);

        // Shift+Tab from first button wraps to the last button
        await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
        expect(document.activeElement).toBe(btnClose);

        site.dispose();
    });

    it('Escape closes and the opener state reflects it', async () => {
        const site = mountDialogs();
        await tick();

        const openBtn = document.querySelector<HTMLElement>('#open-dialog-1-btn')!;
        openBtn.focus();
        await userEvent.keyboard('{Enter}');
        flushSync();
        await tick();

        const dialogEl = document.querySelector<HTMLDialogElement>('dialog')!;
        expect(dialogEl.open).toBe(true);

        // Press Escape key
        await userEvent.keyboard('{Escape}');
        flushSync();
        await tick();

        // Dialog closed through dismiss intent and state update
        expect(dialogEl.open).toBe(false);
        expect(document.querySelector('#dialog-1-btn-1')).toBeNull();

        // Focus restored to opener
        expect(document.activeElement).toBe(openBtn);

        site.dispose();
    });

    it('two dialogs stack in top layer without a z-index anywhere in the CSS', async () => {
        const site = mountDialogs();
        await tick();

        const openBtn1 = document.querySelector<HTMLElement>('#open-dialog-1-btn')!;
        await userEvent.click(openBtn1);
        flushSync();
        await tick();

        // Open second dialog from inside first dialog
        const openBtn2 = document.querySelector<HTMLElement>('#dialog-1-open-2-btn')!;
        openBtn2.focus();
        expect(document.activeElement).toBe(openBtn2);

        await userEvent.keyboard('{Enter}');
        flushSync();
        await tick();

        const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog');
        expect(dialogs).toHaveLength(2);
        expect(dialogs[0]!.open).toBe(true);
        expect(dialogs[1]!.open).toBe(true);

        // Neither dialog has a z-index set in CSS
        const style1 = window.getComputedStyle(dialogs[0]!);
        const style2 = window.getComputedStyle(dialogs[1]!);
        expect(style1.zIndex).toBe('auto');
        expect(style2.zIndex).toBe('auto');

        // Focus is trapped in Dialog 2
        const dialog2Btn1 = document.querySelector<HTMLElement>('#dialog-2-btn-1')!;
        const dialog2Close = document.querySelector<HTMLElement>('#dialog-2-close-btn')!;
        expect(document.activeElement).toBe(dialog2Btn1);

        // Tab cycles inside Dialog 2
        await userEvent.keyboard('{Tab}');
        expect(document.activeElement).toBe(dialog2Close);

        await userEvent.keyboard('{Tab}');
        expect(document.activeElement).toBe(dialog2Btn1);

        // Escape closes Dialog 2
        await userEvent.keyboard('{Escape}');
        flushSync();
        await tick();

        // Dialog 2 closed, Dialog 1 remains open
        expect(dialogs[1]!.open).toBe(false);
        expect(dialogs[0]!.open).toBe(true);

        // Focus returned to the opener in Dialog 1
        expect(document.activeElement).toBe(openBtn2);

        // Tab now cycles in Dialog 1 again
        await userEvent.keyboard('{Tab}');
        expect(document.activeElement).toBe(document.querySelector('#dialog-1-close-btn'));

        // Close Dialog 1
        await userEvent.keyboard('{Escape}');
        flushSync();
        await tick();

        expect(dialogs[0]!.open).toBe(false);
        expect(document.activeElement).toBe(openBtn1);

        site.dispose();
    });
});
