/**
 * Single window mode in a real browser — roadmap A2.4.
 *
 * Single mode is the third window mode ('windowed' | 'tiled' | 'single').
 * It allows normal websites and blogs to run as document flow with one view
 * and natural page scrolling, rather than an app shell viewport with inner scrollbars.
 *
 * What is under test here can only be verified in a real browser:
 * - layout & document flow (no absolute positioning, no inline sizes/coordinates)
 * - document.scrollingElement scrolling when content is taller than viewport
 * - lack of inner clipping (root, host, window, content do not scroll or clip)
 * - absence of titlebar and grip furniture
 * - lossless mode switching (DOM elements and inputs preserved, geometry restored)
 * - policy locking enforcement
 */

import { afterEach, describe, expect, it } from 'vitest';
import '../../src/kernel.css';

import {
    element, flushSync, needs, SettingLocked, text,
    type Application, type Context, type ViewDecl,
} from '../../src/index.js';
import { cleanup, mountPart, type MountedSite } from '../../src/testing/index.js';

const NEEDS = needs('windows', 'state');

class BlogApp implements Application<typeof NEEDS> {
    readonly needs = NEEDS;

    readonly views = [
        {
            id: 'post',
            title: 'Blog Post',
            instances: 'one' as const,
            defaultSize: { width: 500, height: 400 },
            render: () =>
                element('Stack', {
                    props: { class: 'blog-post', style: { display: 'block' } },
                    children: [
                        element('Input', { props: { class: 'comment-input', value: '' } }),
                        // 100 rows at 30px each = 3000px height, guaranteed to exceed viewport
                        ...Array.from({ length: 100 }, (_, i) =>
                            element('Text', {
                                props: { class: 'para', style: { display: 'block', height: '30px', 'line-height': '30px' } },
                                children: [text(`Paragraph line ${String(i)} of blog content`)],
                            }),
                        ),
                    ],
                }),
        },
        {
            id: 'about',
            title: 'About Page',
            instances: 'one' as const,
            defaultSize: { width: 400, height: 300 },
            render: () => element('Text', { children: [text('About this blog')] }),
        },
    ] as unknown as readonly ViewDecl<never, never>[];

    async start(cx: Context<typeof NEEDS>): Promise<void> {
        cx.windows.open({ view: 'post' });
    }
}

class SecondApp implements Application<typeof NEEDS> {
    readonly needs = NEEDS;

    readonly views = [
        {
            id: 'dashboard',
            title: 'Dashboard',
            instances: 'one' as const,
            defaultSize: { width: 450, height: 350 },
            render: () => element('Text', { children: [text('Second app dashboard')] }),
        },
    ] as unknown as readonly ViewDecl<never, never>[];

    async start(cx: Context<typeof NEEDS>): Promise<void> {
        cx.windows.open({ view: 'dashboard' });
    }
}

let site: MountedSite | undefined;

afterEach(() => {
    cleanup();
    site = undefined;
    window.scrollTo(0, 0);
    document.body.innerHTML = '';
});

