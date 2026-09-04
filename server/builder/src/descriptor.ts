/**
 * The deployment descriptor — roadmap B8, spec/hosting.md §5.
 *
 * **The repository declares its own deployment.** A repo says what environments it has, what host
 * each one serves from, what API the browser talks to, what to run to build it and what policy is
 * frozen into the bundle. This is the same decision C3.2 made for exposure, for the same reason: the
 * site's own team owns what it exposes and where it runs, and a list owned elsewhere drifts, because
 * nobody deleting a screen closes the route it used.
 *
 * Two things are deliberately **not** in the descriptor, and both are the same rule:
 *
 * - **The tenant.** A repository that could name its own owner could name someone else's. Ownership
 *   comes from whoever asked for the build, whose scope the API already resolved.
 * - **Anything about a filesystem.** `build.output` is a directory *inside the fetched source*, not
 *   a path on a builder — the whole of spec/hosting.md §6's first defect was a source that had to be
 *   local to the server.
 *
 * The file is read from the workspace the builder itself created and destroys, so nothing here ever
 * hands a path to a caller.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
    DeploymentDescriptor, EnvironmentDescriptor, ServiceDescriptor, UiDescriptor,
} from '@flybyme/mesh-web-protocol';

/**
 * What the file is called in a repository.
 *
 * `mesh.json`, not `mesh-web.json` — B8b. A repo that contains a service module as well as a UI is
 * not described by a file named after the UI, and [hosting §0a](../../../spec/hosting.md) puts the
 * service first in the order things get built. Renamed while exactly one file in existence used the
 * old name, which was this repository's own.
 */
export const DESCRIPTOR_FILE = 'mesh.json';

export class DescriptorError extends Error {
    override readonly name = 'DescriptorError';
}

/**
 * Parse and check a descriptor.
 *
 * Every failure names the field, because this file is written by hand by someone who is not
 * watching the builder's logs. "Invalid descriptor" tells them to guess.
 */
