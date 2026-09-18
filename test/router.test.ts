/**
 * `routerSink` — the real `RouterSink`, against a real `Kernel` and `WindowManager` (same reasoning
 * as `chrome.test.ts`: the claim being tested is that navigating actually moves the window manager's
 * `foreground`, and a recording sink has nothing to be right or wrong about there). `history` is
 * faked, the same way `Composition.window` is injectable in `start.ts` — a test that would rather not
 * touch a real `location`.
 *
 * `current()` resolves immediately -- `explicit ?? matchFromURL() ?? kernel.applications[0]` -- and
 * never needs `resync()` called first (a prior version of this required it, and that requirement was
 * itself the bug `ConsoleChrome` tripped: it checked `current() === undefined` to mean "nothing has
 * chosen yet," which was **always** true before the first `resync()`, whatever the real URL said).
 * `resync()` still exists for the one thing that genuinely needs re-applying once
 * `kernel.processes` has real pids in it: `manager.foreground()`, not `current()`.
 */
import { describe, expect, it } from 'vitest';

import { Kernel, KEEPS_NOTHING, needs, type Application, type Context } from '../src/index.js';
import { WindowManager } from '../src/window/manager.js';
import { routerSink, type HistoryLike } from '../src/router/router.js';

const APP_NEEDS = needs('windows');

class App implements Application<typeof APP_NEEDS> {
    readonly needs = APP_NEEDS;
    async start(): Promise<typeof KEEPS_NOTHING> {
        return KEEPS_NOTHING;
    }
}

class TitledApp extends App {
    readonly title = 'Repos';
}

/** A `HistoryLike` a test can drive directly, instead of a real `location`. */
function fakeHistory(initial = ''): HistoryLike & { fire(path: string): void } {
    let path = initial;
    let listener: (() => void) | undefined;

    return {
        pathname: () => path.split('?')[0]!,
        search: () => (path.includes('?') ? `?${path.split('?')[1]}` : ''),
        push: (next) => { path = next; },
        back: () => {},
        onChange: (fn) => { listener = fn; return () => { listener = undefined; }; },
        fire(next) { path = next; listener?.(); },
    } as HistoryLike & { fire(path: string): void };
}

async function twoApps(): Promise<{ kernel: Kernel; manager: WindowManager }> {
    const manager = new WindowManager();
    const kernel = new Kernel();
    kernel.boot([
        { id: 'platform/repo', contribution: new App() as never },
        { id: 'platform/gitserver', contribution: new App() as never },
    ]);
    await kernel.start('platform/repo');
    await kernel.start('platform/gitserver');
    return { kernel, manager };
}

