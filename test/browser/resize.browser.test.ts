import { afterEach, describe, expect, it } from 'vitest';
import { page } from '@vitest/browser/context';
import { needs, element, text, type Application, type Context, KEEPS_NOTHING } from '@flybyme/mesh-web';
import { mountPart, cleanup } from '@flybyme/mesh-web/testing';

const APP_NEEDS = needs('windows');

class ResizeApp implements Application<typeof APP_NEEDS> {
    readonly needs = APP_NEEDS;

    readonly layout = {
        split: 'row',
        children: [
            { node: { tile: 'left' } },
            { node: { tile: 'right' } }
        ]
    } as const;

    readonly views = [
        {
            id: 'leftView',
            title: 'Left',
            window: { tile: 'left' },
            render: () => element('Text', { children: [text('LeftViewContent')] }),
        },
        {
            id: 'rightView',
            title: 'Right',
            window: { tile: 'right' },
            render: () => element('Text', { children: [text('RightViewContent')] }),
        },
    ] as const;

    async start(cx: Context<typeof APP_NEEDS>) {
        cx.windows.open({ view: 'leftView' });
        cx.windows.open({ view: 'rightView' });
        return KEEPS_NOTHING;
    }
}

afterEach(() => {
    cleanup();
});

describe('ResizeObserver layout test', () => {
    it('re-cascades the layout dynamically on window resize', async () => {
        // 3. Set the Playwright viewport to something specific (800x600).
        await page.viewport(800, 600);

        // 1 & 2. Mounts a basic App with the windows capability and layout array.
        const site = await mountPart({
            parts: [{ id: 'app', contribution: ResizeApp }]
        });
        
        // Enter tiled mode so layout is applied
        site.manager.setMode('tiled');
        
        // Give ResizeObserver and layout pipeline a moment to settle
        await new Promise(r => setTimeout(r, 100));

        const windows = Array.from(site.root.querySelectorAll<HTMLElement>('.window'));
        const leftWin = windows.find(w => w.textContent?.includes('LeftViewContent'));
        const rightWin = windows.find(w => w.textContent?.includes('RightViewContent'));
        
        expect(leftWin).not.toBeUndefined();
        expect(rightWin).not.toBeUndefined();
        
        let leftWidth = leftWin!.getBoundingClientRect().width;
        let rightWidth = rightWin!.getBoundingClientRect().width;
        
        // 4. Verifies the widths of the two tile DOM elements are roughly 400px each.
        // There may be gaps, so a range of 350-450 is safe.
        expect(leftWidth).toBeGreaterThan(350);
        expect(leftWidth).toBeLessThan(450);
        expect(rightWidth).toBeGreaterThan(350);
        expect(rightWidth).toBeLessThan(450);

        // 5. Uses page.viewport(1200, 600) to resize the browser window.
        await page.viewport(1200, 600);
        
        // 6. Awaits the ResizeObserver to fire and the framework to re-render the layout.
        await new Promise(r => setTimeout(r, 100));
        
        leftWidth = leftWin!.getBoundingClientRect().width;
        rightWidth = rightWin!.getBoundingClientRect().width;
        
        // 7. Verifies the widths of the two tiles are now roughly 600px each.
        expect(leftWidth).toBeGreaterThan(550);
        expect(leftWidth).toBeLessThan(650);
        expect(rightWidth).toBeGreaterThan(550);
        expect(rightWidth).toBeLessThan(650);
    });
});
