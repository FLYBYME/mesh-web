/**
 * The browser harness — roadmap A0.5a.
 *
 * Everything in this package is tested under jsdom, and jsdom is not a browser: it has no layout, no
 * compositor, no real pointer events and no focus model. 123 green tests said the pieces fit each
 * other; they could not say that anything appears on a screen. This file is the smallest thing that
 * answers that question, and it is a harness rather than a demo — it exists to be *looked at*.
 *
 * What it deliberately is not:
 *
 * - **not part of the package.** It lives outside `src/` and ships in nothing. It imports
 *   `@flybyme/mesh-web` by name — the compiler resolves it through `paths`, the browser through an
 *   import map in `index.html` — so it sees exactly the surface an Application author sees. If the
 *   public entry is missing something, this file fails to compile.
 * - **not the window chrome.** The title bar, the resize grip and the close button below are the
 *   shell's, and a real shell contributes them from an Extension (spec/kernel.md section 2). They are
 *   written out longhand here because A4 has not happened yet, and the point is to drive the real
 *   `WindowManager` with real pointer events.
 *
 * The Application below never sees any of it. It has no element, no window handle, and no way to
 * reach either.
 */

import {
    Kernel, WindowManager, command, consumes, createClient, createRegistry, each, effect, element,
    fetchTransport, mountView, needs, provider, text, tiles, when, windowSink, withHeaders, describe,
    PRIMITIVES,
    type Action, type Application, type Context, type Extension, type NetRequest, type NetResponse,
    type Transport, type ViewContext, type ViewInstance,
} from '@flybyme/mesh-web';

// Generated from the API's own exposure list by `npm run example:client` in mesh-api. Structural
// types, no zod, no import into the repo the contracts live in (spec/network.md §3.1).
import { blogApi, type PostListOutputItem } from './generated/blog-api.js';

// ---------------------------------------------------------------------------- a site

/** The API's shape, not a hand-written copy of it. */
type Post = PostListOutputItem;

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
    add(): void;
}
const BLOG = provider<BlogApi>('demo.blog');

const BLOG_NEEDS = needs('state', 'commands', 'windows', 'notifications', 'net');
const BLOG_CONSUMES = consumes(AUTH);

class BlogApp implements Application<typeof BLOG_NEEDS, typeof BLOG_CONSUMES, typeof BLOG> {
    readonly needs = BLOG_NEEDS;
    readonly consumes = BLOG_CONSUMES;
    readonly provides = BLOG;

    // Declared in the manifest, so the kernel knows every API this site contacts before any of it
    // runs — the list a review, a CSP or an audit wants (spec/network.md §4).
    readonly api = blogApi;

    readonly commands = [
        { id: 'blog.open', title: 'Blog: Open Post' },
        { id: 'blog.publish', title: 'Blog: Publish Post' },
        { id: 'blog.add', title: 'Blog: New Post' },
        // Declared by the Application, implemented by the shell: switching modes is the window
        // manager's business, not the blog's (spec/input.md §6). The Application only says the verb
        // exists so it can be bound and appear in a palette.
        { id: 'blog.mode', title: 'Toggle tiled / windowed' },
    ];

    readonly keys = [
        { command: 'blog.add', keys: 'alt+n', gamepad: 'Y' },
        { command: 'blog.mode', keys: 'alt+t', gamepad: 'Back' },
    ];

    /**
     * The arrangement, when tiled. In windowed mode these names are simply unused
     * (spec/application.md §6) — same views, two geometries.
     */
    readonly layout = tiles({
        split: 'column',
        children: [
            { node: { tile: 'header' }, size: { px: 44 } },
            {
                node: {
                    split: 'row',
                    children: [
                        { node: { tile: 'sidebar' }, size: { px: 260 } },
                        { node: { tile: 'content' } },
                    ],
                },
            },
            { node: { tile: 'footer' }, size: { px: 28 } },
        ],
    });

