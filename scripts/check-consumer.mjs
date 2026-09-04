/**
 * check-consumer — roadmap A6.9.
 *
 * Compile the framework's own out-of-package files against the framework **as an outsider receives
 * it**: packed by npm, installed into an empty project, resolved by name through the `exports` map.
 *
 * Everything else in this repo checks a weaker thing. `tsconfig.browser.json` maps
 * `@flybyme/mesh-web` to `./dist/index.d.ts` with `paths`, and the browser test config aliases it to
 * `./src/index.ts` — both prove the *entry* is complete, and neither can see the packaging around
 * it. A package that npm assembles wrongly compiles perfectly under a `paths` mapping. Three things
 * live in that blind spot, and all three have to hold before anyone outside can use this:
 *
 * 1. **`prepare` runs and `dist` is in the tarball.** `dist/` is gitignored, so a git install builds
 *    it or ships nothing. This is A6.8, and until it was fixed `main` pointed at a directory that
 *    had never existed.
 * 2. **`files` does not drop something the entry needs.** A missing declaration is a resolution
 *    error here and invisible everywhere else.
 * 3. **The `exports` map holds.** `@flybyme/mesh-web/dist/kernel/kernel.js` must be unreachable —
 *    the entry is the whole surface, or the surface is whatever anyone happened to import.
 *
 * The files it compiles are `browser/harness.ts` and `browser/workbench.ts`, chosen because they are
 * not written for this script: the harness drives the real window manager and the workbench is an
 * ordinary Extension, together naming most of the public entry. If the entry loses an export — as it
 * lost `Chrome`, `ChromeWindow` and `Credentials`, which sat unexported until the workbench moved
 * out of `src/` and found them in under a minute — this fails.
 *
 * Slow by nature: a real pack and a real install, about a minute. Not part of `npm test`. Run it
 * before anything outside this repo depends on the package.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'mesh-web-consumer-'));

/** Inherit stdio only on failure: a passing run should say what it proved, not how. */
function run(command, args, cwd) {
    try {
        return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
        process.stderr.write(error.stdout ?? '');
        process.stderr.write(error.stderr ?? '');
        throw new Error(`${command} ${args.join(' ')} failed in ${cwd}`);
    }
}

let failed = false;
function check(name, fn) {
    try {
        fn();
        console.log(`  ok    ${name}`);
    } catch (error) {
        failed = true;
        console.log(`  FAIL  ${name}`);
        console.log(`        ${error.message.split('\n').join('\n        ')}`);
    }
}

try {
    console.log('packing (runs prepare, so this builds dist)...');
    const packed = run('npm', ['pack', '--pack-destination', work, '--silent'], repo).trim().split('\n').pop();
    const tarball = join(work, packed);

    console.log(`installing ${packed} into an empty project...`);
    const project = join(work, 'project');
    run('mkdir', ['-p', project], work);
    writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }, null, 2));
    run('npm', ['install', '--no-audit', '--no-fund', tarball], project);
    run('npm', ['install', '--no-audit', '--no-fund', '--save-dev', 'typescript@5.9.3'], project);

    // The same tsconfig an outside author would write: resolve by name, honour `exports`, and keep
    // `types: []` so a node builtin reached through the framework is an error here too.
    writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
            target: 'ES2022',
            module: 'ESNext',
            moduleResolution: 'bundler',
            lib: ['ES2022', 'DOM', 'DOM.Iterable'],
            strict: true,
            noUncheckedIndexedAccess: true,
            verbatimModuleSyntax: true,
            isolatedModules: true,
            skipLibCheck: true,
            noEmit: true,
            types: [],
        },
        include: ['src/**/*.ts'],
    }, null, 2));

    cpSync(join(repo, 'browser'), join(project, 'src'), {
        recursive: true,
        filter: (source) => !source.includes(`${'browser'}/dist`),
    });

    console.log(`\n${readdirSync(join(project, 'src')).filter((f) => f.endsWith('.ts')).join(', ')} against the packed package:\n`);

    check('the framework compiles as an installed dependency', () => {
        run('npx', ['tsc', '-p', 'tsconfig.json'], project);
    });

    check('the exports map refuses a deep import (types)', () => {
        writeFileSync(join(project, 'src', 'deep.ts'),
            "import { Kernel } from '@flybyme/mesh-web/dist/kernel/kernel.js';\nexport const reached = Kernel;\n");
        // A compile failure is the passing outcome here, so `run`'s diagnostics would be noise.
        let refused = false;
        try {
            execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: project, stdio: 'ignore' });
        } catch {
            refused = true;
        }
        rmSync(join(project, 'src', 'deep.ts'));
        if (!refused) throw new Error('dist/kernel/kernel.js resolved; the entry is not the surface');
    });

    check('the exports map refuses a deep import (node)', () => {
        const probe = "import('@flybyme/mesh-web/dist/kernel/kernel.js')"
            + ".then(() => { console.log('REACHED'); })"
            + ".catch((e) => { console.log(e.code); });";
        const result = run('node', ['-e', probe], project).trim();
        if (result !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
            throw new Error(`expected ERR_PACKAGE_PATH_NOT_EXPORTED, got ${result || '(nothing)'}`);
        }
    });
} finally {
    rmSync(work, { recursive: true, force: true });
}

console.log(failed ? '\nThe package is not consumable as installed.' : '\nConsumable.');
process.exit(failed ? 1 : 0);
