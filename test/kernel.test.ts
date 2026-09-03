import { describe, expect, it, vi } from 'vitest';

import {
    Kernel, construct, consumes, needs, provider,
    type Application, type Context, type Extension,
} from '../src/index.js';
import { flushSync } from '../src/reactivity/index.js';

// ---------------------------------------------------------------------------- fixtures

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
        return {
            signedIn: () => session(),
            signIn: () => session.set(true),
        };
    }
}

const APP_NEEDS = needs('commands', 'windows', 'notifications');
const APP_CONSUMES = consumes(AUTH);

class BlogApp implements Application<typeof APP_NEEDS, typeof APP_CONSUMES> {
    readonly needs = APP_NEEDS;
    readonly consumes = APP_CONSUMES;

    readonly commands = [{ id: 'blog.newPost', title: 'Blog: New Post' }];
    readonly keys = [{ command: 'blog.newPost', keys: 'ctrl+n', gamepad: 'Y' }];
    readonly views = [{ id: 'editor', title: 'Editor', tile: 'content', instances: 'many' as const }];

    started = 0;
    stopped = 0;

    async start(cx: Context<typeof APP_NEEDS, typeof APP_CONSUMES>): Promise<void> {
        this.started++;
        const auth = cx.use(AUTH);

        cx.commands.implement('blog.newPost', () => {
            if (!auth.signedIn()) {
                cx.notifications.warn('Sign in first.');
                return;
            }
            cx.windows.open({ view: 'editor', params: { slug: '' } });
        });
    }

    async stop(): Promise<void> {
        this.stopped++;
    }
}

const load = (id: string, contribution: object) => ({ id, contribution: contribution as never });

// ---------------------------------------------------------------------------- narrowing

describe('the context carries exactly what was declared', () => {
    it('has the declared capabilities and nothing else', () => {
        const kernel = new Kernel();
        let seen: readonly string[] = [];

        class Probe implements Extension<typeof AUTH_NEEDS> {
            readonly needs = AUTH_NEEDS;
            activate(cx: Context<typeof AUTH_NEEDS>): void {
                seen = Object.keys(cx).sort();
                void cx.state;
                void cx.log;
            }
        }

        kernel.boot([load('probe', new Probe())]);

        expect(seen).toEqual(['id', 'log', 'onDispose', 'state', 'use']);
        // The compile error is the first line of defence. This is the run-time half of it:
        // an undeclared capability is not on the object, so both agree.
        expect(seen).not.toContain('windows');
        expect(seen).not.toContain('commands');
    });

    it('refuses a provider that was not declared in consumes', () => {
        const kernel = new Kernel();
        const OTHER = provider<{ x: number }>('other');
        let error: unknown;

        class Sneak implements Extension<readonly []> {
            readonly needs = [] as const;
            activate(cx: Context<readonly []>): void {
                try {
                    (cx as unknown as { use(t: unknown): unknown }).use(OTHER);
                } catch (e) {
                    error = e;
                }
            }
        }

        kernel.boot([load('sneak', new Sneak())]);
        expect(String(error)).toMatch(/used provider "other" without declaring it/);
    });
});

describe('capabilities are scoped to who asked', () => {
    it('tags logs with their source, and the caller cannot forge one', () => {
        const kernel = new Kernel();
        kernel.boot([load('auth', new AuthExtension())]);

        expect(kernel.services.logs).toEqual([
            { level: 'info', source: 'auth', message: 'auth ready' },
        ]);
    });

    it('knows who opened a window', async () => {
        const kernel = new Kernel();
        kernel.boot([load('auth', new AuthExtension()), load('blog', new BlogApp())]);

        const pid = await kernel.start('blog');
        const auth = kernel.extensions.find((e) => e.id === 'auth')!.api as AuthApi;
        auth.signIn();

        await kernel.services.commands.get('blog.newPost')!.run();

        expect(kernel.services.windows).toHaveLength(1);
        expect(kernel.services.windows[0]).toMatchObject({ owner: pid, view: 'editor' });
    });
});

// ---------------------------------------------------------------------------- manifest