    readonly views = [
        {
            id: 'masthead',
            title: 'Masthead',
            tile: 'header',
            instances: 'one' as const,
            defaultSize: { width: 420, height: 90 },
            minSize: { width: 200, height: 60 },
            render: (vx: ViewContext<Record<string, never>, BlogApi>) =>
                element('Row', {
                    props: { class: 'masthead' },
                    children: [
                        element('Heading', { children: [text('The mesh-web blog')] }),
                        element('Text', {
                            props: { class: 'count' },
                            children: [text(() => `${vx.app.posts().length} posts`)],
                        }),
                    ],
                }),
        },
        {
            id: 'colophon',
            title: 'Status',
            tile: 'footer',
            instances: 'one' as const,
            defaultSize: { width: 420, height: 70 },
            minSize: { width: 200, height: 40 },
            render: (vx: ViewContext<Record<string, never>, BlogApi>) =>
                element('Row', {
                    props: { class: 'colophon' },
                    children: [
                        element('Text', {
                            children: [
                                text(() => {
                                    const posts = vx.app.posts();
                                    const live = posts.filter((p) => p.published).length;
                                    return `${live} published · ${posts.length - live} draft`;
                                }),
                            ],
                        }),
                    ],
                }),
        },
        {
            id: 'reader',
            title: 'Reader',
            tile: 'content',
            instances: 'one' as const,
            defaultSize: { width: 460, height: 320 },
            minSize: { width: 240, height: 160 },
            render: (vx: ViewContext<Record<string, never>, BlogApi>) =>
                element('Stack', {
                    props: { class: 'reader' },
                    children: [
                        each(
                            () => vx.app.posts().filter((p) => p.published),
                            (p: Post) => p.slug,
                            (p: () => Post) =>
                                element('Card', {
                                    props: { class: 'article' },
                                    children: [
                                        element('Heading', { children: [text(() => p().title)] }),
                                        element('Text', {
                                            props: { class: 'body' },
                                            children: [text(() => `Every window on this desktop is the same view in a different geometry. ${p().title.toLowerCase()} — served by a real mesh-api, over HTTP, gatekept.`)],
                                        }),
                                    ],
                                }),
                        ),
                    ],
                }),
        },
        {
            id: 'sidebar',
            title: 'Posts',
            tile: 'sidebar',
            instances: 'one' as const,
            defaultSize: { width: 300, height: 340 },
            minSize: { width: 220, height: 140 },

            // A pure function from application state to a description. No element, no DOM, no
            // `document`, and nothing in scope that could reach one.
            render: (vx: ViewContext<Record<string, never>, BlogApi>) =>
                element('Stack', {
                    props: { class: 'pane' },
                    children: [
                        element('List', {
                            props: { class: 'posts' },
                            children: [
                                each(
                                    () => vx.app.posts(),
                                    (p: Post) => p.slug,
                                    (p: () => Post) =>
                                        element('ListItem', {
                                            props: { class: 'post' },
                                            intents: {
                                                activate: { action: command('blog.publish', p().slug) },
                                            },
                                            children: [
                                                element('Text', {
                                                    props: { class: 'title' },
                                                    children: [text(() => p().title)],
                                                }),
                                                when(
                                                    () => !p().published,
                                                    () => element('Badge', {
                                                        props: { class: 'draft' },
                                                        children: [text('draft')],
                                                    }),
                                                    () => element('Badge', {
                                                        props: { class: 'live' },
                                                        children: [text('live')],
                                                    }),
                                                ),
                                            ],
                                        }),
                                ),
                            ],
                        }),
                        element('Row', {
                            props: { class: 'actions' },
                            children: [
                                element('Button', {
                                    intents: { activate: { action: command('blog.add') } },
                                    children: [text('New post')],
                                }),
                                element('Button', {
                                    intents: { activate: { action: command('blog.open', 'a') } },
                                    children: [text('Open a second window')],
                                }),
                            ],
                        }),
                        element('Text', {
                            props: { class: 'count' },
                            children: [
                                text(() => `${vx.app.posts().filter((p) => p.published).length} published`),
                            ],
                        }),
                    ],
                }),
        },
    ];

