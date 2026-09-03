import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // No jsdom, deliberately. Everything in src/ so far is pure data, and
        // spec/testing.md section 2 is the argument for keeping it that way as
        // long as possible — the renderer is where a DOM becomes necessary.
        environment: 'node',
        include: ['test/**/*.test.ts'],
    },
});
