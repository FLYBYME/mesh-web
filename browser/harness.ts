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
    Kernel, WindowManager, bindingTable, chordOf, command, consumes, createClient, createRegistry,
    createSettingsRegistry, each, effect, element, fetchTransport, formatBinding, localProvider,
    memoryProvider, mountShell, needs, provider, text, tiles, when, windowPersistence, windowSink,
    withHeaders, describe, PRIMITIVES,
    type Action, type Application, type Context, type Extension, type MeshClient, type NetRequest,
    type NetResponse, type Transport, type ViewContext,
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

const BLOG_NEEDS = needs('state', 'commands', 'windows', 'notifications', 'mesh');
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
            const result = await cx.mesh.call('post.list', {});
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
            const result = await cx.mesh.call('post.publish', { slug: String(slug) });
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
            const result = await cx.mesh.call('post.create', { title: `Untitled ${n}` });
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

/**
 * The registry, and where each hive is backed.
 *
 * `device` on `localStorage`, which is why a reload remembers where you left a window — a Deck and
 * a desktop have different screens, so geometry is per-device and never follows a person between
 * them (spec/storage-and-registry.md §2).
 *
 * `system` is memory here and unwritable, standing in for a hive that a real deployment fills from
 * the server. **Build policy is the other origin**, and `?locked=tiled` in the URL is this harness's
 * stand-in for it: a value frozen into the bundle, which no hive can outvote and this page cannot
 * change. That is the whole of A2.7 — a locked deployment is a policy value, not a mechanism.
 */
const lockedMode = new URLSearchParams(location.search).get('locked');

/**
 * `?device=memory` backs the `device` hive with memory instead of `localStorage`.
 *
 * For a test, and it is not a convenience: several pages of this harness share one origin, so a run
 * that saved `tiled` left the next one loading tiled — which looked like a broken toggle and was a
 * fixture leaking through the browser. A hive is bound by configuration, so "do not persist" is a
 * binding rather than a flag anything reads.
 */
const deviceProvider = new URLSearchParams(location.search).get('device') === 'memory'
    ? memoryProvider('device')
    : localProvider();

const registry = createSettingsRegistry({
    namespace: 'blog',
    ...(lockedMode === null
        ? {}
        : { policy: { [`window-manager/mode/${new URLSearchParams(location.search).get('app') ?? 'blog'}`]: lockedMode } }),
    hives: {
        system: { provider: memoryProvider('system'), writable: false },
        user: { provider: memoryProvider('user'), writable: true },
        device: { provider: deviceProvider, writable: true },
        session: { provider: memoryProvider('session'), writable: true },
    },
    onError: (error, { path }) => say(`registry: ${path} — ${String(error)}`),
});

/**
 * `?app=` varies the key geometry is saved under.
 *
 * A real deployment has one application per site and would not need it. Two tests both proving
 * "a reload remembers" would otherwise read each other's saved layout, which is a fixture leaking
 * through the browser rather than anything about the code.
 */
const application = new URLSearchParams(location.search).get('app') ?? 'blog';

const persistence = windowPersistence({ manager, registry, application });

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

// The cast is on the *result*, as in broker.ts, and that direction matters: `meshClient` is declared
// erased, so widening the client it returns is honest. `createClient(api as never, …)` — what this
// line used to say — casts the argument instead, which gives up checking the one thing worth
// checking here, that what the manifest declared is actually an API.
kernel.services.meshClient = (api) => createClient(api, {
    transport: withHeaders(
        API_ORIGIN === 'memory' ? memoryTransport() : fetchTransport(API_ORIGIN),
        (): Readonly<Record<string, string>> =>
            (ticket === undefined ? {} : { authorization: `Bearer ${ticket}` }),
    ),
}) as MeshClient<unknown>;

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

/**
 * The window layer, from the framework — roadmap A6.3e.
 *
 * This was 130 lines of this file: frame markup, a pointer-capture drag, and a paint effect that
 * positioned every window from the manager's signals. It was also, until it moved, **the only shell
 * mesh-web had** — the package tracked windows and rendered none of them, so A6.3's question
 * (can the workbench be an Extension over the window manager?) had nothing to be over.
 *
 * What is left here is what a site actually supplies: which process a window belongs to, what its
 * views render with, and where a command goes. `defaultFrame` draws it, and a site that wants its
 * own passes `chrome`.
 */