    async start(cx: Context<typeof BLOG_NEEDS, typeof BLOG_CONSUMES, typeof blogApi>): Promise<BlogApi> {
        const auth = cx.use(AUTH);
        const posts = cx.state.signal<readonly Post[]>([]);
        let n = 0;

        /**
         * One place where a failure becomes something a person can read.
         *
         * `describe()` maps every named failure to a sentence, and its switch is exhaustive — so a
         * new failure in the framework is a compile error here rather than an empty toast.
         */
        const refresh = async (): Promise<void> => {
            const result = await cx.net.call('post.list', {});
            if (!result.ok) {
                cx.notifications.warn(describe(result.error));
                return;
            }
            // Inferred from the API's own output schema. Nothing here declares this shape.
            posts.set(result.value.items);
        };

        cx.commands.implement('blog.open', () => {
            cx.windows.open({ view: 'sidebar' });
        });

        cx.commands.implement('blog.publish', async (slug) => {
            const result = await cx.net.call('post.publish', { slug: String(slug) });
            if (!result.ok) {
                // A permission the caller does not have arrives as a 403 and is *expected*, not an
                // error to hide: bob can read this site and cannot write to it.
                cx.notifications.warn(describe(result.error));
                return;
            }
            posts.set(posts().map((p) => (p.slug === result.value.slug ? result.value : p)));
        });

        cx.commands.implement('blog.add', async () => {
            n += 1;
            const result = await cx.net.call('post.create', { title: `Untitled ${n}` });
            if (!result.ok) {
                cx.notifications.warn(describe(result.error));
                return;
            }
            posts.set([...posts(), result.value]);
        });

        // Declared here, implemented by the shell below. The Application does not switch modes —
        // it cannot even see which one it is in.
        cx.commands.implement('blog.mode', () => toggleMode());

        await refresh();

        return {
            posts,
            canWrite: () => auth.signedIn(),
            publish: (slug) => void cx.commands.run('blog.publish', slug),
            add: () => void cx.commands.run('blog.add'),
        };
    }
}

// ---------------------------------------------------------------------------- the shell

const root = document.getElementById('desktop')!;
const log = document.getElementById('log')!;

const say = (message: string): void => {
    const line = document.createElement('div');
    line.textContent = message;
    log.prepend(line);
};

const manager = new WindowManager({ width: root.clientWidth, height: root.clientHeight });
const kernel = new Kernel();

kernel.services.windows = windowSink(manager, (owner, view) => kernel.viewOf(owner, view));

/**
 * Where the API is, and who is calling it.
 *
 * The origin is a deployment fact: in production the CDN and the API sit behind one proxy and this
 * is `''` (spec/hosting.md §1). Here they are two ports, which is why the API has to declare this
 * origin in `allowOrigins`.
 *
 * The ticket is attached by **wrapping the transport**, not by any Application handling it
 * (spec/network.md §4). `withHeaders` takes a function rather than a value because a ticket is
 * refreshed, and a value captured once goes stale in exactly the case that matters — here, signing
 * in as somebody else without reloading.
 */
const API_ORIGIN = new URLSearchParams(location.search).get('api')
    // A page served from somewhere other than the local dev server has no mesh-api to reach, so it
    // runs against the in-page transport below. `?api=http://…` points it at a real one.
    ?? (location.hostname === 'localhost' || location.hostname === '127.0.0.1'
        ? 'http://127.0.0.1:5005'
        : 'memory');

let ticket: string | undefined = new URLSearchParams(location.search).get('ticket') ?? 'alice-ticket';

kernel.services.netClient = (api) => createClient(api as never, {
    transport: withHeaders(
        API_ORIGIN === 'memory' ? memoryTransport() : fetchTransport(API_ORIGIN),
        (): Readonly<Record<string, string>> =>
            (ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }),
    ),
});

/**
 * The same API, in the page.
 *
 * Not a mock and not a fallback path inside the Application — the Application is byte-for-byte the
 * one that talks to the real mesh-api, using the same generated client and the same declared
 * failures. Only the **transport** differs, which is the seam `Transport` exists to be
 * (spec/network.md §4): a test needs no server, the auth Extension attaches a ticket by wrapping
 * one, and a demo can run with nothing behind it.
 *
 * Used when this page has no mesh-api to reach — a published copy of the harness cannot call
 * localhost. Everything above this line is unaware.
 */
