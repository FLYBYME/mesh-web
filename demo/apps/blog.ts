/**
 * A blog, as an Application.
 *
 * The point of this demo: a blog and an IDE are the same kind of thing to this framework. A blog is
 * an Application whose views happen to be arranged as tiles named header / sidebar / content /
 * footer. Switch it to windowed mode and the header becomes a window you can drag.
 *
 * Nothing below knows which mode it is in. That is the whole claim — spec/README.md §3.
 */

import {
    needs,
    consumes,
    provider,
    view,
    h,
    when,
    each,
    type Application,
    type Context,
    type ViewContext,
} from '@flybyme/mesh-web';

import { AUTH, type AuthApi } from '../contracts/auth.js';

// ---------------------------------------------------------------------------- declarations

const NEEDS = needs('net', 'windows', 'commands', 'keys', 'notifications', 'state');
const CONSUMES = consumes(AUTH);

export interface Post {
    readonly id: string;
    readonly title: string;
    readonly slug: string;
    readonly body: string;
    readonly published: boolean;
}

export interface BlogApi {
    readonly posts: () => readonly Post[];
    openPost(slug: string): void;
    refresh(): Promise<void>;
}

export const BLOG = provider<BlogApi>('demo.blog');

// ---------------------------------------------------------------------------- the Application

export default class BlogApp implements Application<typeof NEEDS, typeof CONSUMES, typeof BLOG> {
    readonly needs = NEEDS;
    readonly consumes = CONSUMES;
    readonly provides = BLOG;

    /** Only one blog per site. An editor would leave this off. */
    readonly singleton = true;

    // Set in start(). Views read through these rather than closing over start()'s locals, because
    // a view can be mounted, unmounted and remounted while the Application keeps running.
    #auth!: AuthApi;
    #posts!: () => readonly Post[];
    #open!: (slug: string) => void;

    /**
     * The catalogue of view *types*.
     *
     * Declared statically, not registered in start(), because the kernel restores window geometry
     * at boot step 7 and starts Applications at step 8 — so it must already know these exist and
     * what size they default to, or every window would appear at a default position and jump once
     * start() resolved. spec/application.md §6.
     */
    readonly views = [
        view({
            id: 'header',
            title: 'Header',
            tile: 'header',
            instances: 'one',
            closable: false,
            default: { height: 64 },
            mount: (el, vx) => this.#mountHeader(el, vx),
        }),

        view({
            id: 'sidebar',
            title: 'Posts',
            tile: 'sidebar',
            instances: 'one',
            default: { width: 240, minWidth: 180 },
            mount: (el, vx) => this.#mountSidebar(el, vx),
        }),

        view({
            id: 'content',
            title: 'Reading',
            tile: 'content',
            instances: 'one',
            closable: false,
            default: { width: 760, minWidth: 320 },
            mount: (el, vx) => this.#mountContent(el, vx),
        }),

        view({
            id: 'footer',
            title: 'Footer',
            tile: 'footer',
            instances: 'one',
            closable: false,
            default: { height: 48 },
            mount: (el) => {
                el.append(h('p', { class: 'blog-footer' }, '© 2026 · built on mesh-web'));
            },
        }),

        /**
         * The one view that is not a website region.
         *
         * `instances: 'many'` — open two and you get two editors, each with its own geometry,
         * because instance identity is the view id plus a key from `params`. This is the thing
         * mesh-ui could not do: its ViewRegistry kept one container per provider id.
         */
        view({
            id: 'editor',
            title: 'Editor',
            tile: 'content',
            instances: 'many',
            default: { width: 820, height: 620, minWidth: 400 },
            mount: (el, vx: ViewContext<{ slug: string }>) => this.#mountEditor(el, vx),
        }),
    ];

    // ------------------------------------------------------------------------ lifecycle

