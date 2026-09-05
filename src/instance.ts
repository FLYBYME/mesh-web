/**
 * Framework instance tracking.
 *
 * Enforces and verifies the one constraint that matters:
 * "A part must resolve the framework to exactly one copy."
 *
 * If Vite or an import map serves the framework under two URLs, two module graphs
 * execute, duplicating reactivity contexts and capability providers.
 *
 * This records every module evaluation URL into a shared Symbol.for registry on globalThis.
 */

const INSTANCES_KEY = Symbol.for('@flybyme/mesh-web/instances');

const registry: Record<symbol, string[] | undefined> = globalThis;
const instances = (registry[INSTANCES_KEY] ??= []);

try {
    if (typeof import.meta !== 'undefined' && import.meta.url) {
        instances.push(import.meta.url);
    } else {
        instances.push('unknown');
    }
} catch {
    instances.push('unknown');
}

/**
 * Returns all URLs under which @flybyme/mesh-web was evaluated in this runtime.
 * In a properly configured environment, this must contain exactly one URL.
 */
export function getFrameworkInstances(): readonly string[] {
    return [...(registry[INSTANCES_KEY] ?? [])];
}

/**
 * Asserts that exactly one copy of the framework has been evaluated.
 * Throws with the distinct URLs if multiple copies are detected.
 */
export function assertSingleFramework(): void {
    const loaded = getFrameworkInstances();
    if (loaded.length > 1) {
        throw new Error(
            `Framework singleton violation: @flybyme/mesh-web was evaluated ${loaded.length} times under multiple URLs:\n` +
            loaded.map((url) => `  - ${url}`).join('\n') +
            `\nA part must resolve the framework to exactly one copy. Check Vite resolve.dedupe and optimizeDeps.exclude.`,
        );
    }
}