const shell = mountShell(root, {
    manager,
    viewOf: (owner, view) => {
        const process = kernel.processes.find((p) => p.pid === owner);
        return process === undefined ? undefined : kernel.viewOf(process.pid, view);
    },
    apiOf: (owner) => kernel.processes.find((p) => p.pid === owner)?.api,
    render: { components, dispatch: { dispatch: () => {} } },
    onCommand: runCommand,
    onWindow: (event, id) => { say(`window ${id} ${event}`); },
});

// The rail reads the kernel, and the kernel changed if the windows did. Its own effect now that the
// window paint is the framework's — two effects over the same signals, rather than one effect
// reaching across two concerns.
effect(() => {
    manager.windows();
    manager.mode();
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
/**
 * One table, built from the manifest, resolving every keypress.
 *
 * This used to be a hand-assembled string — `ctrl+` if ctrlKey, `alt+` if altKey, then the key —
 * which is the shape of the bug roadmap A1.4 names: it happened to work for `alt+n` and would have
 * silently ignored `shift+`, `meta+`, and any binding whose declared spelling put the modifiers in
 * another order. Now the declaration and the event meet in the same normal form, and there is no
 * string to assemble.
 */
const keymap = bindingTable(
    [...kernel.manifest.bindings].map(([binding, entry]) => ({ binding, command: entry.decl.command })),
);

// The manifest is populated before anything runs, which is what lets a keypress start an
// Application that is not running yet (spec/kernel.md section 4).
window.addEventListener('keydown', (event) => {
    const command = keymap.resolve(event);
    if (command === undefined) return;

    // Safe to prevent, because the manifest refused any binding the host takes first
    // (spec/input.md §7.1) — a reserved binding never reaches this table.
    event.preventDefault();
    say(`key ${formatBinding(chordOf(event))} → ${command}`);
    void kernel.services.commands.get(command)?.run();
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

    // Awaited *before* any window opens. spec/kernel.md step 9: geometry is restored before
    // Applications start, so a window comes back where it was rather than appearing at a default
    // position and jumping once the hive answers.
    const remembered = await persistence.restore();
    const placed = new Map(remembered.map((w) => [w.view, w]));

    // One window per view. In windowed mode they cascade — unless this device remembers where they
    // were left, in which case they come back there. Opened in saved order, so stacking is restored
    // without storing a z-index that could disagree with it.
    const order = remembered.length > 0
        ? remembered.map((w) => w.view)
        : ['masthead', 'sidebar', 'reader', 'colophon'];

    for (const view of order) {
        const id = kernel.services.windows.open(pid, view, {});
        const saved = placed.get(view);
        if (saved === undefined) continue;

        const record = manager.get(id);
        if (record === undefined) continue;
        record.rect = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
        record.state = saved.state;
    }

    // Nudge the paint effect, since the rects above were assigned rather than set through a signal.
    manager.windows.set([...manager.windows()]);

    // Only now start saving. Watching before the restore would let the first effect run write the
    // defaults straight over what was just read.
    persistence.watch();

    updateModeButton();

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
    const policy = persistence.modePolicy();

    // A2.7. There is no locking mechanism to consult — the window manager reads a setting, and a
    // locked deployment made that setting one nobody can change. The refusal carries the reason,
    // so the shell can say why rather than doing nothing.
    if (policy.locked) {
        say(`mode is locked: ${policy.reason ?? 'set by policy'}`);
        kernel.services.notifications.set([
            ...kernel.services.notifications(),
            {
                id: `locked-${String(Date.now())}`,
                level: 'warn',
                source: 'window-manager',
                message: policy.reason ?? 'The window mode is set by policy and cannot be changed here.',
            },
        ]);
        return;
    }

    const next = manager.mode() === 'tiled' ? 'windowed' : 'tiled';
    void persistence.setMode(next).catch((error: unknown) => say(`mode: ${String(error)}`));
    say(`mode → ${next}`);
    updateModeButton();
}

/** The control reflects the policy: a locked deployment does not offer a switch that will refuse. */
function updateModeButton(): void {
    const button = document.getElementById('mode');
    if (button === null) return;

    const policy = persistence.modePolicy();
    button.textContent = manager.mode() === 'tiled' ? 'Windowed' : 'Tiled';

    if (policy.locked) {
        button.setAttribute('disabled', '');
        button.title = policy.reason ?? 'Set by policy.';
        button.textContent = `${manager.mode() === 'tiled' ? 'Tiled' : 'Windowed'} (locked)`;
    } else {
        button.removeAttribute('disabled');
        button.title = 'Switch between windowed and tiled';
    }
}

void main().catch((error: unknown) => say(`boot failed: ${String(error)}`));
