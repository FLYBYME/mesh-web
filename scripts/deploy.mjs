/**
 * Build a repository through the real builder and serve it from the real CDN.
 *
 * Everything the CDN has served so far came from a two-line `build.sh` in a test fixture. The
 * pipeline is file-type agnostic, so there was no *reason* a real bundle would differ — and "no
 * reason it would differ" is the kind of claim this project keeps disproving, so here is the claim
 * being run instead of asserted.
 *
 * It is a script rather than a test on purpose. A truthful build of this repo runs `npm ci`, which
 * needs the network and takes a minute or two; a unit suite that did it would be a unit suite nobody
 * runs. What it produces is a URL to open.
 *
 *     node scripts/deploy.mjs [--repo .] [--ref HEAD] [--environment local] [--port 8080]
 *
 * It builds from a **commit**, not from the working tree, because that is what a deploy is. Anything
 * uncommitted is not in the site, and that is the correct surprise to have here rather than in
 * production.
 *
 * `--repo` is what makes this a deployer rather than a self-test. It defaults to this repository,
 * which is how it was written, and pointing it at another one — `--repo ../surfdns-console` — is the
 * whole of what a real deployment does differently. The builder never knew the difference; it takes
 * a source reference and a commit, and this script was simply hard-wired to one.
 */

import { execFile } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { BrokerModule, MeshApp, RegistryModule } from '@flybyme/mesh';

// The compiled server project — `npx tsc -p server/tsconfig.json` first. Imported by path rather
// than by package name because these are not installed here; they are three packages in this repo
// that a deployment installs separately.
import { createBuilderModule } from '../server/dist/builder/src/index.js';
import { createCdnModule } from '../server/dist/cdn/src/index.js';

const run = promisify(execFile);
const here = join(dirname(fileURLToPath(import.meta.url)), '..');

const flag = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at === -1 ? fallback : process.argv[at + 1];
};

// The repository being deployed, which is this one only by default. `resolve` so a relative
// `--repo ../surfdns-console` is meaningful from wherever this was invoked.
const root = resolve(here, flag('repo', '.'));
const ref = flag('ref', 'HEAD');
const environment = flag('environment', 'local');
const port = Number(flag('port', '8080'));

// Resolved here so the log can say which commit is being served. The builder resolves it again —
// this is for the human, not for correctness.
const { stdout: commit } = await run('git', ['rev-parse', ref], { cwd: root });
const { stdout: subject } = await run('git', ['log', '-1', '--format=%s', ref], { cwd: root });

console.log(`deploying ${root}`);
console.log(`building ${commit.trim().slice(0, 8)} — ${subject.trim()}`);
console.log('(a commit, not the working tree: anything uncommitted is not in this site)\n');

const app = new MeshApp({ nodeID: 'deploy-local', namespace: 'mesh-web-deploy' });
app.use(new RegistryModule());
app.use(new BrokerModule());
await app.start();

const builder = createBuilderModule({
    // A real install and a real compile. Generous, because `npm ci` on a cold cache is not fast.
    timeoutMs: 10 * 60_000,
    onError: (error) => { console.error(error); },
});
await app.registerModule(builder);

const cdn = createCdnModule({ port, host: '127.0.0.1', onError: (e) => { console.error(e); } });
await app.registerModule(cdn);

const call = (tool, params) => app.call(tool, params);

const started = Date.now();
const result = await call('builder.build_start', {
    // A checkout, by path. A git remote works identically; a local path is what makes this runnable
    // with no forge.
    source: { kind: 'git', repository: root, ref: commit.trim() },
    environment,
    publish: true,
    tenantId: 'local',
});

const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (result.build.state !== 'succeeded') {
    console.error(`\nbuild failed after ${seconds}s\n`);
    console.error(result.build.log ?? result.build.error);
    process.exit(1);
}

const { artifact } = result;
console.log(`\nbuilt in ${seconds}s${result.cached ? ' (cached — nothing ran)' : ''}`);
console.log(`  artifact ${artifact.digest.slice(0, 16)}…`);
console.log(`  ${String(artifact.files.length)} files, ${(artifact.totalSize / 1024).toFixed(0)} KiB`);
console.log(`  hostname ${result.hostname} — from the repository's own mesh.json\n`);

console.log(`  http://localhost:${String(port)}/\n`);
console.log('Ctrl-C to stop.');

process.on('SIGINT', () => {
    void cdn.onStop?.().then(() => app.stop()).then(() => process.exit(0));
});
