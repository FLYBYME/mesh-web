/**
 * Part test mounting for real browser environments.
 *
 * Boots a part (Extension or Application) through start(), the same entry
 * point a real deployment uses, ensuring test fidelity.
 */

import { isApplication } from '../contribution/contract.js';
import type { ErasedContribution } from '../contribution/contract.js';
import type { BuildPolicy } from '../registry/hives.js';
import { start } from '../kernel/start.js';
import type { PartRef, Started } from '../kernel/start.js';
import { getFrameworkInstances, assertSingleFramework } from '../instance.js';

export interface MountOptions {
    readonly application?: string;
    readonly api?: string;
    readonly policy?: BuildPolicy;
    readonly parts?: readonly PartRef[];
    /** Shorthand for mounting a single part without wrapping in `parts: [...]` */
    readonly id?: string;
    readonly contribution?: ErasedContribution | (new (options?: unknown) => ErasedContribution);
    readonly options?: unknown;
    readonly root?: Element;
    readonly open?: readonly { readonly application: string; readonly views?: readonly string[] }[];
    readonly window?: { addEventListener(type: 'resize', fn: () => void): void };
}

export interface MountedSite extends Started {
    /** The DOM container element the site mounted into. */
    readonly root: Element;
    /**
     * All URLs under which @flybyme/mesh-web was evaluated in this runtime.
     * Must contain exactly 1 URL in a properly configured test setup.
     */
    readonly frameworkInstances: readonly string[];
    /**
     * Asserts that exactly one copy of @flybyme/mesh-web was evaluated.
     * Throws with the distinct URLs if multiple copies are detected.
     */
    assertSingleFramework(): void;
    /** Synonym for assertSingleFramework() */
    assertSingleKernel(): void;
}

const activeSites = new Set<MountedSite>();

function isApplicationLike(contribution: unknown): boolean {
    if (contribution === undefined || contribution === null) return false;
    if (typeof contribution !== 'function' && isApplication(contribution as ErasedContribution)) {
        return true;
    }
    if (typeof contribution === 'function') {
        const proto = (contribution as { prototype?: unknown }).prototype;
        if (proto !== undefined && proto !== null && typeof (proto as { start?: unknown }).start === 'function') {
            return true;
        }
    }
    return false;
}

/**
 * Disposes all currently mounted sites.
 * Useful in afterEach hooks or teardown.
 */
export function cleanup(): void {
    for (const site of [...activeSites]) {
        try {
            site.dispose();
        } catch {
            // ignore disposal errors during bulk cleanup
        }
    }
    activeSites.clear();
}

/**
 * Mount a part inside a real browser page via start(composition).
 *
 * Returns a running site once all requested Applications have started.
 */
export async function mountPart(input: MountOptions | readonly PartRef[] | PartRef): Promise<MountedSite> {
    const options: MountOptions = Array.isArray(input)
        ? { parts: input }
        : ('contribution' in input && !('parts' in input))
            ? { parts: [input as PartRef] }
            : (input as MountOptions);

    let parts: PartRef[];
    if (options.parts !== undefined) {
        parts = [...options.parts];
    } else if (options.contribution !== undefined) {
        parts = [{
            id: options.id ?? 'test',
            contribution: options.contribution,
            options: options.options,
        }];
    } else {
        parts = [];
    }

    const application = options.application ?? parts[0]?.id ?? 'test';

    // Auto-detect Applications to open if open was not explicitly specified
    let openList = options.open;
    if (openList === undefined) {
        const appParts = parts.filter((p) => isApplicationLike(p.contribution));
        if (appParts.length > 0) {
            openList = appParts.map((p) => ({ application: p.id }));
        }
    }

    const doc = options.root?.ownerDocument ?? globalThis.document;
    const createdRoot = options.root === undefined;

    const started = start({
        application,
        api: options.api,
        policy: options.policy,
        parts,
        root: options.root,
        open: openList,
        window: options.window,
    });

    // Wait for applications to boot and views to open
    await started.ready;

    const root = options.root ?? doc.getElementById('mesh-web-root')!;

    let disposed = false;
    const site: MountedSite = {
        kernel: started.kernel,
        manager: started.manager,
        page: started.page,
        settings: started.settings,
        components: started.components,
        ready: started.ready,
        root,
        get frameworkInstances() {
            return getFrameworkInstances();
        },
        assertSingleFramework() {
            assertSingleFramework();
        },
        assertSingleKernel() {
            assertSingleFramework();
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            activeSites.delete(site);
            try {
                started.dispose();
            } finally {
                if (createdRoot && root && root.parentNode) {
                    root.remove();
                }
            }
        },
    };

    activeSites.add(site);
    return site;
}
