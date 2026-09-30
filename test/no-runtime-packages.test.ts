/**
 * mesh-web ships with no runtime dependencies: the kernel is built from this repo with dev
 * dependencies left out (the builder runs `npm ci --omit=dev`), so any package `src/` imports at
 * run time fails that build. v0.21.5 imported zod in models.ts; the tests passed (zod is a dev
 * dependency here) and the site's kernel build failed with `Could not resolve "zod"`.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return /\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
    });
}

/** Package specifiers imported for their values: not `import type`, not relative. */
function runtimePackages(code: string): string[] {
    const found: string[] = [];
    const statement = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+['"]([^'"]+)['"]/gm;
    for (const match of code.matchAll(statement)) {
        const [, , typeOnly, clause = '', specifier = ''] = match;
        if (typeOnly !== undefined || specifier.startsWith('.')) continue;
        // `import { type A, type B } from 'x'` is erased too.
        const names = /^\{([^}]*)\}$/.exec(clause.trim())?.[1];
        if (names !== undefined && names.split(',').every((n) => n.trim() === '' || n.trim().startsWith('type '))) continue;
        found.push(specifier);
    }
    for (const match of code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
        if (!match[1]?.startsWith('.')) found.push(match[1] ?? '');
    }
    return found;
}

describe('src/ imports no package at run time', () => {
    it('has none, so the kernel builds with dev dependencies left out', () => {
        const root = join(import.meta.dirname, '..', 'src');
        const offenders = sources(root).flatMap((file) =>
            runtimePackages(readFileSync(file, 'utf8')).map((pkg) => `${file.slice(root.length + 1)}: ${pkg}`),
        );
        expect(offenders).toEqual([]);
    });
});
