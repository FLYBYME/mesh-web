/**
 * @vitest-environment jsdom
 *
 * The whole path, once: a bundle exporting a class, constructed by the kernel, its manifest read
 * before it runs, started, opening a window through a capability it declared, its view rendered as
 * a description, and that description in the DOM.
 *
 * This is the test the design is for. Everything else checks a piece; this checks that the pieces
 * were shaped to fit each other, which is the thing 95 green unit tests could not tell me.
 */

import { describe, expect, it } from 'vitest';

import {
    Kernel, WindowManager, command, consumes, createRegistry, createServices, each, element,
    flushSync, mountView, needs, provider, text, when, windowSink, PRIMITIVES,
    type Action, type Application, type Context, type Extension, type ViewContext, type ViewInstance,
} from '../src/index.js';

// ---------------------------------------------------------------------------- a site

interface Post {
    readonly slug: string;
    readonly title: string;
    readonly published: boolean;
}

interface AuthApi {
    readonly signedIn: () => boolean;
    signIn(): void;
}
const AUTH = provider<AuthApi>('demo.auth');

const AUTH_NEEDS = needs('state', 'log');

class AuthExtension implements Extension<typeof AUTH_NEEDS, readonly [], typeof AUTH> {
    readonly needs = AUTH_NEEDS;
    readonly provides = AUTH;

    activate(cx: Context<typeof AUTH_NEEDS>): AuthApi {
        const session = cx.state.signal(false);
        cx.log.info('auth ready');
        return { signedIn: () => session(), signIn: () => session.set(true) };
    }
}

interface BlogApi {
    readonly posts: () => readonly Post[];
    readonly canWrite: () => boolean;
    publish(slug: string): void;
}
const BLOG = provider<BlogApi>('demo.blog');

const BLOG_NEEDS = needs('state', 'commands', 'windows', 'notifications');
const BLOG_CONSUMES = consumes(AUTH);

class BlogApp implements Application<typeof BLOG_NEEDS, typeof BLOG_CONSUMES, typeof BLOG> {
    readonly needs = BLOG_NEEDS;
    readonly consumes = BLOG_CONSUMES;
    readonly provides = BLOG;

    readonly commands = [{ id: 'blog.open', title: 'Blog: Open Post' }];
    readonly keys = [{ command: 'blog.open', keys: 'ctrl+o', gamepad: 'A' }];

    readonly views = [
        {
            id: 'sidebar',
            title: 'Posts',
            tile: 'sidebar',
            instances: 'one' as const,
            defaultSize: { width: 240, height: 400 },
            minSize: { width: 180, height: 100 },
            // A pure function from application state to a description. No element, no DOM.
            render: (vx: ViewContext<Record<string, never>, BlogApi>) =>
                element('List', {
                    children: [
                        each(
                            () => vx.app.posts(),
                            (p: Post) => p.slug,
                            (p: () => Post) =>
                                element('ListItem', {
                                    intents: { activate: { action: command('blog.open', p().slug) } },
                                    children: [
                                        text(() => p().title),
                                        when(() => !p().published, () => text(' — draft')),
                                    ],
                                }),
                        ),
                    ],
                }),
        },
    ];

    async start(cx: Context<typeof BLOG_NEEDS, typeof BLOG_CONSUMES>): Promise<BlogApi> {
        const auth = cx.use(AUTH);
        const posts = cx.state.signal<readonly Post[]>([
            { slug: 'a', title: 'First', published: true },
            { slug: 'b', title: 'Second', published: false },
        ]);

        cx.commands.implement('blog.open', (slug) => {
            if (!auth.signedIn()) {
                cx.notifications.warn('Sign in first.');
                return;
            }
            cx.windows.open({ view: 'sidebar', params: { slug: String(slug) } });
        });

        return {
            posts,
            canWrite: () => auth.signedIn(),
            publish: (slug) =>
                posts.set(posts().map((p) => (p.slug === slug ? { ...p, published: true } : p))),
        };
    }
}

// ---------------------------------------------------------------------------- the host

