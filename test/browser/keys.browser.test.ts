import { afterEach, describe, expect, it } from 'vitest';
import {
    needs, KEEPS_NOTHING,
    type Application, type Context
} from '@flybyme/mesh-web';
import { mountPart, cleanup } from '@flybyme/mesh-web/testing';

const APP_NEEDS = needs('commands');

class TestApp implements Application<typeof APP_NEEDS> {
    readonly needs = APP_NEEDS;

    readonly commands = [
        { id: 'test.cmd', title: 'Test Command' },
        { id: 'test.cmd2', title: 'Test Command 2' },
    ];

    readonly keys = [
        { command: 'test.cmd', keys: 'ctrl+p' },
        { command: 'test.cmd2', keys: 'p' },
    ];

    async start(cx: Context<typeof APP_NEEDS>) {
        cx.commands.implement('test.cmd', () => {});
        cx.commands.implement('test.cmd2', () => {});
        return KEEPS_NOTHING;
    }
}

afterEach(() => {
    cleanup();
});

describe('keyboard bindings', () => {
    it('intercepts modifier shortcuts on document and inputs', async () => {
        const site = await mountPart({
            parts: [{ id: 'testapp', contribution: TestApp }],
        });

        const docEvent = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
        site.root.ownerDocument.dispatchEvent(docEvent);
        expect(docEvent.defaultPrevented).toBe(true);

        const input = document.createElement('input');
        document.body.appendChild(input);
        
        const inputEvent = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
        input.dispatchEvent(inputEvent);
        expect(inputEvent.defaultPrevented).toBe(true);

        input.remove();
        site.dispose();
    });

    it('intercepts plain keys on document but ignores them in inputs', async () => {
        const site = await mountPart({
            parts: [{ id: 'testapp', contribution: TestApp }],
        });

        const docEvent = new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true });
        site.root.ownerDocument.dispatchEvent(docEvent);
        expect(docEvent.defaultPrevented).toBe(true);

        const input = document.createElement('input');
        document.body.appendChild(input);
        
        const inputEvent = new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true });
        input.dispatchEvent(inputEvent);
        expect(inputEvent.defaultPrevented).toBe(false);

        input.remove();
        site.dispose();
    });
});
