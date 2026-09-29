import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { definePartBrowserConfig } from './src/testing/config.js';

/**
 * The tests that need a real browser (spec/testing.md section 4).
 *
 * Vitest browser mode: Vite serves `src/` to a real Chromium, the test file runs *inside* the page,
 * and input arrives through CDP rather than `element.dispatchEvent`. That difference is the whole
 * point — a synthesised event is the thing under test in half of these, so a test that synthesises
 * its own proves nothing.
 *
 * This configuration dogfoods `definePartBrowserConfig()`, the same preset exported for part repositories.
 */
export default defineConfig(definePartBrowserConfig({
    resolve: {
        alias: {
            '@flybyme/mesh-web/testing/config': fileURLToPath(new URL('./src/testing/config.ts', import.meta.url)),
            '@flybyme/mesh-web/testing': fileURLToPath(new URL('./src/testing/index.ts', import.meta.url)),
            '@flybyme/mesh-web/config': fileURLToPath(new URL('./src/testing/config.ts', import.meta.url)),
            '@flybyme/mesh-web': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
        },
    },
    test: {
        include: ['test/browser/**/*.test.ts'],
    },
}));
