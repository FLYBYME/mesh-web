import { describe, expect, it } from 'vitest';
import { mergeManifests } from '../src/kernel/manifest.js';
import type { Declarations } from '../src/contribution/contract.js';
import type { LayoutNode } from '../src/window/layout.js';

describe('mergeManifests and declaration conflict resolution', () => {
    const dummyRender = (): any => ({ kind: 'element', tag: 'div', props: {}, children: [] });

    it('merges non-conflicting declarations cleanly with empty conflicts', () => {
        const app1: { id: string; declarations: Declarations } = {
            id: 'editor',
            declarations: {
                commands: [{ id: 'editor.save', title: 'Save File' }],
                keys: [{ command: 'editor.save', keys: 'ctrl+s' }],
                menus: [{ target: 'menubar', command: 'editor.save', title: 'Save' }],
                settings: [{ path: 'editor.tabSize', hive: 'user', default: 4, description: 'Tab width' }],
                stores: [{ name: 'history', hive: 'user' }],
                views: [{ id: 'canvas', title: 'Editor Canvas', render: dummyRender }],
                components: [{ name: 'editor.Toolbar', create: () => document.createElement('div') }],
                session: 'required',
            },
        };

        const app2: { id: string; declarations: Declarations } = {
            id: 'terminal',
            declarations: {
                commands: [{ id: 'terminal.clear', title: 'Clear Terminal' }],
                keys: [{ command: 'terminal.clear', keys: 'ctrl+l' }],
                stores: [{ name: 'history', hive: 'session' }], // Same store name as app1, but scoped to terminal/history
                views: [{ id: 'canvas', title: 'Terminal Window', render: dummyRender }], // Same view name as app1, scoped to terminal/canvas
                session: 'optional',
            },
        };

        const manifest = mergeManifests([app1, app2]);

        expect(manifest.conflicts).toHaveLength(0);
        expect(manifest.commands.size).toBe(2);
        expect(manifest.bindings.size).toBe(2);
        expect(manifest.menus).toHaveLength(1);
        expect(manifest.settings.size).toBe(1);
        expect(manifest.stores.size).toBe(2);
        expect(manifest.stores.has('editor/history')).toBe(true);
        expect(manifest.stores.has('terminal/history')).toBe(true);
        expect(manifest.views.size).toBe(2);
        expect(manifest.views.has('editor/canvas')).toBe(true);
        expect(manifest.views.has('terminal/canvas')).toBe(true);
        expect(manifest.sessions.get('editor')).toBe('required');
        expect(manifest.sessions.get('terminal')).toBe('optional');
    });

    describe('Command conflicts', () => {
        it('flags collision when two contributions declare the same global command id', () => {
            const manifest = mergeManifests([
                {
                    id: 'appA',
                    declarations: {
                        commands: [{ id: 'duplicate.cmd', title: 'A command' }],
                    },
                },
                {
                    id: 'appB',
                    declarations: {
                        commands: [{ id: 'duplicate.cmd', title: 'B command' }],
                    },
                },
            ]);

            const conflict = manifest.conflicts.find((c) => c.kind === 'command' && c.key === 'duplicate.cmd');
            expect(conflict).toBeDefined();
            expect(conflict?.claimants).toEqual(['appA', 'appB']);
            expect(conflict?.message).toContain('Command "duplicate.cmd" is declared by both appA and appB. Command ids are global.');
            // First claim stands
            expect(manifest.commands.get('duplicate.cmd')?.by).toBe('appA');
        });
    });

    describe('Binding conflicts and validation', () => {
        it('flags collision when two contributions declare the same key shortcut', () => {
            const manifest = mergeManifests([
                {
                    id: 'part1',
                    declarations: {
                        commands: [{ id: 'cmd.one', title: 'One' }],
                        keys: [{ command: 'cmd.one', keys: 'alt+k' }],
                    },
                },
                {
                    id: 'part2',
                    declarations: {
                        commands: [{ id: 'cmd.two', title: 'Two' }],
                        keys: [{ command: 'cmd.two', keys: 'alt+k' }],
                    },
                },
            ]);

            const conflict = manifest.conflicts.find((c) => c.kind === 'binding' && c.key === 'alt+k');
            expect(conflict).toBeDefined();
            expect(conflict?.claimants).toEqual(['part1', 'part2']);
            expect(conflict?.message).toContain('Binding "alt+k" is claimed by part1 and part2.');
            expect(manifest.bindings.get('alt+k')?.by).toBe('part1');
        });

        it('detects gamepad and gesture binding declarations and collisions', () => {
            const manifest = mergeManifests([
                {
                    id: 'gameApp',
                    declarations: {
                        commands: [{ id: 'jump', title: 'Jump' }],
                        keys: [
                            { command: 'jump', gamepad: 'A' },
                            { command: 'jump', gesture: 'swipe-up' },
                        ],
                    },
                },
                {
                    id: 'otherApp',
                    declarations: {
                        commands: [{ id: 'skip', title: 'Skip' }],
                        keys: [{ command: 'skip', gamepad: 'A' }],
                    },
                },
            ]);

            expect(manifest.bindings.has('gamepad:A')).toBe(true);
            expect(manifest.bindings.has('gesture:swipe-up')).toBe(true);

            const conflict = manifest.conflicts.find((c) => c.kind === 'binding' && c.key === 'gamepad:A');
            expect(conflict).toBeDefined();
            expect(conflict?.claimants).toEqual(['gameApp', 'otherApp']);
        });

        it('reports reserved host bindings as conflicts', () => {
            const manifest = mergeManifests([
                {
                    id: 'browserApp',
                    declarations: {
                        commands: [{ id: 'new.tab', title: 'New Tab' }],
                        keys: [{ command: 'new.tab', keys: 'ctrl+n' }],
                    },
                },
            ]);

            const conflict = manifest.conflicts.find((c) => c.kind === 'binding' && c.key === 'ctrl+n');
            expect(conflict).toBeDefined();
            expect(conflict?.claimants).toEqual(['browserApp']);
            expect(conflict?.message).toContain('host takes that binding first');
        });

        it('allows overriding reserved bindings parameter', () => {
            const manifest = mergeManifests(
                [
                    {
                        id: 'kioskApp',
                        declarations: {
                            commands: [{ id: 'new.window', title: 'New Window' }],
                            keys: [{ command: 'new.window', keys: 'ctrl+n' }],
                        },
                    },
                ],
                [], // Empty reserved bindings for kiosk mode
            );

            const conflict = manifest.conflicts.find((c) => c.kind === 'binding' && c.key === 'ctrl+n');
            expect(conflict).toBeUndefined();
            expect(manifest.bindings.has('ctrl+n')).toBe(true);
        });

        it('reports malformed key syntax as an invalid binding conflict', () => {
            const manifest = mergeManifests([
                {
                    id: 'brokenApp',
                    declarations: {
                        commands: [{ id: 'foo', title: 'Foo' }],
                        keys: [{ command: 'foo', keys: 'ctrl+' }],
                    },
                },
            ]);

            const conflict = manifest.conflicts.find((c) => c.kind === 'binding' && c.key === 'ctrl+');
            expect(conflict).toBeDefined();
            expect(conflict?.claimants).toEqual(['brokenApp']);
            expect(conflict?.message).toContain('which is not one:');
        });
    });

    describe('Dangling references', () => {
        it('reports menu items referencing undeclared commands', () => {
            const manifest = mergeManifests([
                {
                    id: 'danglingApp',
                    declarations: {
                        menus: [{ target: 'menubar', command: 'nonexistent.command', title: 'Ghost Menu' }],
                    },
                },
            ]);

            const conflict = manifest.conflicts.find(
                (c) => c.kind === 'command' && c.key === 'nonexistent.command',
            );
            expect(conflict).toBeDefined();
            expect(conflict?.claimants).toEqual(['danglingApp']);
            expect(conflict?.message).toContain('Ghost Menu');
            expect(conflict?.message).toContain('which nothing declares');
        });

        it('reports key bindings referencing undeclared commands', () => {
            const manifest = mergeManifests([
                {
                    id: 'danglingKeyApp',
                    declarations: {
                        keys: [{ command: 'undeclared.cmd', keys: 'ctrl+shift+u' }],
                    },
                },
            ]);

            const conflict = manifest.conflicts.find(
                (c) => c.kind === 'binding' && c.key === 'ctrl+shift+u',
            );
            expect(conflict).toBeDefined();
            expect(conflict?.claimants).toEqual(['danglingKeyApp']);
            expect(conflict?.message).toContain('bound "ctrl+shift+u" to command "undeclared.cmd", which nothing declares.');
        });
    });

    describe('Store and View duplicate declarations', () => {
        it('flags duplicate store names within the same contributing part', () => {
            const manifest = mergeManifests([
                {
                    id: 'myPart',
                    declarations: {
                        stores: [
                            { name: 'cache', hive: 'user' },
                            { name: 'cache', hive: 'session' },
                        ],
                    },
                },
            ]);

            const conflict = manifest.conflicts.find((c) => c.kind === 'store' && c.key === 'myPart/cache');
            expect(conflict).toBeDefined();
            expect(conflict?.claimants).toEqual(['myPart', 'myPart']);
            expect(conflict?.message).toContain('Store "cache" is declared twice by myPart.');
        });

        it('flags duplicate view IDs within the same contributing part', () => {
            const manifest = mergeManifests([
                {
                    id: 'myApp',
                    declarations: {
                        views: [
                            { id: 'settings', title: 'Settings Tab', render: dummyRender },
                            { id: 'settings', title: 'Settings Alternate', render: dummyRender },
                        ],
                    },
                },
            ]);

            const conflict = manifest.conflicts.find((c) => c.kind === 'view' && c.key === 'myApp/settings');
            expect(conflict).toBeDefined();
            expect(conflict?.claimants).toEqual(['myApp', 'myApp']);
            expect(conflict?.message).toContain('View "myApp/settings" is declared twice, by myApp and myApp.');
        });
    });

    describe('Setting conflicts', () => {
        it('flags duplicate settings across contributions', () => {
            const manifest = mergeManifests([
                {
                    id: 'pkgA',
                    declarations: {
                        settings: [{ path: 'theme.mode', hive: 'user', default: 'light', description: 'Color mode' }],
                    },
                },
                {
                    id: 'pkgB',
                    declarations: {
                        settings: [{ path: 'theme.mode', hive: 'user', default: 'dark', description: 'Appearance' }],
                    },
                },
            ]);

            const conflict = manifest.conflicts.find((c) => c.kind === 'setting' && c.key === 'theme.mode');
            expect(conflict).toBeDefined();
            expect(conflict?.claimants).toEqual(['pkgA', 'pkgB']);
            expect(conflict?.message).toContain('Setting "theme.mode" is declared by both pkgA and pkgB.');
            expect(manifest.settings.get('theme.mode')?.by).toBe('pkgA');
        });
    });

    describe('APIs, Layouts, and Sessions', () => {
        it('merges APIs and layouts without conflicts', () => {
            const dummyApi = {
                endpoint: '/api/v1',
                schema: {},
            } as any;

            const layoutNode: LayoutNode = {
                split: 'row',
                children: [
                    { node: { tile: 'left' } },
                    { node: { tile: 'right' } },
                ],
            };

            const manifest = mergeManifests([
                {
                    id: 'networkedApp',
                    declarations: {
                        api: dummyApi,
                        layout: layoutNode,
                        session: 'required',
                    },
                },
            ]);

            expect(manifest.apis).toHaveLength(1);
            expect(manifest.apis[0]?.by).toBe('networkedApp');
            expect(manifest.apis[0]?.decl).toBe(dummyApi);

            expect(manifest.layouts.get('networkedApp')).toEqual(layoutNode);
            expect(manifest.sessions.get('networkedApp')).toBe('required');
            expect(manifest.conflicts).toHaveLength(0);
        });
    });
});
