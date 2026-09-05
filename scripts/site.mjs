/**
 * Assemble the harness into a servable site.
 *
 * The harness page as it sits in this repo is *not* a site: it lives at `/browser/` and its import
 * map reaches `../dist/index.js`, so it only works when the repository layout is the URL layout.
 * That is fine for `npm run harness` and wrong for a CDN, which serves a hostname at `/`.
 *
 * So this is the build step a real deployment has and a dev server does not: take the two compiled
 * trees, put them where the served paths say they are, and rewrite the page's own references to
 * match. It is deliberately dumb — no bundler, no minifier, no hashing. The framework ships as ES
 * modules and the browser resolves them; adding a bundler here would be adding a thing to be wrong
 * about before anything had been served at all.
 *
 *     out/
 *       index.html          import map → /framework/index.js, script → /app/harness.js
 *       framework/**        from dist/          (the package)
 *       app/**              from browser/dist/  (the harness and its generated client)
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, process.env['MESH_OUT'] ?? 'out');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await cp(join(root, 'dist'), join(out, 'framework'), { recursive: true });
await cp(join(root, 'browser', 'dist'), join(out, 'app'), { recursive: true });

const page = await readFile(join(root, 'browser', 'index.html'), 'utf8');

/**
 * Where the API is, baked in — and until 2026-09-05 this repository did not do it.
 *
 * `mesh.json` has always declared an `api` per environment, and the builder has always passed it as
 * `MESH_API`. `surfdns-console` bakes it into the page. **This site ignored it**, because
 * `browser/harness.ts` hardcoded `http://127.0.0.1:5005` — so mesh-web's own descriptor declared a
 * field that mesh-web's own site did not honour, and the format's first user was the one disproving
 * it. Found by deploying two sites side by side, giving one of them a different API port, and
 * watching nothing change.
 *
 * The one value a site cannot discover at run time is where its API is: a browser has only the
 * origin it was served from, and hosting §1 puts the API behind the same proxy in production and on
 * another port here.
 */
const api = process.env['MESH_API'];

const served = page
    .replace('"@flybyme/mesh-web": "../dist/index.js"', '"@flybyme/mesh-web": "/framework/index.js"')
    .replace('src="./dist/harness.js"', 'src="/app/harness.js"')
    .replace('<html lang="en">', api === undefined ? '<html lang="en">' : `<html lang="en" data-api="${api}">`);

// Absolute paths, so a deep link into a client-routed app resolves the same modules as `/` does.
// The CDN serves `index.html` for any non-asset path, and a relative `./app/harness.js` under
// `/posts/42` would ask for `/posts/app/harness.js` and get the page back as JavaScript.
if (api !== undefined && !served.includes(`data-api="${api}"`)) {
    // The same argument as the markers below: a rewrite that quietly did nothing produces a site
    // that runs and calls the wrong place, which is worse than one that fails to build.
    throw new Error(
        'MESH_API was set but the page was not rewritten: browser/index.html no longer opens with ' +
        '<html lang="en">, so the site would silently keep the harness\'s built-in default.',
    );
}

for (const marker of ['/framework/index.js', '/app/harness.js']) {
    if (!served.includes(marker)) {
        throw new Error(
            `The page was not rewritten: ${marker} is missing. browser/index.html changed shape, ` +
            `and a site built from it would load the wrong files or none at all.`,
        );
    }
}

await writeFile(join(out, 'index.html'), served);

console.log(`assembled ${out}`);