describe('manifests merge before anything runs', () => {
    it('populates commands and bindings for an Application that has not started', () => {
        const kernel = new Kernel();
        kernel.boot([load('auth', new AuthExtension()), load('blog', new BlogApp())]);

        expect(kernel.processes).toHaveLength(0); // nothing started
        expect(kernel.manifest.commands.get('blog.newPost')?.by).toBe('blog');
        expect([...kernel.manifest.bindings.keys()].sort()).toEqual(['ctrl+n', 'gamepad:Y']);
        expect(kernel.manifest.views.get('blog/editor')?.decl.title).toBe('Editor');
    });

    it('reports two Applications claiming one binding, at load time', () => {
        const kernel = new Kernel();

        class Other implements Application<readonly []> {
            readonly needs = [] as const;
            readonly commands = [{ id: 'other.new', title: 'Other: New' }];
            readonly keys = [{ command: 'other.new', keys: 'ctrl+n' }];
            async start(): Promise<void> {}
        }

        kernel.boot([load('auth', new AuthExtension()), load('blog', new BlogApp()), load('other', new Other())]);

        const conflict = kernel.manifest.conflicts.find((c) => c.kind === 'binding');
        expect(conflict?.key).toBe('ctrl+n');
        expect(conflict?.claimants).toEqual(['blog', 'other']);
    });

    it('catches a binding pointing at a command nothing declares', () => {
        const kernel = new Kernel();

        class Dangling implements Application<readonly []> {
            readonly needs = [] as const;
            readonly keys = [{ command: 'nope.missing', keys: 'ctrl+k' }];
            async start(): Promise<void> {}
        }

        kernel.boot([load('dangling', new Dangling())]);
        expect(kernel.manifest.conflicts[0]?.message).toMatch(/bound "ctrl\+k".*which nothing declares/);
    });

    it('refuses a command implementation that was never declared', async () => {
        const kernel = new Kernel();

        class Undeclared implements Application<readonly ['commands']> {
            readonly needs = needs('commands');
            async start(cx: Context<readonly ['commands']>): Promise<void> {
                cx.commands.implement('ghost.command', () => {});
            }
        }

        kernel.boot([load('undeclared', new Undeclared())]);
        const pid = await kernel.start('undeclared');

        const entry = kernel.processes.find((p) => p.pid === pid)!;
        expect(entry.state).toBe('failed');
        expect(String(entry.error)).toMatch(/which nothing declared/);
    });
});

// ---------------------------------------------------------------------------- provider graph

