import { afterEach, describe, expect, it } from 'vitest';
import {
    element, needs, text,
    type Application, type Context, type Extension, type ComponentDefinition, type Props, type Json, KEEPS_NOTHING,
} from '../../src/index.js';
import { mountPart, cleanup } from '../../src/testing/index.js';

const BANNER_DEF: ComponentDefinition = {
    name: 'ui.Banner',
    create: (_props?: Props) => {
        const el = document.createElement('div');
        el.className = 'ui-banner';
        el.style.boxSizing = 'border-box';
        el.style.padding = '16px';
        el.style.backgroundColor = 'rgb(30, 41, 59)';
        el.style.color = 'rgb(248, 250, 252)';
        el.style.borderRadius = '8px';
        return el;
    },
    apply: (el: Element, name: string, value: Json) => {
        if (name === 'variant' && typeof value === 'string' && el instanceof HTMLElement) {
            el.dataset['variant'] = value;
            return true;
        }
        return false;
    },
};

class UiExtension implements Extension<readonly []> {
    readonly needs = [] as const;
    readonly components = [BANNER_DEF];
    activate(): void {}
}

const APP_NEEDS = needs('windows');

class StoreApp implements Application<typeof APP_NEEDS, readonly []> {
    readonly needs = APP_NEEDS;
    readonly views = [
        {
            id: 'store-front',
            title: 'Store Front',
            render: () => element('ui.Banner', {
                props: { variant: 'promotional' },
                children: [text('Summer Collection Available Now')],
            }),
        },
    ];

    async start(cx: Context<typeof APP_NEEDS, readonly []>): Promise<typeof KEEPS_NOTHING> {
        cx.windows.open({ view: 'store-front' });
        return KEEPS_NOTHING;
    }
}

afterEach(() => {
    cleanup();
});

describe('Extension-contributed component in a real browser', () => {
    it('allows an Extension to provide a component and an Application to render with it', async () => {
        const site = await mountPart({
            parts: [
                { id: 'ui', contribution: UiExtension },
                { id: 'store', contribution: StoreApp },
            ],
        });

        // Component is registered in the live registry
        expect(site.components.get('ui.Banner')).toBe(BANNER_DEF);

        // Window opened and rendered into the DOM
        expect(site.manager.windows()).toHaveLength(1);
        expect(site.root.textContent).toContain('Summer Collection Available Now');

        const banner = site.root.querySelector('.ui-banner');
        expect(banner).not.toBeNull();

        if (banner instanceof HTMLElement) {
            // Evaluated against real browser layout and styling engine
            const rect = banner.getBoundingClientRect();
            expect(rect.width).toBeGreaterThan(0);
            expect(rect.height).toBeGreaterThan(0);

            const computed = window.getComputedStyle(banner);
            expect(computed.paddingTop).toBe('16px');
            expect(computed.backgroundColor).toBe('rgb(30, 41, 59)');
            expect(banner.dataset['variant']).toBe('promotional');
        } else {
            expect.unreachable('Banner must be an HTMLElement');
        }

        site.dispose();
    });
});
