/**
 * A button that asks first. Its own state is whether the question is open, and whether the thing
 * it confirms failed — so it is a component, and every destructive action in the console is this
 * one, rather than a `window.confirm` (which blocks the page) or a dialog per page.
 */

import { Component, dialog, element, props, signal, text, when, type Node } from '@flybyme/mesh-web';

export class ConfirmButton extends Component({
    props: props<{
        readonly label: string;
        readonly question: string;
        readonly confirm: string;
        readonly run: () => Promise<void>;
    }>(),
}) {
    readonly open = signal(false);
    readonly busy = signal(false);
    readonly problem = signal<string | undefined>(undefined);

    readonly ask = this.on(() => { this.problem.set(undefined); this.open.set(true); });
    readonly cancel = this.on(() => this.open.set(false));
    readonly go = this.on(() => void this.confirmed());

    render(): Node {
        return [
            element('Button', {
                props: { class: 'ui-danger' },
                intents: { activate: { action: this.ask } },
                children: [text(this.props.label)],
            }),
            dialog({
                open: this.open,
                props: { ariaLabel: this.props.question },
                intents: { dismiss: { action: this.cancel } },
                children: [element('Stack', {
                    props: { class: 'ui-confirm' },
                    children: [
                        element('Text', { children: [text(this.props.question)] }),
                        when(() => this.problem() !== undefined, () => element('Text', {
                            props: { role: 'alert', class: 'ui-error' },
                            children: [text(() => this.problem() ?? '')],
                        })),
                        element('Row', {
                            props: { class: 'ui-actions' },
                            children: [
                                element('Button', { intents: { activate: { action: this.cancel } }, children: [text('Cancel')] }),
                                element('Button', {
                                    props: { class: 'ui-danger', disabled: this.busy },
                                    intents: { activate: { action: this.go } },
                                    children: [text(this.props.confirm)],
                                }),
                            ],
                        }),
                    ],
                })],
            }),
        ];
    }

    private async confirmed(): Promise<void> {
        this.busy.set(true);
        try {
            await this.props.run();
            this.open.set(false);
        } catch (error) {
            this.problem.set(error instanceof Error ? error.message : String(error));
        } finally {
            this.busy.set(false);
        }
    }
}