describe('routerSink', () => {
    it('lists every Application, falling back to the id when it declared no title', async () => {
        const { kernel, manager } = await twoApps();
        const router = routerSink(kernel, manager, fakeHistory());

        expect(router.applications()).toEqual([
            { id: 'platform/repo', title: 'platform/repo' },
            { id: 'platform/gitserver', title: 'platform/gitserver' },
        ]);
    });

    it('uses the declared title when a contribution has one', async () => {
        const manager = new WindowManager();
        const kernel = new Kernel();
        kernel.boot([{ id: 'platform/repo', contribution: new TitledApp() as never }]);
        await kernel.start('platform/repo');

        const router = routerSink(kernel, manager, fakeHistory());

        expect(router.applications()).toEqual([{ id: 'platform/repo', title: 'Repos' }]);
    });

    it('resolves the current Application from the initial URL immediately, with no resync() needed', async () => {
        const { kernel, manager } = await twoApps();
        const router = routerSink(kernel, manager, fakeHistory('/platform/gitserver'));

        expect(router.current()).toBe('platform/gitserver');
    });

    it('falls back to the first Application when the URL names none', async () => {
        const { kernel, manager } = await twoApps();
        const router = routerSink(kernel, manager, fakeHistory('/nowhere'));

        expect(router.current()).toBe('platform/repo');
    });

    it('does not restrict foreground when nothing has actually navigated', async () => {
        // The regression this guards: a composition with several Applications and no chrome/switcher
        // at all -- sharing one ordinary window pool, exactly like `single.browser.test.ts`'s two
        // Applications -- must see every window stay visible until something explicitly picks one.
        // An unmatched URL used to restrict to the first Application unconditionally, which hid the
        // second Application's windows on every multi-Application boot whether anything asked for
        // app-switching or not.
        const { kernel, manager } = await twoApps();
        const router = routerSink(kernel, manager, fakeHistory('/nowhere'));

        expect(router.current()).toBe('platform/repo');
        expect(manager.foreground()).toBeUndefined();
    });

    it('a URL that explicitly names an Application restricts foreground immediately', async () => {
        const { kernel, manager } = await twoApps();
        routerSink(kernel, manager, fakeHistory('/platform/gitserver'));

        const gitserverPid = kernel.processes.find((p) => p.applicationId === 'platform/gitserver')!.pid;
        expect(manager.foreground()).toEqual(new Set([gitserverPid]));
    });

    it('navigate() restricts foreground for real, even from an unmatched initial URL', async () => {
        const { kernel, manager } = await twoApps();
        const router = routerSink(kernel, manager, fakeHistory('/nowhere'));

        router.navigate('platform/repo');

        const repoPid = kernel.processes.find((p) => p.applicationId === 'platform/repo')!.pid;
        expect(manager.foreground()).toEqual(new Set([repoPid]));
    });

    it('navigate() to where the URL already resolves is a no-op on history (no duplicate entry)', async () => {
        const { kernel, manager } = await twoApps();
        const history = fakeHistory('/platform/gitserver');
        const router = routerSink(kernel, manager, history);
        let pushed = 0;
        const originalPush = history.push;
        history.push = (path) => { pushed++; originalPush(path); };

        // ConsoleChrome's own activation does exactly this: navigate(current()) unconditionally.
        router.navigate(router.current()!);

        expect(pushed).toBe(0);
        expect(router.current()).toBe('platform/gitserver');
    });

    it('navigate() pushes a path and moves the window manager\'s foreground', async () => {
        const { kernel, manager } = await twoApps();
        const history = fakeHistory();
        const router = routerSink(kernel, manager, history);

        router.navigate('platform/gitserver');

        expect(router.current()).toBe('platform/gitserver');
        expect(history.pathname()).toBe('/platform/gitserver');
        const gitserverPid = kernel.processes.find((p) => p.applicationId === 'platform/gitserver')!.pid;
        expect(manager.foreground()).toEqual(new Set([gitserverPid]));
    });

    it('refuses to navigate to an id nothing loaded', async () => {
        const { kernel, manager } = await twoApps();
        const router = routerSink(kernel, manager, fakeHistory());

        expect(() => router.navigate('no-such-app')).toThrow(/no Application by that id/);
    });

    it('a browser back/forward (onChange) reparses the location', async () => {
        const { kernel, manager } = await twoApps();
        const history = fakeHistory('/platform/repo');
        const router = routerSink(kernel, manager, history);

        expect(router.current()).toBe('platform/repo');
        history.fire('/platform/gitserver');
        expect(router.current()).toBe('platform/gitserver');
    });

    it('dispose() stops applying foreground automatically on further changes', async () => {
        // `current()` itself stays a live read of the URL even after dispose() -- there is no cached
        // value left to freeze, which is the fix this file is named after. What dispose() actually
        // stops is the popstate-driven side effect: manager.foreground() no longer follows along.
        const { kernel, manager } = await twoApps();
        const history = fakeHistory('/platform/repo');
        const router = routerSink(kernel, manager, history);
        const repoPid = kernel.processes.find((p) => p.applicationId === 'platform/repo')!.pid;
        expect(manager.foreground()).toEqual(new Set([repoPid]));

        router.dispose();
        history.fire('/platform/gitserver');

        expect(router.current()).toBe('platform/gitserver');
        expect(manager.foreground()).toEqual(new Set([repoPid]));
    });

    it('resync() re-applies foreground once kernel.processes has real pids to find', async () => {
        // Simulates start.ts's real ordering: the router is constructed before boot(), when
        // kernel.applications is still empty, so the eager apply at construction is a no-op; resync()
        // is what start.ts calls once open() has actually started every Application.
        const manager = new WindowManager();
        const kernel = new Kernel();
        const router = routerSink(kernel, manager, fakeHistory('/platform/gitserver'));
        expect(manager.foreground()).toBeUndefined();

        kernel.boot([
            { id: 'platform/repo', contribution: new App() as never },
            { id: 'platform/gitserver', contribution: new App() as never },
        ]);
        await kernel.start('platform/repo');
        await kernel.start('platform/gitserver');

        router.resync();

        const gitserverPid = kernel.processes.find((p) => p.applicationId === 'platform/gitserver')!.pid;
        expect(manager.foreground()).toEqual(new Set([gitserverPid]));
    });
});
