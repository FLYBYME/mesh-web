import { describe, expect, it } from 'vitest';
import { Kernel } from '../../src/kernel/kernel.js';
import { HOST_WINDOW_DRIVER, ONLINE_DRIVER, type HostWindowDriver, type OnlineDriver } from '../../src/kernel/drivers.js';

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
        kernel.boot([{
            id: 'test-ext',
            contribution: {
                id: 'test-ext',
                needs: ['online'] as any,
                activate: (cx: any) => {
                    expect(cx.online.isOnline).toBe(true);
                    cx.online.watch(() => {});
                    activated = true;
                    return [];
                }
            } as any
        }]);
        
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
        kernel.boot([{
            id: 'test-ext-win',
            contribution: {
                id: 'test-ext-win',
                needs: ['hostWindow'] as any,
                activate: (cx: any) => {
                    cx.hostWindow.open('http://example.com');
                    activated = true;
                    return [];
                }
            } as any
        }]);

        expect(activated).toBe(true);
        expect(opened).toBe(true);
    });
});