export function parseDescriptor(text: string): DeploymentDescriptor {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new DescriptorError(
            `${DESCRIPTOR_FILE} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DescriptorError(`${DESCRIPTOR_FILE} must be a JSON object.`);
    }

    const raw = value as Record<string, unknown>;

    const application = raw['application'];
    if (typeof application !== 'string' || application.trim() === '') {
        throw new DescriptorError(`${DESCRIPTOR_FILE} needs an "application" name.`);
    }

    const environments = raw['environments'];
    if (typeof environments !== 'object' || environments === null || Array.isArray(environments)) {
        throw new DescriptorError(`${DESCRIPTOR_FILE} needs an "environments" object.`);
    }

    const parsed: Record<string, EnvironmentDescriptor> = {};
    for (const [name, entry] of Object.entries(environments as Record<string, unknown>)) {
        parsed[name] = parseEnvironment(name, entry);
    }

    if (Object.keys(parsed).length === 0) {
        // An empty map would let every build fail with "no such environment" and give no clue that
        // the descriptor itself is the problem.
        throw new DescriptorError(`${DESCRIPTOR_FILE} declares no environments.`);
    }

    const service = parseService(raw['service']);
    const ui = parseUi(raw['ui']);

    // A repo with neither half declares a product that is nothing. Both being optional is the point
    // of the shape, but *both* absent is always a mistake rather than a minimal case.
    if (service === undefined && ui === undefined) {
        throw new DescriptorError(
            `${DESCRIPTOR_FILE} declares neither a "service" nor a "ui". A repository with neither ` +
            `has nothing to build — see spec/hosting.md §5.`,
        );
    }

    return {
        application,
        ...(service === undefined ? {} : { service }),
        ...(ui === undefined ? {} : { ui }),
        environments: parsed,
    };
}

function parseService(value: unknown): ServiceDescriptor | undefined {
    if (value === undefined) return undefined;

    const where = `${DESCRIPTOR_FILE} "service"`;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DescriptorError(`${where} must be an object.`);
    }

    const raw = value as Record<string, unknown>;

    const entry = raw['entry'];
    if (typeof entry !== 'string' || entry.trim() === '') {
        throw new DescriptorError(
            `${where} needs an "entry" — the built module a build loads to read its exposure.`,
        );
    }
    if (entry.startsWith('/') || entry.split('/').includes('..')) {
        // Same rule as build.output, and the same reason: the entry is joined onto the workspace,
        // and the builder runs code from a repository it does not trust.
        throw new DescriptorError(`${where} has an "entry" that leaves the source: "${entry}".`);
    }

    const build = raw['build'];
    if (build !== undefined && (typeof build !== 'string' || build.trim() === '')) {
        throw new DescriptorError(`${where} has a "build" that is not a command.`);
    }

    const domains = raw['domains'];
    if (domains !== undefined) {
        if (!Array.isArray(domains) || domains.some((d) => typeof d !== 'string' || d.trim() === '')) {
            throw new DescriptorError(`${where} has "domains" that is not a list of domain names.`);
        }
    }

    return {
        entry,
        ...(build === undefined ? {} : { build: build as string }),
        ...(domains === undefined ? {} : { domains: domains as readonly string[] }),
    };
}

function parseUi(value: unknown): UiDescriptor | undefined {
    if (value === undefined) return undefined;

    const where = `${DESCRIPTOR_FILE} "ui"`;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DescriptorError(`${where} must be an object.`);
    }

    const raw = value as Record<string, unknown>;

    const build = raw['build'];
    if (typeof build !== 'string' || build.trim() === '') {
        throw new DescriptorError(`${where} needs a "build" command.`);
    }

    const output = raw['output'];
    if (typeof output !== 'string' || output.trim() === '') {
        throw new DescriptorError(`${where} needs an "output" — the directory the build writes.`);
    }
    if (output.startsWith('/') || output.split('/').includes('..')) {
        throw new DescriptorError(`${where} has an "output" that leaves the source: "${output}".`);
    }

    return { build, output };
}

function parseEnvironment(name: string, value: unknown): EnvironmentDescriptor {
    const where = `${DESCRIPTOR_FILE} environment "${name}"`;

    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new DescriptorError(`${where} must be an object.`);
    }

    const raw = value as Record<string, unknown>;

    const host = raw['host'];
    if (typeof host !== 'string' || host.trim() === '') {
        // The host *is* the site (spec/hosting.md §2), so an environment without one cannot be
        // deployed at all — better to say so here than to build for ten minutes and then discover it.
        throw new DescriptorError(`${where} needs a "host".`);
    }

    const api = raw['api'];
    if (typeof api !== 'string' || api.trim() === '') {
        throw new DescriptorError(`${where} needs an "api" — where the browser sends cx.net calls.`);
    }

    const policy = raw['policy'];
    if (policy !== undefined && (typeof policy !== 'object' || policy === null || Array.isArray(policy))) {
        throw new DescriptorError(`${where} has a "policy" that is not an object.`);
    }

    const build = raw['build'];
    let parsedBuild: EnvironmentDescriptor['build'];
    if (build !== undefined) {
        if (typeof build !== 'object' || build === null || Array.isArray(build)) {
            throw new DescriptorError(`${where} has a "build" that is not an object.`);
        }
        const command = (build as Record<string, unknown>)['command'];
        const output = (build as Record<string, unknown>)['output'];
        if (typeof command !== 'string' || command.trim() === '') {
            throw new DescriptorError(`${where} needs "build.command".`);
        }
        if (typeof output !== 'string' || output.trim() === '') {
            throw new DescriptorError(`${where} needs "build.output" — the directory the build writes.`);
        }
        if (output.startsWith('/') || output.split('/').includes('..')) {
            // The output directory is joined onto the workspace. A build that could name `/etc` or
            // climb out of its own tree would publish whatever it found there, and the builder runs
            // code from a repository it does not trust.
            throw new DescriptorError(`${where} has a "build.output" that leaves the source: "${output}".`);
        }
        parsedBuild = { command, output };
    }

    return {
        host,
        api,
        ...(policy === undefined ? {} : { policy: policy as Readonly<Record<string, unknown>> }),
        ...(parsedBuild === undefined ? {} : { build: parsedBuild }),
    };
}

/**
 * One environment, named, **with its build already resolved**.
 *
 * The merge happens here rather than at each reader, because "the environment as it applies" is what
 * every caller actually wants and there is exactly one rule: `ui.build`/`ui.output` is the default,
 * and an environment's own `build` overrides it. B8b moved the build out of the environments for
 * that reason — how a repo builds is a property of the *repo*, and only host, api and policy
 * genuinely vary — so resolving it once here keeps every reader unaware there was ever a choice.
 *
 * The failure lists what the repository *does* declare, because "no environment called staging" and
 * "the environments are production and preview" are the same message and only one of them is useful.
 */
export function environmentOf(
    descriptor: DeploymentDescriptor,
    environment: string,
): EnvironmentDescriptor {
    const found = descriptor.environments[environment];
    if (found === undefined) {
        const names = Object.keys(descriptor.environments).join(', ');
        throw new DescriptorError(
            `${descriptor.application} declares no "${environment}" environment. It has: ${names}.`,
        );
    }

    if (found.build !== undefined) return found;
    if (descriptor.ui === undefined) return found;

    return { ...found, build: { command: descriptor.ui.build, output: descriptor.ui.output } };
}

/**
 * Read the descriptor out of a fetched source tree.
 *
 * `root` is the builder's own workspace — the only place this is ever called with, and the reason
 * this function is not exported through the module's contracts.
 */
export async function loadDescriptor(root: string): Promise<DeploymentDescriptor> {
    let text: string;
    try {
        text = await readFile(join(root, DESCRIPTOR_FILE), 'utf8');
    } catch {
        throw new DescriptorError(
            `This repository has no ${DESCRIPTOR_FILE}. A site declares its own environments, host ` +
            `and build — see spec/hosting.md §5.`,
        );
    }
    return parseDescriptor(text);
}
