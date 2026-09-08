/**
 * The page's answer to "is this ok?".
 *
 * `Confirmation` is the capability a contribution declares; this is the thing that actually draws
 * the question and waits. They are separate on purpose: the asker must not be able to resolve its
 * own question, so the resolver lives here, with the page, and never crosses into the caller.
 *
 * A native `<dialog>` rather than a hand-built overlay, because `showModal()` already gives the
 * three properties a confirmation needs and each is tedious and easy to get subtly wrong by hand:
 * focus moves into the dialog and is trapped there, the rest of the page becomes inert to clicks
 * and to the keyboard, and Escape closes. A div with a high `z-index` has none of those.
 */

import type { ConfirmRequest } from './broker.js';

/**
 * Build the prompter for a real page.
 *
 * Returns `false` — never throws — when there is nothing to draw on, which is what a prerender or a
 * headless boot looks like. A question nobody can be asked has not been agreed to.
 */
export function domConfirm(doc: Document | undefined): (request: ConfirmRequest) => Promise<boolean> {
    return async (request) => {
        if (doc === undefined || doc.body === null) return false;

        /**
         * **A confirmation that requires a person is refused when a person is not answering.**
         *
         * Refused rather than drawn. Showing the dialog and letting the agent dismiss it would be
         * theatre — worse than not asking, because the transcript would record a question that
         * appeared to be answered.
         *
         * This is the one check that makes `IntentActor` worth carrying. A confirmation is itself a
         * control that answers an intent, so whatever can raise `commit` can answer one; without
         * this, automating the UI automates past every destructive-write guard on the platform.
         */
        if (request.requiresUser === true && (request.actor ?? 'user') !== 'user') {
            return false;
        }

        // No `<dialog>` — an old browser, or a document implementation that stops short of it.
        // Refusing is the honest answer: the alternative is a question that appears to have been
        // asked and was not.
        const dialog = doc.createElement('dialog');
        if (typeof (dialog as HTMLDialogElement).showModal !== 'function') return false;

        dialog.className = request.destructive === true
            ? 'mesh-confirm mesh-confirm-destructive'
            : 'mesh-confirm';

        const title = doc.createElement('h2');
        title.className = 'mesh-confirm-title';
        title.textContent = request.title ?? (request.destructive === true ? 'Are you sure?' : 'Confirm');

        const message = doc.createElement('p');
        message.className = 'mesh-confirm-message';
        message.textContent = request.message;

        /**
         * Who is asking, always shown and never supplied by the asker.
         *
         * The kernel stamps `requester` from the contribution's own id. A person deciding whether to
         * allow something needs to know what is asking at least as much as what is being asked —
         * "delete every release" means something different from `catalog` than from a part nobody
         * remembers installing.
         */
        const source = doc.createElement('p');
        source.className = 'mesh-confirm-source';
        source.textContent = `asked by ${request.requester}`;

        const cancel = doc.createElement('button');
        cancel.type = 'button';
        cancel.className = 'mesh-confirm-cancel';
        cancel.textContent = request.cancelLabel ?? 'Cancel';

        const confirm = doc.createElement('button');
        confirm.type = 'button';
        confirm.className = 'mesh-confirm-ok';
        confirm.textContent = request.confirmLabel ?? (request.destructive === true ? 'Delete' : 'OK');

        const buttons = doc.createElement('div');
        buttons.className = 'mesh-confirm-buttons';
        buttons.append(cancel, confirm);
        dialog.append(title, message, source, buttons);
        doc.body.append(dialog);

        return await new Promise<boolean>((resolve) => {
            let done = false;

            const settle = (answer: boolean): void => {
                // Once, whatever happens. `close` fires after a button handler has already
                // answered, and a second resolve would be silent — but `finish` also removes the
                // node, and doing that twice is not.
                if (done) return;
                done = true;
                dialog.remove();
                resolve(answer);
            };

            cancel.addEventListener('click', () => { settle(false); });
            confirm.addEventListener('click', () => { settle(true); });

            // Escape, and the browser's own dismissal. Both are a refusal: closing a question
            // without answering it is not agreement, and treating it as one is how a person ends up
            // having "confirmed" something by pressing Escape.
            dialog.addEventListener('close', () => { settle(false); });
            dialog.addEventListener('cancel', () => { settle(false); });

            (dialog as HTMLDialogElement).showModal();

            // Focus starts on the safe choice. A held Enter key from whatever the person was doing
            // before the dialog appeared must not become an answer.
            cancel.focus();
        });
    };
}
