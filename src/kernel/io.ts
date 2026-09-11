import type { ProviderToken } from '../contribution/provider.js';

export class IoManager {
    #drivers = new Map<string, unknown>();

    register<T>(token: ProviderToken<T>, driver: T, options?: { replace?: boolean }): void {
        if (this.#drivers.has(token.id) && !options?.replace) {
            throw new Error(`Driver for subsystem '${token.id}' is already registered.`);
        }
        this.#drivers.set(token.id, driver);
    }

    resolve<T>(token: ProviderToken<T>): T {
        const driver = this.#drivers.get(token.id);
        if (driver === undefined) {
            throw new Error(`No driver registered for subsystem '${token.id}'.`);
        }
        return driver as T;
    }

    get<T>(token: ProviderToken<T>): T | undefined {
        return this.#drivers.get(token.id) as T | undefined;
    }
}
