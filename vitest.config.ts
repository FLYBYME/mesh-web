import { defineConfig } from 'vitest/config';

// Deliberately minimal. The DOM suites take their environment from a
// `// @vitest-environment happy-dom` docblock at the top of each file, which is Vitest 4's
// mechanism and has the advantage of being visible in the file it applies to. An earlier version of
// this config in mesh-api used `environmentMatchGlobs`, which Vitest 4 removed — so it was dead
// config that read as if it were doing the work.
export default defineConfig({
    test: {},
});