function memoryTransport(): Transport {
    const posts = new Map<string, Post>([
        ['welcome', { slug: 'welcome', title: 'A window you can drag', published: true, organizationId: 'org-a' }],
        ['fine', { slug: 'fine', title: 'Fine-grained, no diffing', published: false, organizationId: 'org-a' }],
        ['kernel', { slug: 'kernel', title: 'The kernel drives everything', published: true, organizationId: 'org-a' }],
        ['tiles', { slug: 'tiles', title: 'Two modes, no remount', published: true, organizationId: 'org-a' }],
    ]);

    let n = 0;
    const ok = (value: unknown): NetResponse =>
        ({ status: 200, headers: {}, body: JSON.stringify(value) });

    return {
        async send(request: NetRequest): Promise<NetResponse> {
            const [path] = request.url.split('?');
            const input = request.body === undefined
                ? {}
                : JSON.parse(request.body) as Record<string, string>;

            if (path === '/api/post' && request.method === 'GET') {
                return ok({ organization: 'org-a', items: [...posts.values()] });
            }

            if (path === '/api/post' && request.method === 'POST') {
                n += 1;
                const created: Post = {
                    slug: `untitled-${String(n)}`,
                    title: `Untitled ${String(n)}`,
                    published: false,
                    organizationId: 'org-a',
                };
                posts.set(created.slug, created);
                return ok(created);
            }

            if (path === '/api/post/publish') {
                const post = posts.get(String(input['slug']));
                if (post === undefined) {
                    // Shaped exactly as mesh-api shapes one, `declared` marker and all — otherwise
                    // this would exercise a path the real API never produces.
                    return {
                        status: 404,
                        headers: {},
                        body: JSON.stringify({ error: 'not_found', message: 'No such post.', declared: true }),
                    };
                }
                const next = { ...post, published: !post.published };
                posts.set(next.slug, next);
                return ok(next);
            }

            return { status: 404, headers: {}, body: JSON.stringify({ error: 'NOT_FOUND', message: request.url }) };
        },
    };
}

kernel.boot([
    { id: 'auth', contribution: new AuthExtension() as never },
    { id: 'blog', contribution: new BlogApp() as never },
]);

const components = createRegistry(PRIMITIVES);

const runCommand = (action: Action): void => {
    say(`command ${action.kind === 'command' ? action.id : action.kind}`);
    if (action.kind !== 'command') return;
    void kernel.services.commands.get(action.id)?.run(...(action.args ?? []));
};

interface Frame {
    readonly host: HTMLElement;
    readonly content: HTMLElement;
    readonly titleEl: HTMLElement;
    readonly instance: ViewInstance;
}

const frames = new Map<string, Frame>();

/**
 * Build the chrome for one window, once.
 *
 * Pointer capture rather than window-level listeners, because a drag that leaves the element must
 * keep receiving moves — the bug every hand-rolled drag has on the first try.
 */
function createFrame(id: string): Frame {
    const host = document.createElement('div');
    host.className = 'window';
    host.dataset['window'] = id;

    const bar = document.createElement('div');
    bar.className = 'titlebar';

    const titleEl = document.createElement('span');
    titleEl.className = 'label';

    const buttons = document.createElement('span');
    buttons.className = 'buttons';

    const max = document.createElement('button');
    max.textContent = '□';
    max.title = 'Maximize / restore';
    max.addEventListener('click', () => {
        const record = manager.get(id);
        if (record === undefined) return;
        if (record.state === 'maximized') manager.restore(id);
        else manager.maximize(id);
    });

    const close = document.createElement('button');
    close.textContent = '×';
    close.title = 'Close';
    close.addEventListener('click', () => manager.close(id));

    buttons.append(max, close);
    bar.append(titleEl, buttons);

    const content = document.createElement('div');
    content.className = 'content';

    const grip = document.createElement('div');
    grip.className = 'grip';

    host.append(bar, content, grip);
    host.addEventListener('pointerdown', () => manager.focus(id), true);

    drag(bar, (dx, dy) => manager.move(id, dx, dy));
    drag(grip, (dx, dy) => manager.resize(id, 'se', dx, dy));

    const process = kernel.processes.find((p) => p.pid === manager.get(id)!.owner)!;
    const decl = kernel.viewOf(process.pid, manager.get(id)!.view)!;

    const instance = mountView(content, {
        windowId: id,
        decl,
        api: process.api,
        params: manager.get(id)!.params,
        windows: manager,
        render: { components, dispatch: { dispatch: () => {} } },
        onCommand: runCommand,
    });

    root.appendChild(host);
    return { host, content, titleEl, instance };
}

/** A pointer drag, reported as deltas. The manager owns the geometry; this owns nothing. */
function drag(handle: HTMLElement, onMove: (dx: number, dy: number) => void): void {
    handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);

        let x = event.clientX;
        let y = event.clientY;

        const move = (e: PointerEvent): void => {
            onMove(e.clientX - x, e.clientY - y);
            x = e.clientX;
            y = e.clientY;
        };

        const up = (): void => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
        };

        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
    });
}