/**
 * What a real shell would do, in miniature: a window manager, a kernel wired to it, and a bridge
 * that renders each window's view into an element.
 *
 * The chrome is deliberately absent — a title bar is an Extension (spec/kernel.md section 2). What
 * is exercised here is only what must be identical for every site.
 */
function bootSite() {
    const root = document.createElement('div');
    document.body.appendChild(root);

    const manager = new WindowManager({ width: 1000, height: 800 });
    const kernel = new Kernel();

    kernel.services.windows = windowSink(manager, (owner, view) => kernel.viewOf(owner, view));

    kernel.boot([
        { id: 'auth', contribution: new AuthExtension() as never },
        { id: 'blog', contribution: new BlogApp() as never },
    ]);

    const mounted = new Map<string, { host: HTMLElement; instance: ViewInstance }>();
    const dispatched: Action[] = [];

    /** Render every open window, and drop what closed. Stands in for the compositor. */
    const paint = (): void => {
        for (const record of manager.stacked()) {
            if (mounted.has(record.id)) {
                const existing = mounted.get(record.id)!;
                existing.host.style.left = `${record.rect.x}px`;
                existing.host.style.top = `${record.rect.y}px`;
                existing.host.style.width = `${record.rect.width}px`;
                existing.host.style.height = `${record.rect.height}px`;
                existing.host.style.zIndex = String(manager.zIndexOf(record.id));
                continue;
            }

            const process = kernel.processes.find((p) => p.pid === record.owner);
            const decl = kernel.viewOf(record.owner, record.view);
            if (process === undefined || decl === undefined) continue;

            const host = document.createElement('div');
            host.dataset.window = record.id;
            host.style.position = 'absolute';
            root.appendChild(host);

            const instance = mountView(host, {
                windowId: record.id,
                decl,
                api: process.api,
                params: record.params,
                windows: manager,
                render: { components: createRegistry(PRIMITIVES), dispatch: { dispatch: () => {} } },
                onCommand: (action) => {
                    dispatched.push(action);
                    if (action.kind === 'command') {
                        void kernel.services.commands.get(action.id)?.run(...(action.args ?? []));
                    }
                },
            });

            mounted.set(record.id, { host, instance });
        }

        for (const [id, entry] of [...mounted]) {
            if (manager.get(id) !== undefined) continue;
            entry.instance.dispose();
            entry.host.remove();
            mounted.delete(id);
        }
    };

    return { root, manager, kernel, paint, mounted, dispatched };
}

// ---------------------------------------------------------------------------- the test

