import { describe, expect, it } from 'vitest';
import { IoManager } from '../../src/kernel/io.js';
import { createContext, createServices } from '../../src/kernel/broker.js';
import { HOST_WINDOW_DRIVER, ONLINE_DRIVER, type HostWindowDriver, type OnlineDriver } from '../../src/kernel/drivers.js';
import { needs, type CapabilityName } from '../../src/contribution/capabilities.js';
import { App, createAppRuntime, Service } from '../../src/app/index.js';

/** The context an App with these needs is granted on a page whose drivers are `io` — as `startApp` builds it. */
function grant(io: IoManager, declared: readonly CapabilityName[]) {
    return createContext({ id: 'test', declaredBy: 'test' }, declared, [], (token) => io.get(token), createServices(), io).context;
}

describe('drivers seam', () => {
    it('lets a service declare needs("online") and use the driver', () => {
        let watched = false;
        const fakeOnline: OnlineDriver = {
            isOnline: true,
            watch: () => { watched = true; return () => {}; },
        };
        const io = new IoManager();
        io.register(ONLINE_DRIVER, fakeOnline);

        let seen: boolean | undefined;
        /**
         * Typed through its spec rather than cast: `this.cx.online` resolves because `needs('online')`
         * says so, and the test stops compiling the day the capability is renamed or dropped — which
         * is the thing worth knowing.
         */
        const Base = Service({ needs: needs('online') });
        class Watcher extends Base {
            constructor(...args: ConstructorParameters<typeof Base>) {
                super(...args);
                seen = this.cx.online.isOnline;
                this.cx.online.watch(() => {});
            }
        }
        class Host extends App({ needs: needs('online'), services: [Watcher], routes: {} }) {}

        createAppRuntime(Host, grant(io, ['online'])).dispose();
        expect(seen).toBe(true);
        expect(watched).toBe(true);
    });

    it('replaces a driver if replace is true', () => {
        const io = new IoManager();
        const first: OnlineDriver = { isOnline: true, watch: () => () => {} };
        const second: OnlineDriver = { isOnline: false, watch: () => () => {} };
        io.register(ONLINE_DRIVER, first);
        io.register(ONLINE_DRIVER, second, { replace: true });
        expect(io.get(ONLINE_DRIVER)).toBe(second);
    });

    it('throws if registering a driver without replace', () => {
        const io = new IoManager();
        const first: OnlineDriver = { isOnline: true, watch: () => () => {} };
        const second: OnlineDriver = { isOnline: false, watch: () => () => {} };
        io.register(ONLINE_DRIVER, first);
        expect(() => io.register(ONLINE_DRIVER, second)).toThrow(/already registered/);
    });

    it('lets a service declare needs("hostWindow") and use the driver', () => {
        let opened = false;
        const fakeWindow: HostWindowDriver = {
            open: () => { opened = true; return null; },
            addEventListener: () => {},
            removeEventListener: () => {},
        };
        const io = new IoManager();
        io.register(HOST_WINDOW_DRIVER, fakeWindow);

        const Base = Service({ needs: needs('hostWindow') });
        class Opener extends Base {
            constructor(...args: ConstructorParameters<typeof Base>) {
                super(...args);
                this.cx.hostWindow.open('http://example.com');
            }
        }
        class Host extends App({ needs: needs('hostWindow'), services: [Opener], routes: {} }) {}

        createAppRuntime(Host, grant(io, ['hostWindow'])).dispose();
        expect(opened).toBe(true);
    });
});