describe('single window mode in a real browser', () => {
    it('boots with policy single: renders one view with natural document flow and no window furniture', async () => {
        site = await mountPart({
            application: 'blog',
            parts: [{ id: 'blog', contribution: BlogApp }],
            policy: { 'window-manager/mode': 'single' },
        });

        expect(site.manager.mode()).toBe('single');

        const root = site.root as HTMLElement;
        expect(root.dataset['meshWindowMode']).toBe('single');

        // Exactly one window element is present
        const windows = root.querySelectorAll('.window');
        expect(windows.length).toBe(1);

        const win = windows[0] as HTMLElement;
        expect(win.classList.contains('single')).toBe(true);

        // No titlebar and no grip affordance
        expect(win.querySelector('.titlebar')).toBeNull();
        expect(win.querySelector('.grip')).toBeNull();

        // No absolute positioning or explicit inline size
        expect(win.style.position).toBe('');
        expect(win.style.left).toBe('');
        expect(win.style.top).toBe('');
        expect(win.style.width).toBe('');
        expect(win.style.height).toBe('');

        // Computed style checks: no border, no shadow, overflow visible
        const winStyle = window.getComputedStyle(win);
        expect(winStyle.boxShadow).toBe('none');
        expect(winStyle.overflow).toBe('visible');

        const content = win.querySelector('.content') as HTMLElement;
        expect(content).not.toBeNull();
        const contentStyle = window.getComputedStyle(content);
        expect(contentStyle.overflow).toBe('visible');
    });

    it('scrolls document.scrollingElement when content exceeds viewport, not inner containers', async () => {
        site = await mountPart({
            application: 'blog',
            parts: [{ id: 'blog', contribution: BlogApp }],
            policy: { 'window-manager/mode': 'single' },
        });

        const root = site.root as HTMLElement;
        const win = root.querySelector('.window') as HTMLElement;
        const content = win.querySelector('.content') as HTMLElement;

        // Content is 100 rows * 30px = 3000px tall
        const scrollingElement = document.scrollingElement as HTMLElement;
        expect(scrollingElement).not.toBeNull();
        expect(scrollingElement.scrollHeight).toBeGreaterThan(2500);
        expect(scrollingElement.scrollHeight).toBeGreaterThan(window.innerHeight);

        // Inner elements must NOT clip or scroll internally
        expect(root.scrollTop).toBe(0);
        expect(win.scrollTop).toBe(0);
        expect(content.scrollTop).toBe(0);

        // Perform scrolling at page level
        window.scrollTo(0, 350);

        expect(scrollingElement.scrollTop).toBe(350);
        // Inner containers still have scrollTop 0
        expect(root.scrollTop).toBe(0);
        expect(win.scrollTop).toBe(0);
        expect(content.scrollTop).toBe(0);
    });

    it('refuses mode change when pinned by build policy', async () => {
        site = await mountPart({
            application: 'blog',
            parts: [{ id: 'blog', contribution: BlogApp }],
            policy: { 'window-manager/mode': 'single' },
        });

        expect(site.manager.mode()).toBe('single');

        // Persistence setMode must reject with SettingLocked
        const persistence = site.settings;
        const modeSetting = site.manager;
        expect(modeSetting.mode()).toBe('single');

        // Registry write to window-manager/mode throws SettingLocked
        await expect(site.settings.write(
            { path: 'window-manager/mode', hive: 'device', fallback: 'windowed', description: '', parse: (x: unknown) => x as 'windowed' },
            'windowed',
        )).rejects.toThrow(SettingLocked);
    });

    it('switches between windowed and single losslessly without remounting DOM or losing state', async () => {
        site = await mountPart({
            application: 'blog',
            parts: [{ id: 'blog', contribution: BlogApp }],
        });

        expect(site.manager.mode()).toBe('windowed');

        const win = site.root.querySelector('.window') as HTMLElement;
        expect(win).not.toBeNull();
        expect(win.querySelector('.titlebar')).not.toBeNull();
        expect(win.querySelector('.grip')).not.toBeNull();

        // Give the window a specific geometry in windowed mode
        const winId = site.manager.windows()[0]!.id;
        site.manager.place(winId, { x: 80, y: 70, width: 420, height: 320 });
        flushSync();

        expect(win.style.left).toBe('80px');
        expect(win.style.top).toBe('70px');
        expect(win.style.width).toBe('420px');
        expect(win.style.height).toBe('320px');

        // Type into the input to verify state preservation
        const input = win.querySelector('.comment-input') as HTMLInputElement;
        expect(input).not.toBeNull();
        input.value = 'typed draft comment';

        // Switch to single mode
        site.manager.setMode('single');
        flushSync();

        expect(site.manager.mode()).toBe('single');
        expect(win.classList.contains('single')).toBe(true);
        expect(win.querySelector('.titlebar')).toBeNull();
        expect(win.querySelector('.grip')).toBeNull();
        expect(win.style.position).toBe('');
        expect(win.style.left).toBe('');
        expect(win.style.top).toBe('');

        // DOM element and state were preserved across the mode change
        const sameInput = win.querySelector('.comment-input') as HTMLInputElement;
        expect(sameInput).toBe(input);
        expect(sameInput.value).toBe('typed draft comment');

        // Switch back to windowed mode
        site.manager.setMode('windowed');
        flushSync();

        expect(site.manager.mode()).toBe('windowed');
        expect(win.classList.contains('single')).toBe(false);
        expect(win.querySelector('.titlebar')).not.toBeNull();
        expect(win.querySelector('.grip')).not.toBeNull();

        // Exact previous geometry restored
        expect(win.style.left).toBe('80px');
        expect(win.style.top).toBe('70px');
        expect(win.style.width).toBe('420px');
        expect(win.style.height).toBe('320px');

        // Input state still intact
        expect(input.value).toBe('typed draft comment');
    });

    it('shows only the active window and hides second application windows in single mode', async () => {
        site = await mountPart({
            application: 'blog',
            parts: [
                { id: 'blog', contribution: BlogApp },
                { id: 'second', contribution: SecondApp },
            ],
            open: [
                { application: 'blog', views: ['post'] },
                { application: 'second', views: ['dashboard'] },
            ],
            policy: { 'window-manager/mode': 'single' },
        });

        expect(site.manager.mode()).toBe('single');

        const windows = site.root.querySelectorAll('.window');
        expect(windows.length).toBe(2);

        const postRecord = site.manager.windows().find((w) => w.view === 'post')!;
        const dashRecord = site.manager.windows().find((w) => w.view === 'dashboard')!;

        // Dashboard was opened second, so it has focus and is visible; post is hidden
        const postWin = site.root.querySelector(`[data-window="${postRecord.id}"]`) as HTMLElement;
        const dashWin = site.root.querySelector(`[data-window="${dashRecord.id}"]`) as HTMLElement;

        expect(postWin).not.toBeNull();
        expect(dashWin).not.toBeNull();

        expect(dashWin.hidden).toBe(false);
        expect(postWin.hidden).toBe(true);

        expect(site.manager.visible().map((w) => w.view)).toEqual(['dashboard']);
        expect(site.manager.hidden().map((w) => w.view)).toEqual(['post']);

        // Focusing blog post raises it to single view and hides dashboard
        site.manager.focus(postRecord.id);
        flushSync();

        expect(postWin.hidden).toBe(false);
        expect(dashWin.hidden).toBe(true);
        expect(site.manager.visible().map((w) => w.view)).toEqual(['post']);
        expect(site.manager.hidden().map((w) => w.view)).toEqual(['dashboard']);
    });
});
