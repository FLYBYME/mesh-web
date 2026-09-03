import { defineConfig } from 'vitest/config';

/**
 * The tests that need a real browser (spec/testing.md section 4).
 *
 * Vitest browser mode: Vite serves `src/` to a real Chromium, the test file runs *inside* the page,
 * and input arrives through CDP rather than `element.dispatchEvent`. That difference is the whole
 * point — a synthesised event is the thing under test in half of these, so a test that synthesises
 * its own proves nothing.
 *
 * `channel: 'chrome'` uses the Chrome already installed rather than downloading Playwright's own, so
 * `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is safe on install and CI needs a browser, not a 400MB cache.
 *
 * This project is small on purpose. Anything that can be answered without layout, focus or a real
 * pointer belongs in the jsdom project, which is thirty times faster.
 */
export default defineConfig({
    test: {
        name: 'browser',
        include: ['test/browser/**/*.test.ts'],
        browser: {
            enabled: true,
            provider: 'playwright',
            name: 'chromium',
            headless: true,
            // Big enough for a desktop with windows on it. Not cosmetic: a drop point outside the
            // target element's box gets clamped, so a narrow viewport silently turns a 120px drag
            // into a drag to the middle of the page — which reads as a framework bug and is not one.
            viewport: { width: 1280, height: 800 },
            screenshotFailures: false,
            providerOptions: {
                launch: { channel: 'chrome' },
            },
        },
    },
});
