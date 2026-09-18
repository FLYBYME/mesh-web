import { describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { HOST_WINDOW_DRIVER, ONLINE_DRIVER, type HostWindowDriver, type OnlineDriver } from '../../src/kernel/drivers.js';
import type { Extension } from '../../src/contribution/contract.js';

describe('drivers seam', () => {
    it('allows a part to declare needs("online") and use the driver', () => {
        let watched = false;
        const fakeOnline: OnlineDriver = {
            isOnline: true,
            watch: (cb) => { watched = true; return () => {}; }
        };

        const kernel = new Kernel();
        kernel.io.register(ONLINE_DRIVER, fakeOnline);

        let activated = false;

        /**
         * Typed as the `Extension` it is, rather than cast.
         *
         * The cast this replaces was not cosmetic: `needs: ['online'] as any` compiles whether or not
         * `online` is a `CapabilityName`, so the test passed without ever showing that a real part
         * could ask for the driver. Declaring the type is what makes `cx.online` resolve — and makes
         * the test fail to compile the day the capability is renamed or dropped, which is the thing
         * worth knowing.
         */
        const part: Extension<['online']> = {
            needs: ['online'],
            activate: (cx) => {
                expect(cx.online.isOnline).toBe(true);
                cx.online.watch(() => {});
                activated = true;
                return [];
            },
        };

        kernel.boot([{ id: 'test-ext', contribution: part }]);
        
        expect(activated).toBe(true);
        expect(watched).toBe(true);
    });

    it('replaces a driver if replace is true', () => {
        const kernel = new Kernel();
        const first = { isOnline: false, watch: () => () => {} };
        const second = { isOnline: true, watch: () => () => {} };
        kernel.io.register(ONLINE_DRIVER, first);
        kernel.io.register(ONLINE_DRIVER, second, { replace: true });
        expect(kernel.io.get(ONLINE_DRIVER)).toBe(second);
    });

    it('refuses to register a second driver without replace', () => {
        const kernel = new Kernel();
        const first = { isOnline: false, watch: () => () => {} };
        const second = { isOnline: true, watch: () => () => {} };
        kernel.io.register(ONLINE_DRIVER, first);
        expect(() => kernel.io.register(ONLINE_DRIVER, second)).toThrow(/already registered/);
    });

    it('allows a part to declare needs("hostWindow") and use the driver', () => {
        let opened = false;
        const fakeWindow: HostWindowDriver = {
            open: () => { opened = true; return null; },
            addEventListener: () => {},
            removeEventListener: () => {}
        };
        const kernel = new Kernel();
        kernel.io.register(HOST_WINDOW_DRIVER, fakeWindow);
        
        let activated = false;

        const part: Extension<['hostWindow']> = {
            needs: ['hostWindow'],
            activate: (cx) => {
                cx.hostWindow.open('http://example.com');
                activated = true;
                return [];
            },
        };

        kernel.boot([{ id: 'test-ext-win', contribution: part }]);

        expect(activated).toBe(true);
        expect(opened).toBe(true);
    });
});
