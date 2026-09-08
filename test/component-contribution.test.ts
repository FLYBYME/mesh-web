/**
 * @vitest-environment jsdom
 *
 * Extension-contributed components — spec/components.md §2, roadmap A7.4/A7.4a.
 */

import { describe, expect, it } from 'vitest';

import { needs } from '../src/contribution/capabilities.js';
import type { Application, Context, Extension } from '../src/contribution/contract.js';
import { KEEPS_NOTHING } from '../src/contribution/contract.js';
import type { ComponentDefinition } from '../src/render/component.js';
import { createRegistry, PRIMITIVES } from '../src/render/component.js';
import { render } from '../src/render/dom.js';
import { element, text } from '../src/description/index.js';
import { mergeManifests } from '../src/kernel/manifest.js';
import { start } from '../src/kernel/start.js';

const WINDOWS_NEEDS = needs('windows');

describe('manifest component declarations and merging', () => {
    it('merges declared components into the manifest', () => {
        const cardDef: ComponentDefinition = {
            name: 'ui.Card',
            create: () => document.createElement('div'),
        };

        const manifest = mergeManifests([
            { id: 'ui', declarations: { components: [cardDef] } },
        ]);

        expect(manifest.components.has('ui.Card')).toBe(true);
        expect(manifest.components.get('ui.Card')?.decl).toBe(cardDef);
        expect(manifest.components.get('ui.Card')?.by).toBe('ui');
        expect(manifest.conflicts).toHaveLength(0);
    });

    it('enforces namespace prefix matching the contributing part id', () => {
        const bareDef: ComponentDefinition = {
            name: 'Card',
            create: () => document.createElement('div'),
        };
        const wrongPrefixDef: ComponentDefinition = {
            name: 'other.Card',
            create: () => document.createElement('div'),
        };

        const manifest = mergeManifests([
            { id: 'ui', declarations: { components: [bareDef, wrongPrefixDef] } },
        ]);

        const bareConflict = manifest.conflicts.find((c) => c.kind === 'component' && c.key === 'Card');
        expect(bareConflict).toBeDefined();
        expect(bareConflict?.claimants).toEqual(['ui']);
        expect(bareConflict?.message).toMatch(/must be prefixed with "ui\."/);

        const wrongConflict = manifest.conflicts.find((c) => c.kind === 'component' && c.key === 'other.Card');
        expect(wrongConflict).toBeDefined();
        expect(wrongConflict?.claimants).toEqual(['ui']);
        expect(wrongConflict?.message).toMatch(/must be prefixed with "ui\."/);
    });

    it('reports two contributions claiming one component name as a load-time conflict in manifest.conflicts', () => {
        const cardOne: ComponentDefinition = {
            name: 'ui.Card',
            create: () => {
                const el = document.createElement('div');
                el.className = 'first';
                return el;
            },
        };
        const cardTwo: ComponentDefinition = {
            name: 'ui.Card',
            create: () => {
                const el = document.createElement('div');
                el.className = 'second';
                return el;
            },
        };

        const manifest = mergeManifests([
            { id: 'ui', declarations: { components: [cardOne] } },
            { id: 'ui-alt', declarations: { components: [cardTwo] } },
        ]);

        const collision = manifest.conflicts.find(
            (c) => c.kind === 'component' && c.key === 'ui.Card' && c.claimants.length === 2,
        );
        expect(collision).toBeDefined();
        expect(collision?.claimants).toEqual(['ui', 'ui-alt']);
        expect(collision?.message).toMatch(/Component "ui\.Card" is declared by both ui and ui-alt/);

        // First claim stands in the merged manifest map
        expect(manifest.components.get('ui.Card')?.decl).toBe(cardOne);
    });
});