/**
 * Paint, driven by the manager's own signals.
 *
 * There is no `paint()` call anywhere below — `manager.windows` and `manager.order` are signals, so
 * moving a window re-runs this effect and nothing else. The view inside the window is untouched by
 * it, which is the property worth seeing with your own eyes: geometry is the shell's, application
 * state is the Application's, and they do not share a render pass.
 */
effect(() => {
    const stacked = manager.stacked();
    const live = new Set(stacked.map((r) => r.id));
    const visible = new Set(manager.visible().map((r) => r.id));
    const tiledNow = manager.mode() === 'tiled';

    for (const record of stacked) {
        let frame = frames.get(record.id);
        if (frame === undefined) {
            frame = createFrame(record.id);
            frames.set(record.id, frame);
            say(`window ${record.id} opened`);
        }

        const { host } = frame;

        // `rectOf` rather than `record.rect`: in tiled mode a window's box comes from the tile its
        // view targets, and the record's own rect is left alone so switching back restores it.
        const rect = manager.rectOf(record.id);
        if (rect !== undefined) {
            // **Reposition, never re-parent.** Moving a node between parents resets its scroll
            // position, which would silently break the one property a mode switch is for
            // (spec/README §4).
            host.style.left = `${rect.x}px`;
            host.style.top = `${rect.y}px`;
            host.style.width = `${rect.width}px`;
            host.style.height = `${rect.height}px`;
        }

        host.style.zIndex = String(manager.zIndexOf(record.id));
        host.classList.toggle('focused', manager.focused() === record.id);
        host.classList.toggle('tiled', tiledNow);

        // Hidden, never unmounted: a window the current mode cannot show keeps its DOM, its
        // effects, its scroll position and whatever was typed into it.
        host.hidden = record.state === 'minimized' || !visible.has(record.id);
        frame.titleEl.textContent = record.title;
    }

    for (const [id, frame] of [...frames]) {
        if (live.has(id)) continue;
        frame.instance.dispose();
        frame.host.remove();
        frames.delete(id);
        say(`window ${id} closed`);
    }

    // The rail reads the kernel, and the kernel changed if the windows did. Repainted from inside
    // this effect so there is one thing driving the screen rather than two that can disagree.
    paintRail();
});

/**
 * The notification host — roadmap A6.5.
 *
 * A capability with no surface is a silent failure. `cx.notifications.warn(...)` was being called
 * correctly and recorded correctly, and displayed nowhere, so an API error looked exactly like a
 * button that did nothing. That is not a demo bug — `notifications` is a framework capability, and
 * a sink nothing renders is worse than no sink, because the Application believes it reported.
 *
 * Its own effect rather than part of the window paint: notifications are not windows, they outlive
 * the window that raised them, and there is no reason a geometry change should touch them.
 */
effect(() => {
    const host = document.getElementById('notifications');
    if (host === null) return;

    const live = kernel.services.notifications();
    host.innerHTML = '';

    for (const notice of live) {
        const el = document.createElement('div');
        el.className = `notice ${notice.level}`;

        const text = document.createElement('div');
        text.className = 'text';
        const source = document.createElement('div');
        source.className = 'source';
        source.textContent = notice.source;
        text.append(source, document.createTextNode(notice.message));

        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.textContent = '×';
        dismiss.title = 'Dismiss';
        dismiss.addEventListener('click', () => {
            kernel.services.notifications.set(
                kernel.services.notifications().filter((n) => n.id !== notice.id),
            );
        });

        el.append(text, dismiss);
        host.appendChild(el);
    }
});

/**
 * The rail: the kernel's own state, on screen.
 *
 * The manifest and the process table are not decoration — they are the two things this design is
 * actually about. The manifest is populated before anything runs, which is what lets a keypress
 * start an Application that has not started yet (spec/kernel.md section 4); the process table is
 * what makes an Application a *process* rather than an object (spec/application.md).
 *
 * Rendered by hand rather than through the framework, deliberately: this is shell chrome, and the
 * shell is not an Application.
 */
