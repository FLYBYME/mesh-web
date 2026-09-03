import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two rules from src/index.ts, checked rather than asked for.
 *
 * `tsconfig.json` sets `types: []` so a node import in src/ will not compile, and that is the real
 * enforcement. This is the second line: it catches a DOM type reaching a layer that must stay pure,
 * which the compiler is perfectly happy with because the DOM lib is loaded.
 */

const SRC = join(import.meta.dirname, '..', 'src');

function filesUnder(dir: string): readonly string[] {
    return readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) return filesUnder(full);
        return full.endsWith('.ts') ? [full] : [];
    });
}

describe('nothing in src imports node', () => {
    it.each(filesUnder(SRC).map((f) => [f.slice(SRC.length + 1), f]))('%s', (_name, file) => {
        const source = readFileSync(file, 'utf8');
        expect(source).not.toMatch(/from\s+['"]node:/);
        expect(source).not.toMatch(/\brequire\s*\(/);
    });
});

describe('the description layer has no DOM in it', () => {
    // spec/view-layer.md section 1: an Application never sees HTMLElement. That holds only if the
    // layer it talks to never names one. The renderer, when it exists, is the single exception and
    // will live outside this directory.
    const DOM_TYPES = /\b(HTMLElement|HTMLDivElement|Node\s*&|Element\b|Document\b|MouseEvent|KeyboardEvent|PointerEvent|document\.|window\.)/;

    const files = filesUnder(join(SRC, 'description'));

    it('has files to check', () => {
        expect(files.length).toBeGreaterThan(0);
    });

    it.each(files.map((f) => [f.slice(SRC.length + 1), f]))('%s', (_name, file) => {
        const source = readFileSync(file, 'utf8')
            // Comments explain the rule and naturally mention what is banned.
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
        expect(source).not.toMatch(DOM_TYPES);
    });
});
