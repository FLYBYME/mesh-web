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
    Kernel, WindowManager, command, consumes, createRegistry, each, effect, element, mountView,
    needs, provider, text, when, windowSink, PRIMITIVES,
    type Action, type Application, type Context, type Extension, type ViewContext, type ViewInstance,
} from '@flybyme/mesh-web';

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
    add(): void;
}
const BLOG = provider<BlogApi>('demo.blog');

const BLOG_NEEDS = needs('state', 'commands', 'windows', 'notifications');
const BLOG_CONSUMES = consumes(AUTH);

class BlogApp implements Application<typeof BLOG_NEEDS, typeof BLOG_CONSUMES, typeof BLOG> {
    readonly needs = BLOG_NEEDS;
    readonly consumes = BLOG_CONSUMES;
    readonly provides = BLOG;

    readonly commands = [
        { id: 'blog.open', title: 'Blog: Open Post' },
        { id: 'blog.publish', title: 'Blog: Publish Post' },
        { id: 'blog.add', title: 'Blog: New Post' },
    ];

    readonly keys = [{ command: 'blog.add', keys: 'alt+n', gamepad: 'Y' }];

    readonly views = [
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

    async start(cx: Context<typeof BLOG_NEEDS, typeof BLOG_CONSUMES>): Promise<BlogApi> {
        const auth = cx.use(AUTH);
        const posts = cx.state.signal<readonly Post[]>([
            { slug: 'a', title: 'A window you can drag', published: true },
            { slug: 'b', title: 'Fine-grained, no diffing', published: false },
            { slug: 'c', title: 'The kernel drives everything', published: false },
        ]);

        let n = 0;

        const publish = (slug: string): void =>
            posts.set(posts().map((p) => (p.slug === slug ? { ...p, published: !p.published } : p)));

        cx.commands.implement('blog.open', () => {
            if (!auth.signedIn()) {
                cx.notifications.warn('Sign in first.');
                return;
            }
            cx.windows.open({ view: 'sidebar' });
        });

        cx.commands.implement('blog.publish', (slug) => publish(String(slug)));

        cx.commands.implement('blog.add', () => {
            n += 1;
            posts.set([...posts(), { slug: `n${n}`, title: `Untitled ${n}`, published: false }]);
        });

        return {
            posts,
            canWrite: () => auth.signedIn(),
            publish,
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

    for (const record of stacked) {
        let frame = frames.get(record.id);
        if (frame === undefined) {
            frame = createFrame(record.id);
            frames.set(record.id, frame);
            say(`window ${record.id} opened`);
        }

        const { host } = frame;
        host.style.left = `${record.rect.x}px`;
        host.style.top = `${record.rect.y}px`;
        host.style.width = `${record.rect.width}px`;
        host.style.height = `${record.rect.height}px`;
        host.style.zIndex = String(manager.zIndexOf(record.id));
        host.classList.toggle('focused', manager.focused() === record.id);
        host.hidden = record.state === 'minimized';
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

    await kernel.services.commands.get('blog.open')!.run();

    document.getElementById('stop')!.addEventListener('click', () => {
        void kernel.stop(pid).then(() => say('blog stopped — its windows went with it'));
    });
}

void main().catch((error: unknown) => say(`boot failed: ${String(error)}`));