function paintRail(): void {
    const manifest = document.getElementById('manifest')!;
    manifest.innerHTML = '';
    const facts: readonly [string, string][] = [
        ['Commands', String(kernel.manifest.commands.size)],
        ['Key bindings', String(kernel.manifest.bindings.size)],
        ['Views', String(kernel.manifest.views.size)],
        ['Conflicts', String(kernel.manifest.conflicts.length)],
        ['Windows', String(manager.windows().length)],
    ];
    for (const [term, value] of facts) {
        const dt = document.createElement('dt');
        dt.textContent = term;
        const dd = document.createElement('dd');
        dd.textContent = value;
        manifest.append(dt, dd);
    }

    const processes = document.getElementById('processes')!;
    processes.innerHTML = '';
    if (kernel.processes.length === 0) {
        const none = document.createElement('p');
        none.className = 'empty';
        none.textContent = 'Nothing running.';
        processes.append(none);
    }
    for (const process of kernel.processes) {
        const row = document.createElement('div');
        row.className = 'process';
        row.innerHTML =
            `<span class="pid"></span><span class="app"></span><span class="state"></span>`;
        row.querySelector('.pid')!.textContent = process.pid;
        row.querySelector('.app')!.textContent = process.applicationId;
        const state = row.querySelector('.state')!;
        state.textContent = process.state;
        state.className = `state ${process.state}`;
        processes.append(row);
    }

    const bindings = document.getElementById('bindings')!;
    bindings.innerHTML = '';
    for (const [keys, binding] of kernel.manifest.bindings) {
        const row = document.createElement('div');
        row.className = 'binding';
        row.innerHTML = `<code></code><span></span>`;
        row.querySelector('code')!.textContent = keys;
        row.querySelector('span')!.textContent = binding.decl.command;
        bindings.append(row);
    }
}

window.addEventListener('resize', () => {
    manager.setViewport({ width: desktopSize().width, height: desktopSize().height });
});

const desktopSize = (): { width: number; height: number } => ({
    width: root.clientWidth,
    height: root.clientHeight,
});

// The manifest is populated before anything runs, which is what lets a keypress start an
// Application that is not running yet (spec/kernel.md section 4).
window.addEventListener('keydown', (event) => {
    // spec/input.md §7.1: `ctrl+n` is the browser's, not ours. It was this harness's binding until
    // someone pressed it and got a new browser window over the top of a command that had already
    // fired. `alt+` is ours; the reserved set belongs to the host adapter, which A8 builds.
    const combo = `${event.ctrlKey ? 'ctrl+' : ''}${event.altKey ? 'alt+' : ''}${event.key.toLowerCase()}`;
    const binding = kernel.manifest.bindings.get(combo);
    if (binding === undefined) return;
    event.preventDefault();
    say(`key ${combo} → ${binding.decl.command}`);
    void kernel.services.commands.get(binding.decl.command)?.run();
});

// ---------------------------------------------------------------------------- boot

async function main(): Promise<void> {
    // Painted before anything starts, because the manifest is already populated — that is the
    // property, not a loading order (spec/kernel.md section 4).
    paintRail();
    say(`manifest: ${kernel.manifest.commands.size} commands, ${kernel.manifest.bindings.size} bindings`);

    const pid = await kernel.start('blog');
    say(`blog started as ${pid}`);
    paintRail();

    const auth = kernel.extensions.find((e) => e.id === 'auth')!.api as AuthApi;
    auth.signIn();

    // The layout is the Application's, read off its manifest — the shell is told the tree, it does
    // not invent one.
    manager.setLayout(kernel.manifest.layouts.get('blog'));

    // One window per view. In windowed mode they cascade; hit the toggle and the same four views
    // become a header, a sidebar, a reader and a footer with nothing remounted.
    for (const view of ['masthead', 'sidebar', 'reader', 'colophon']) {
        kernel.services.windows.open(pid, view, {});
    }

    document.getElementById('stop')!.addEventListener('click', () => {
        void kernel.stop(pid).then(() => say('blog stopped — its windows went with it'));
    });

    document.getElementById('mode')!.addEventListener('click', () => toggleMode());
}

/**
 * The shell's, not the Application's.
 *
 * spec/input.md §6: window management is input, and it belongs to the kernel side. The Application
 * declared the *command* so it can be bound and appear in a palette; what the command does is here.
 */
function toggleMode(): void {
    const next = manager.mode() === 'tiled' ? 'windowed' : 'tiled';
    manager.setMode(next);
    say(`mode → ${next}`);

    const button = document.getElementById('mode');
    if (button !== null) button.textContent = next === 'tiled' ? 'Windowed' : 'Tiled';
}

void main().catch((error: unknown) => say(`boot failed: ${String(error)}`));
