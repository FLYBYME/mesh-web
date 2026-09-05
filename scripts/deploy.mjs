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
 *
 * **`--repo` may be given more than once** (roadmap B8c), and that is not a convenience. Every deploy
 * before this published exactly one hostname, so [hosting §2](../spec/hosting.md)'s claim that a node
 * serves many sites had never been asked for anything. Two repositories on one port, told apart by
 * `Host`, is the claim being run:
 *
 *     node scripts/deploy.mjs --repo . --repo ../surfdns-console
 *
 * It also now **says** that the port answers before anything is published, which is the other half of
 * B8c. For the ninety seconds of a build every request got `No site is configured for this hostname.`
 * — indistinguishable from the real misconfiguration that message exists to report, and the first
 * thing anyone impatient sees. Moving the CDN after the builds does not work; see below.
 */

import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { BrokerModule, MeshApp, RegistryModule } from '@flybyme/mesh';

// The compiled server project — `npx tsc -p server/tsconfig.json` first. Imported by path rather
// than by package name because these are not installed here; they are three packages in this repo
// that a deployment installs separately.
import { createBuilderModule } from '../server/dist/builder/src/index.js';
import { DESCRIPTOR_FILE, environmentOf, parseDescriptor } from '../server/dist/builder/src/index.js';
import { createCdnModule } from '../server/dist/cdn/src/index.js';

const run = promisify(execFile);
const here = join(dirname(fileURLToPath(import.meta.url)), '..');

const flag = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at === -1 ? fallback : process.argv[at + 1];
};

/** Every `--repo`, in order. One is the common case; the plural is what proves the claim. */
const flags = (name) => process.argv
    .flatMap((arg, i) => (arg === `--${name}` ? [process.argv[i + 1]] : []))
    .filter((value) => value !== undefined);

// The repositories being deployed, which is this one only by default. `resolve` so a relative
// `--repo ../surfdns-console` is meaningful from wherever this was invoked.
const ref = flag('ref', 'HEAD');
const environment = flag('environment', 'local');
const port = Number(flag('port', '8080'));

/**
 * `--repo <path>` or `--repo <path>#<environment>`.
 *
 * The suffix exists because two repositories on one port need two hostnames, and a hostname comes
 * from an *environment* — so a single global `--environment` cannot express the case this script now
 * supports. `#` rather than `:`, which is a drive letter on Windows and a port everywhere.
 */
const given = flags('repo');
const roots = (given.length === 0 ? ['.'] : given).map((repo) => {
    const hash = repo.lastIndexOf('#');
    return hash === -1
        ? { root: resolve(here, repo), environment }
        : { root: resolve(here, repo.slice(0, hash)), environment: repo.slice(hash + 1) };
});

// Resolved here so the log can say which commit is being served. The builder resolves it again —
// this is for the human, not for correctness.
const targets = [];
for (const { root, environment: env } of roots) {
    const { stdout: commit } = await run('git', ['rev-parse', ref], { cwd: root });
    const { stdout: subject } = await run('git', ['log', '-1', '--format=%s', ref], { cwd: root });

    // From the commit, not the working tree, and with the builder's own parser — so this reads
    // exactly what the build will read. `git show` rather than `readFile` for the same reason the
    // builder fetches a ref: an uncommitted mesh.json is not in this deploy.
    const { stdout: json } = await run('git', ['show', `${commit.trim()}:${DESCRIPTOR_FILE}`], { cwd: root });
    const hostname = environmentOf(parseDescriptor(json), env).host;

    targets.push({ root, environment: env, commit: commit.trim(), subject: subject.trim(), hostname });
}

/**
 * **Two repositories cannot share a hostname**, and until this was here the second silently won.
 *
 * `cdn.site_put` is last-write-wins, correctly: pointing a hostname at a new artifact *is* the
 * deploy. So publishing two repositories to one hostname is not an error the CDN can see — from
 * where it sits, that is two deploys of one site. This script is the only thing that knows they came
 * from different repositories, so it is the only thing that can say so.
 *
 * It is the common case rather than a corner: every `mesh.json` in existence names `localhost` for
 * its `local` environment, so any two of them collide. Checked here, before the first build, because
 * the alternative is finding out after two minutes of `npm ci` that the work was going to be
 * discarded.
 */