describe('the provider graph decides activation order', () => {
    it('activates a provider before its consumer', () => {
        const kernel = new Kernel();
        const order: string[] = [];

        const A = provider<{ n: number }>('a');

        class Provider implements Extension<readonly [], readonly [], typeof A> {
            readonly needs = [] as const;
            readonly provides = A;
            activate(): { n: number } {
                order.push('provider');
                return { n: 1 };
            }
        }

        class Consumer implements Extension<readonly [], readonly [typeof A]> {
            readonly needs = [] as const;
            readonly consumes = consumes(A);
            activate(cx: Context<readonly [], readonly [typeof A]>): void {
                order.push(`consumer:${cx.use(A).n}`);
            }
        }

        // Declared consumer-first on purpose: order must come from the graph, not the input.
        kernel.boot([load('consumer', new Consumer()), load('provider', new Provider())]);
        expect(order).toEqual(['provider', 'consumer:1']);
    });

    it('fails a consumer whose provider is missing, without failing boot', () => {
        const kernel = new Kernel();
        const Missing = provider<{ x: number }>('missing');

        class Orphan implements Extension<readonly [], readonly [typeof Missing]> {
            readonly needs = [] as const;
            readonly consumes = consumes(Missing);
            activate(): void {}
        }

        kernel.boot([load('auth', new AuthExtension()), load('orphan', new Orphan())]);

        expect(kernel.extensions.find((e) => e.id === 'orphan')?.state).toBe('failed');
        expect(kernel.extensions.find((e) => e.id === 'auth')?.state).toBe('activated');
    });

    it('cascades a failure to consumers, naming the root', () => {
        const kernel = new Kernel();
        const Missing = provider<{ x: number }>('missing');
        const Middle = provider<{ y: number }>('middle');

        class Mid implements Extension<readonly [], readonly [typeof Missing], typeof Middle> {
            readonly needs = [] as const;
            readonly consumes = consumes(Missing);
            readonly provides = Middle;
            activate(): { y: number } {
                return { y: 1 };
            }
        }

        class Leaf implements Extension<readonly [], readonly [typeof Middle]> {
            readonly needs = [] as const;
            readonly consumes = consumes(Middle);
            activate(): void {}
        }

        kernel.boot([load('mid', new Mid()), load('leaf', new Leaf())]);

        expect(kernel.extensions.find((e) => e.id === 'leaf')?.state).toBe('failed');
        expect(String(kernel.extensions.find((e) => e.id === 'leaf')?.error))
            .toMatch(/depends on mid, which failed: no contribution provides "missing"/);
    });

    it('a cycle is a boot failure naming both ends', () => {
        const kernel = new Kernel();
        const A = provider<object>('a');
        const B = provider<object>('b');

        class First implements Extension<readonly [], readonly [typeof B], typeof A> {
            readonly needs = [] as const;
            readonly consumes = consumes(B);
            readonly provides = A;
            activate(): object {
                return {};
            }
        }
        class Second implements Extension<readonly [], readonly [typeof A], typeof B> {
            readonly needs = [] as const;
            readonly consumes = consumes(A);
            readonly provides = B;
            activate(): object {
                return {};
            }
        }

        expect(() => kernel.boot([load('first', new First()), load('second', new Second())]))
            .toThrow(/Provider cycle: first → second → first/);
    });

    it('refuses two contributions providing one token', () => {
        const kernel = new Kernel();
        class A1 implements Extension<readonly [], readonly [], typeof AUTH> {
            readonly needs = [] as const;
            readonly provides = AUTH;
            activate(): AuthApi {
                return { signedIn: () => false, signIn: () => {} };
            }
        }

        expect(() => kernel.boot([load('auth', new AuthExtension()), load('other', new A1())]))
            .toThrow(/offered by both auth and other/);
    });
});

// ---------------------------------------------------------------------------- failure

describe('fault containment', () => {
    it('an Extension throwing during activate does not stop boot', () => {
        const kernel = new Kernel();

        class Broken implements Extension<readonly []> {
            readonly needs = [] as const;
            activate(): void {
                throw new Error('boom');
            }
        }

        kernel.boot([load('broken', new Broken()), load('auth', new AuthExtension())]);

        expect(kernel.extensions.find((e) => e.id === 'broken')?.state).toBe('failed');
        expect(kernel.extensions.find((e) => e.id === 'auth')?.state).toBe('activated');
    });

    it('a failed Application rests in the table with its error', async () => {
        const kernel = new Kernel();

        class Crashy implements Application<readonly []> {
            readonly needs = [] as const;
            async start(): Promise<void> {
                throw new Error('nope');
            }
        }

        kernel.boot([load('crashy', new Crashy())]);
        const pid = await kernel.start('crashy');

        const entry = kernel.processes.find((p) => p.pid === pid)!;
        expect(entry.state).toBe('failed');
        expect(entry.error?.message).toBe('nope');
        // Not a disappearance: an Application that vanishes on error is one nobody can debug.
        expect(kernel.processes).toHaveLength(1);
    });
});

// ---------------------------------------------------------------------------- processes