describe('runtime component registration and rendering', () => {
    it('registers Extension-provided components in the registry and renders them in an Application', async () => {
        const cardDef: ComponentDefinition = {
            name: 'ui.Card',
            create: () => {
                const el = document.createElement('section');
                el.className = 'ui-card';
                el.setAttribute('data-test-card', 'true');
                return el;
            },
        };

        class UiExtension implements Extension<readonly []> {
            readonly needs = [] as const;
            readonly components = [cardDef];
            activate(): void {}
        }

        class CardApp implements Application<typeof WINDOWS_NEEDS, readonly []> {
            readonly needs = WINDOWS_NEEDS;
            readonly views = [{
                id: 'main',
                title: 'Card View',
                render: () => element('ui.Card', {
                    children: [text('Card Content')],
                }),
            }];

            async start(cx: Context<typeof WINDOWS_NEEDS, readonly []>): Promise<typeof KEEPS_NOTHING> {
                cx.windows.open({ view: 'main' });
                return KEEPS_NOTHING;
            }
        }

        const started = start({
            application: 'card-app',
            parts: [
                { id: 'ui', contribution: new UiExtension() },
                { id: 'card-app', contribution: new CardApp() },
            ],
        });

        await started.ready;

        // Verify component is registered in started.components
        expect(started.components.get('ui.Card')).toBe(cardDef);

        // Verify the component was rendered in the DOM
        const renderedCard = document.body.querySelector('[data-test-card="true"]');
        expect(renderedCard).not.toBeNull();
        expect(renderedCard?.tagName.toLowerCase()).toBe('section');
        expect(renderedCard?.textContent).toContain('Card Content');

        started.dispose();
    });

    it('does not throw at render when two contributions claim the same component name', async () => {
        const cardOne: ComponentDefinition = {
            name: 'ui.Card',
            create: () => {
                const el = document.createElement('div');
                el.className = 'winner-card';
                return el;
            },
        };
        const cardTwo: ComponentDefinition = {
            name: 'ui.Card',
            create: () => {
                const el = document.createElement('div');
                el.className = 'loser-card';
                return el;
            },
        };

        class PrimaryUi implements Extension<readonly []> {
            readonly needs = [] as const;
            readonly components = [cardOne];
            activate(): void {}
        }

        class SecondaryUi implements Extension<readonly []> {
            readonly needs = [] as const;
            readonly components = [cardTwo];
            activate(): void {}
        }

        class TestApp implements Application<typeof WINDOWS_NEEDS, readonly []> {
            readonly needs = WINDOWS_NEEDS;
            readonly views = [{
                id: 'main',
                title: 'Test',
                render: () => element('ui.Card', {
                    children: [text('Rendered Successfully')],
                }),
            }];

            async start(cx: Context<typeof WINDOWS_NEEDS, readonly []>): Promise<typeof KEEPS_NOTHING> {
                cx.windows.open({ view: 'main' });
                return KEEPS_NOTHING;
            }
        }

        const started = start({
            application: 'test-app',
            parts: [
                { id: 'ui', contribution: new PrimaryUi() },
                { id: 'ui-alt', contribution: new SecondaryUi() },
                { id: 'test-app', contribution: new TestApp() },
            ],
        });

        await started.ready;

        // Conflict is reported at load time
        const conflict = started.kernel.manifest.conflicts.find(
            (c) => c.kind === 'component' && c.key === 'ui.Card' && c.claimants.length === 2,
        );
        expect(conflict).toBeDefined();
        expect(conflict?.claimants).toEqual(['ui', 'ui-alt']);

        // And kernel logs a warning
        const warnings = started.kernel.services.logs.filter(
            (l) => l.level === 'warn' && l.source === 'kernel',
        );
        expect(warnings.some((w) => w.message === conflict?.message)).toBe(true);

        // Does NOT throw at render: renders using the winning component
        const rendered = document.body.querySelector('.winner-card');
        expect(rendered).not.toBeNull();
        expect(rendered?.textContent).toContain('Rendered Successfully');

        started.dispose();
    });

    it('fails with an error naming the component and the requesting part when a part renders an unknown component', () => {
        const components = createRegistry(PRIMITIVES);
        const host = document.createElement('div');
        const dispatch = { dispatch: () => {} };

        expect(() => render(element('ui.UnknownThing', {}), host, { components, dispatch, part: 'todo-app' }))
            .toThrow('Unknown component "ui.UnknownThing" wanted by "todo-app". Known: Badge, Button');
    });

    it('falls back cleanly to unknown component error without part clause when part is not supplied', () => {
        const components = createRegistry(PRIMITIVES);
        const host = document.createElement('div');
        const dispatch = { dispatch: () => {} };

        expect(() => render(element('ui.UnknownThing', {}), host, { components, dispatch }))
            .toThrow(/^Unknown component "ui\.UnknownThing"\. Known: Badge, Button/);
    });
});