const byHost = new Map();
for (const target of targets) {
    const first = byHost.get(target.hostname);
    if (first !== undefined) {
        console.error(`Both repositories publish to "${target.hostname}":`);
        console.error(`  ${first.root} (${first.environment})`);
        console.error(`  ${target.root} (${target.environment})`);
        console.error('\nOne needs a host of its own. Add an environment to its mesh.json —');
        console.error('"127.0.0.1" and "localhost" are different sites, because normalizeHostname');
        console.error('strips the port and lowercases and does nothing else — then select it per');
        console.error('repository:  --repo <path>#<environment>.  Nothing was built.');
        process.exit(1);
    }
    byHost.set(target.hostname, target);
}

for (const target of targets) {
    console.log(`deploying ${target.root}`);
    console.log(`building ${target.commit.slice(0, 8)} — ${target.subject} → ${target.hostname}`);
}
console.log('(a commit, not the working tree: anything uncommitted is not in this site)\n');

const app = new MeshApp({ nodeID: 'deploy-local', namespace: 'mesh-web-deploy' });
app.use(new RegistryModule());
app.use(new BrokerModule());
await app.start();

const builder = createBuilderModule({
    // A real install and a real compile. Generous, because `npm ci` on a cold cache is not fast.
    timeoutMs: 10 * 60_000,
    // A6.8a. The workspace is thrown away every build; the cache is not, so the second build of a
    // repository copies from disk instead of fetching the network again. Under the scratch root
    // rather than in the repository, because it is not source.
    packageCache: join(tmpdir(), 'mesh-web-deploy-cache'),
    onError: (error) => { console.error(error); },
});
await app.registerModule(builder);

/**
 * Registered *before* the builds, and B8c's first suggestion was wrong about this.
 *
 * That entry proposed starting the CDN afterwards, so the port would not answer during a build. It
 * cannot: publishing is `cdn.site_put`, so the module has to be mounted before a build can publish
 * to it — and the module that owns the site map is the same one that binds the port. Deferring only
 * the listener would mean a `listen: false` on a production serving module for a dev script's sake,
 * which is the wrong thing to add to a node whose job is to bind and serve.
 *
 * So the other half of B8c: **say it, up front.** The window is real and the message it produces
 * during that window is indistinguishable from a genuinely misconfigured `mesh.json`.
 */
const cdn = createCdnModule({ port, host: '127.0.0.1', onError: (e) => { console.error(e); } });
await app.registerModule(cdn);

console.log(`http://localhost:${String(port)}/ is open now and 404s until the build lands.`);
console.log('("No site is configured for this hostname." means not yet, not misconfigured.)\n');

const call = (tool, params) => app.call(tool, params);

const built = [];

for (const target of targets) {
    const started = Date.now();
    const result = await call('builder.build_start', {
        // A checkout, by path. A git remote works identically; a local path is what makes this
        // runnable with no forge.
        source: { kind: 'git', repository: target.root, ref: target.commit },
        environment: target.environment,
        publish: true,
        tenantId: 'local',
    });

    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (result.build.state !== 'succeeded') {
        console.error(`\n${target.root} failed after ${seconds}s\n`);
        console.error(result.build.log ?? result.build.error);
        process.exit(1);
    }

    built.push({ ...result, seconds, root: target.root });
}

for (const result of built) {
    const { artifact } = result;
    console.log(`\nbuilt in ${result.seconds}s${result.cached ? ' (cached — nothing ran)' : ''}`);
    console.log(`  artifact ${artifact.digest.slice(0, 16)}…`);
    console.log(`  ${String(artifact.files.length)} files, ${(artifact.totalSize / 1024).toFixed(0)} KiB`);
    console.log(`  hostname ${result.hostname} — from the repository's own mesh.json`);

    // A9.1a. Printed because it is the answer to *what is actually in this thing*, and until now the
    // only way to see it was to write a script. A deploy that will not say what it published is the
    // same silence B8c is about.
    const declaration = artifact.declaration;
    for (const part of declaration?.parts ?? []) {
        const extra = part.domains === undefined ? part.entry : part.domains.join(', ');
        console.log(`    ${part.kind.padEnd(11)} ${part.id} — ${extra}`);
    }
    for (const dep of declaration?.builtAgainst ?? []) {
        // The commit, when there is one: a package installed from a branch keeps its author's
        // version forever, so the version alone would say the same thing on every build.
        const at = dep.commit === undefined ? dep.version : `${dep.version} @ ${dep.commit.slice(0, 8)}`;
        console.log(`    built against  ${dep.package} ${at}`);
    }
}

console.log(`\n  http://localhost:${String(port)}/ now serves ${String(built.length)} site(s):`);
for (const result of built) {
    console.log(`    ${result.hostname}`);
}
console.log('\nCtrl-C to stop.');

process.on('SIGINT', () => {
    void cdn.onStop?.().then(() => app.stop()).then(() => process.exit(0));
});