    async start(cx: Context<typeof NEEDS, typeof CONSUMES>): Promise<BlogApi> {
        // Typed across a boundary this file never imports over. Remove AUTH from CONSUMES above
        // and this line is a compile error.
        this.#auth = cx.use(AUTH);

        const posts = cx.state.signal<readonly Post[]>([]);
        this.#posts = posts;

        const refresh = async (): Promise<void> => {
            posts.set(await cx.net.get<readonly Post[]>('/api/posts'));
        };

        this.#open = (slug: string) => {
            // A route and a click are the same operation — both ask the window manager for a view
            // instance. spec/application.md §9.
            cx.windows.open({ view: 'editor', params: { slug } });
        };

        // Commands are the unit of "a thing that can happen". A menu item, a key binding and the
        // command palette all point at one, so none of them needs its own handler.
        cx.commands.register({
            id: 'blog.newPost',
            title: 'Blog: New Post',
            handler: () => {
                if (!this.#auth.can('post.write')) {
                    cx.notifications.warn('You do not have permission to write posts.');
                    return;
                }
                cx.windows.open({ view: 'editor', params: { slug: '' } });
            },
        });

        cx.commands.register({
            id: 'blog.refresh',
            title: 'Blog: Refresh',
            handler: refresh,
        });

        // Bindings are data and go through one parser. The deleted runtime compared a configured
        // hotkey against a string literal, so any other binding silently never fired —
        // spec/roadmap.md A1.4.
        cx.keys.bind('ctrl+n', 'blog.newPost');
        cx.keys.bind('ctrl+r', 'blog.refresh');

        await refresh();

        return {
            posts,
            openPost: this.#open,
            refresh,
        };
    }

    async stop(): Promise<void> {
        // Nothing. Windows, commands, bindings and subscriptions are disposed by the kernel,
        // because the case that has to work is the one that crashed before it could clean up.
        // `stop` is only for this Application's own concerns — an unsaved draft, an open stream.
    }

    // ------------------------------------------------------------------------ views

    #mountHeader(el: HTMLElement, _vx: ViewContext): void {
        el.append(
            h('header', { class: 'blog-header' },
                h('h1', null, 'A blog'),
                h('nav', null,
                    // `when` re-evaluates because `session` is a signal. No subscription to manage.
                    when(() => this.#auth.signedIn(), () =>
                        h('span', null, `Hello, ${this.#auth.session()?.displayName ?? ''}`)),
                    when(() => !this.#auth.signedIn(), () =>
                        h('button', { onclick: () => void this.#auth.signIn() }, 'Sign in')),
                ),
            ),
        );
    }

    #mountSidebar(el: HTMLElement, _vx: ViewContext): void {
        el.append(
            h('ul', { class: 'blog-post-list' },
                each(this.#posts, (post) =>
                    h('li', { onclick: () => this.#open(post.slug) },
                        post.title,
                        when(() => !post.published, () => h('em', null, ' — draft')),
                    ),
                ),
            ),
        );
    }

    #mountContent(el: HTMLElement, _vx: ViewContext): void {
        el.append(
            h('article', { class: 'blog-content' },
                each(this.#posts, (post) =>
                    when(() => post.published, () =>
                        h('section', null,
                            h('h2', null, post.title),
                            h('div', { innerHTML: post.body }),
                        ),
                    ),
                ),
            ),
        );
    }

    #mountEditor(el: HTMLElement, vx: ViewContext<{ slug: string }>): void {
        // `params` is what makes this instance distinct from the other editor. Geometry persists
        // per instance, so two editors remember their own sizes.
        const existing = this.#posts().find((p) => p.slug === vx.params.slug);
        vx.setTitle(existing ? `Editing: ${existing.title}` : 'New post');

        el.append(
            h('form', { class: 'blog-editor' },
                h('input', { name: 'title', value: existing?.title ?? '', placeholder: 'Title' }),
                h('textarea', { name: 'body' }, existing?.body ?? ''),
                h('button', { type: 'submit' }, 'Save'),
            ),
        );

        vx.onDispose(() => {
            // View-scoped teardown. Called when this window closes — not when the Application
            // stops, and not on a mode switch, which does not remount anything at all.
        });
    }
}
