import { describe, expect, it } from 'vitest';
import { IoManager } from '../../src/kernel/io.js';
import { provider } from '../../src/contribution/provider.js';

describe('IoManager', () => {
    const TEST_TOKEN = provider<string>('test-driver');

    it('registers and resolves a driver', () => {
        const io = new IoManager();
        io.register(TEST_TOKEN, 'driver-1');
        expect(io.resolve(TEST_TOKEN)).toBe('driver-1');
    });

    it('refuses to register a second driver for the same subsystem', () => {
        const io = new IoManager();
        io.register(TEST_TOKEN, 'driver-1');
        expect(() => io.register(TEST_TOKEN, 'driver-2')).toThrow(/already registered/);
        expect(io.resolve(TEST_TOKEN)).toBe('driver-1');
    });

    it('allows deliberate replacement', () => {
        const io = new IoManager();
        io.register(TEST_TOKEN, 'driver-1');
        io.register(TEST_TOKEN, 'driver-2', { replace: true });
        expect(io.resolve(TEST_TOKEN)).toBe('driver-2');
    });

    it('throws when resolving an unregistered driver', () => {
        const io = new IoManager();
        expect(() => io.resolve(TEST_TOKEN)).toThrow(/No driver registered/);
    });
});