describe('the process table', () => {
    it('assigns the pid, and two instances are possible', async () => {
        const kernel = new Kernel();

        class Multi implements Application<readonly []> {
            readonly needs = [] as const;
            async start(): Promise<void> {}
        }

        kernel.boot([load('multi', new Multi())]);
        const a = await kernel.start('multi');
        const b = await kernel.start('multi');

        expect(a).not.toBe(b);
        expect(kernel.processes.map((p) => p.instance)).toEqual([1, 2]);
        // Identity comes from the kernel, not the bundle — which is what defineApp got wrong.
        expect(kernel.processes.every((p) => p.applicationId === 'multi')).toBe(true);
    });

    it('honours singleton', async () => {
        const kernel = new Kernel();

        class Only implements Application<readonly []> {
            readonly needs = [] as const;
            readonly singleton = true;
            async start(): Promise<void> {}
        }

        kernel.boot([load('only', new Only())]);
        await kernel.start('only');
        await expect(kernel.start('only')).rejects.toThrow(/singleton and is already running/);
    });

    it('stop disposes what the kernel handed out, whether stop() succeeds or not', async () => {
        const kernel = new Kernel();
        kernel.boot([load('auth', new AuthExtension()), load('blog', new BlogApp())]);

        const pid = await kernel.start('blog');
        expect(kernel.services.commands.has('blog.newPost')).toBe(true);

        await kernel.stop(pid);

        expect(kernel.services.commands.has('blog.newPost')).toBe(false);
        expect(kernel.processes.find((p) => p.pid === pid)?.state).toBe('stopped');
    });

    it('disposes even when stop() throws', async () => {
        const kernel = new Kernel();

        class BadStop implements Application<readonly ['commands']> {
            readonly needs = needs('commands');
            readonly commands = [{ id: 'bad.go', title: 'Go' }];
            async start(cx: Context<readonly ['commands']>): Promise<void> {
                cx.commands.implement('bad.go', () => {});
            }
            async stop(): Promise<void> {
                throw new Error('teardown failed');
            }
        }

        kernel.boot([load('bad', new BadStop())]);
        const pid = await kernel.start('bad');
        await kernel.stop(pid);

        expect(kernel.services.commands.has('bad.go')).toBe(false);
        expect(kernel.processes.find((p) => p.pid === pid)?.error?.message).toBe('teardown failed');
    });

    it('restart produces a new pid and does not carry state over', async () => {
        const kernel = new Kernel();
        const app = new BlogApp();
        kernel.boot([load('auth', new AuthExtension()), load('blog', app)]);

        const first = await kernel.start('blog');
        const second = await kernel.restart(first);

        expect(second).not.toBe(first);
        expect(app.started).toBe(2);
        expect(app.stopped).toBe(1);
    });

    it('disposes a contribution effects when its process stops', async () => {
        const kernel = new Kernel();
        const watched = vi.fn();

        class Watcher implements Application<readonly ['state']> {
            readonly needs = needs('state');
            async start(cx: Context<readonly ['state']>): Promise<void> {
                const n = cx.state.signal(0);
                cx.state.effect(() => watched(n()));
                this.bump = () => n.set(n() + 1);
            }
            bump: () => void = () => {};
        }

        const app = new Watcher();
        kernel.boot([load('watcher', app)]);
        const pid = await kernel.start('watcher');

        app.bump();
        flushSync();
        const before = watched.mock.calls.length;

        await kernel.stop(pid);
        app.bump();
        flushSync();

        expect(watched).toHaveBeenCalledTimes(before);
    });
});

// ---------------------------------------------------------------------------- construction

describe('construct checks a bundle before trusting it', () => {
    it('accepts a class exporting default', () => {
        expect(construct({ default: AuthExtension }, 'auth.js')).toBeInstanceOf(AuthExtension);
    });

    it('rejects a bundle with no default export', () => {
        expect(() => construct({}, 'x.js')).toThrow(/must export default a class.*no default export/s);
    });

    it('rejects a plain object', () => {
        expect(() => construct({ default: { activate() {} } }, 'x.js'))
            .toThrow(/must export default a class/);
    });

    it('rejects something that is neither', () => {
        expect(() => construct({ default: class {} }, 'x.js'))
            .toThrow(/neither an Extension nor an Application/);
    });

    it('rejects something that is both', () => {
        class Both {
            activate(): void {}
            async start(): Promise<void> {}
        }
        expect(() => construct({ default: Both }, 'x.js')).toThrow(/both activate\(\) and start\(\)/);
    });

    it('says plainly when a constructor did work it should not have', () => {
        class SideEffect {
            constructor() {
                throw new Error('opened a socket');
            }
            activate(): void {}
        }
        expect(() => construct({ default: SideEffect }, 'x.js'))
            .toThrow(/constructor must be side-effect free/);
    });
});
