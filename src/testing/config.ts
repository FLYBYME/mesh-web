/**
 * Vitest browser configuration preset for part repositories.
 *
 * Configures Playwright with Chromium (using the installed Chrome channel),
 * a strict API port (default 5174), desktop viewport (1280x800), and
 * enforces resolution of @flybyme/mesh-web to a single copy via
 * dedupe and optimizeDeps.exclude.
 */

export interface UserBrowserConfig {
    readonly resolve?: {
        readonly dedupe?: string[];
        readonly alias?: Record<string, string> | readonly { find: string | RegExp; replacement: string }[];
        readonly [key: string]: unknown;
    };
    readonly optimizeDeps?: {
        readonly exclude?: string[];
        readonly include?: string[];
        readonly [key: string]: unknown;
    };
    readonly test?: {
        readonly name?: string;
        readonly include?: string[];
        readonly exclude?: string[];
        readonly browser?: {
            readonly enabled?: boolean;
            readonly provider?: string;
            readonly name?: string;
            readonly headless?: boolean;
            readonly api?: { port?: number; strictPort?: boolean };
            readonly viewport?: { width: number; height: number };
            readonly screenshotFailures?: boolean;
            readonly providerOptions?: {
                readonly launch?: { channel?: string; [key: string]: unknown };
                readonly [key: string]: unknown;
            };
            readonly [key: string]: unknown;
        };
        readonly [key: string]: unknown;
    };
    readonly [key: string]: unknown;
}

/**
 * Creates a Vitest configuration for browser testing a part repository.
 *
 * Automatically configures:
 * - Playwright browser runner on Chromium with system Chrome
 * - Fixed port 5174 with strictPort (so origins can be declared)
 * - 1280x800 viewport for window layout
 * - dedupe and optimizeDeps.exclude for @flybyme/mesh-web to guarantee a single framework copy
 */
export function definePartBrowserConfig(userConfig?: UserBrowserConfig): UserBrowserConfig {
    const defaultDedupe = ['@flybyme/mesh-web'];
    const userDedupe = userConfig?.resolve?.dedupe ?? [];
    const dedupe = Array.from(new Set([...defaultDedupe, ...userDedupe]));

    const defaultExclude = ['@flybyme/mesh-web'];
    const userExclude = userConfig?.optimizeDeps?.exclude ?? [];
    const exclude = Array.from(new Set([...defaultExclude, ...userExclude]));

    const defaultInclude = ['test/**/*.browser.test.ts', 'test/**/*.test.ts'];
    const testInclude = userConfig?.test?.include ?? defaultInclude;

    const baseBrowser = {
        enabled: true,
        provider: 'playwright',
        name: 'chromium',
        headless: true,
        api: { port: 5174, strictPort: true },
        viewport: { width: 1280, height: 800 },
        screenshotFailures: false,
        providerOptions: {
            launch: { channel: 'chrome' },
        },
    };

    return {
        ...userConfig,
        resolve: {
            ...userConfig?.resolve,
            dedupe,
        },
        optimizeDeps: {
            ...userConfig?.optimizeDeps,
            exclude,
        },
        test: {
            name: 'browser',
            ...userConfig?.test,
            include: testInclude,
            browser: {
                ...baseBrowser,
                ...userConfig?.test?.browser,
                api: {
                    ...baseBrowser.api,
                    ...userConfig?.test?.browser?.api,
                },
                viewport: {
                    ...baseBrowser.viewport,
                    ...userConfig?.test?.browser?.viewport,
                },
                providerOptions: {
                    ...baseBrowser.providerOptions,
                    ...userConfig?.test?.browser?.providerOptions,
                    launch: {
                        ...baseBrowser.providerOptions.launch,
                        ...userConfig?.test?.browser?.providerOptions?.launch,
                    },
                },
            },
        },
    };
}