describe('an Application reaches the screen', () => {
    it('boots, starts, opens a window, and renders its view into the DOM', async () => {
        const site = bootSite();

        // The manifest is populated before anything starts — which is what lets a keypress start it.
        expect(site.kernel.manifest.commands.get('blog.open')?.by).toBe('blog');
        expect([...site.kernel.manifest.bindings.keys()].sort()).toEqual(['ctrl+o', 'gamepad:A']);
        expect(site.kernel.processes).toHaveLength(0);

        const pid = await site.kernel.start('blog');
        expect(site.kernel.processes.find((p) => p.pid === pid)?.state).toBe('running');

        // Refused while signed out: the Application asked its own auth, through a declared provider.
        await site.kernel.services.commands.get('blog.open')!.run('a');
        expect(site.manager.windows()).toHaveLength(0);
        expect(site.kernel.services.notifications().at(-1)?.message).toBe('Sign in first.');

        const auth = site.kernel.extensions.find((e) => e.id === 'auth')!.api as AuthApi;
        auth.signIn();

        await site.kernel.services.commands.get('blog.open')!.run('a');
        expect(site.manager.windows()).toHaveLength(1);

        const record = site.manager.windows()[0]!;
        expect(record.owner).toBe(pid);
        // Size came from the view declaration, read at boot rather than asked for at open time.
        expect(record.rect.width).toBe(240);

        site.paint();

        const host = site.root.querySelector<HTMLElement>('[data-window]')!;
        expect(host.textContent).toBe('FirstSecond — draft');
        expect(host.querySelectorAll('li')).toHaveLength(2);
    });

    it('a click inside a view runs a command through the kernel', async () => {
        const site = bootSite();
        const pid = await site.kernel.start('blog');
        const auth = site.kernel.extensions.find((e) => e.id === 'auth')!.api as AuthApi;
        auth.signIn();

        await site.kernel.services.commands.get('blog.open')!.run('a');
        site.paint();

        const first = site.root.querySelector('li')!;
        first.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(site.dispatched).toEqual([{ kind: 'command', id: 'blog.open', args: ['a'] }]);

        /**
         * **One window, because `sidebar` declares `instances: 'one'`.**
         *
         * This asserted two until the declaration was actually enforced. `instances` sat on
         * `ViewDecl` and was read by nothing, so every open minted another window and this test
         * wrote that down as the expectation — which is how a test built on top of a defect
         * defends it. The subject here is *a click reaching a command through the kernel*, and
         * that is the assertion above; the window count was only ever incidental.
         */
        expect(site.manager.windows()).toHaveLength(1);
        expect(site.manager.windows().every((w) => w.owner === pid)).toBe(true);
        expect(site.manager.focused()).toBe(site.manager.windows()[0]?.id);
    });

    it('application state drives the view, and the window is not involved', async () => {
        const site = bootSite();
        const pid = await site.kernel.start('blog');
        const auth = site.kernel.extensions.find((e) => e.id === 'auth')!.api as AuthApi;
        auth.signIn();
        await site.kernel.services.commands.get('blog.open')!.run('a');
        site.paint();

        const host = site.root.querySelector<HTMLElement>('[data-window]')!;
        const listItems = [...host.querySelectorAll('li')];
        expect(host.textContent).toBe('FirstSecond — draft');

        const api = site.kernel.processes.find((p) => p.pid === pid)!.api as BlogApi;
        api.publish('b');
        flushSync();

        expect(host.textContent).toBe('FirstSecond');
        // Fine-grained: the row was updated, not rebuilt.
        expect([...host.querySelectorAll('li')][1]).toBe(listItems[1]);
    });

    it('a window can be dragged, and the Application never knows', async () => {
        const site = bootSite();
        await site.kernel.start('blog');
        const auth = site.kernel.extensions.find((e) => e.id === 'auth')!.api as AuthApi;
        auth.signIn();
        await site.kernel.services.commands.get('blog.open')!.run('a');
        site.paint();

        const host = site.root.querySelector<HTMLElement>('[data-window]')!;
        const id = host.dataset.window!;
        const before = site.manager.get(id)!.rect;
        const content = host.textContent;

        site.manager.move(id, 120, 60);
        site.paint();

        expect(host.style.left).toBe(`${before.x + 120}px`);
        expect(host.style.top).toBe(`${before.y + 60}px`);
        // The view was not re-rendered: geometry is view state and the Application owns none of it.
        expect(host.textContent).toBe(content);

        site.manager.resize(id, 'se', 100, 40);
        site.paint();
        expect(host.style.width).toBe(`${before.width + 100}px`);
    });

    it('stopping the process closes its windows and disposes its views', async () => {
        const site = bootSite();
        const pid = await site.kernel.start('blog');
        const auth = site.kernel.extensions.find((e) => e.id === 'auth')!.api as AuthApi;
        auth.signIn();
        await site.kernel.services.commands.get('blog.open')!.run('a');
        site.paint();

        expect(site.mounted.size).toBe(1);
        const instance = [...site.mounted.values()][0]!.instance;

        await site.kernel.stop(pid);
        site.paint();

        // The Application did none of this. The kernel disposes what it scoped, because the case
        // that has to work is the one that crashed before it could clean up.
        expect(site.manager.windows()).toHaveLength(0);
        expect(site.mounted.size).toBe(0);
        expect(site.root.querySelector('[data-window]')).toBeNull();
        expect(instance.handlers.size).toBe(0);
        expect(site.kernel.services.commands.has('blog.open')).toBe(false);
    });
});
