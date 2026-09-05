/**
 * The deployment descriptor — roadmap B8b, spec/hosting.md §5.
 *
 * These are the checks the builder does before it runs anything, and they are worth their own file
 * because the person who trips them is not watching a build log. They wrote a JSON file by hand and
 * pushed. Every assertion below is really about the *message*: whether it names the field, and
 * whether someone could act on it without reading this repository.
 *
 * The shape under test is B8b's. What it replaced put `build` inside each environment, and this
 * repository's own descriptor — the format's first user, written the same day — duplicated an
 * identical `npx -p typescript tsc …` across `production` and `local`. So the first group here is
 * about that: a build declared once, and an environment that may still override it.
 */

import { describe, expect, it } from 'vitest';

import {
    DESCRIPTOR_FILE, DescriptorError, environmentOf, parseDescriptor,
} from '../../server/builder/src/index.js';

const UI_ONLY = {
    application: 'blog',
    ui: { build: 'npm run build', output: 'out' },
    environments: {
        production: { host: 'blog.example.com', api: 'https://blog.example.com/api' },
        local: { host: 'localhost', api: 'http://127.0.0.1:5005' },
    },
};

/** hosting §5's own example, as written. */
const BOTH_HALVES = {
    application: 'weather',
    service: {
        entry: './server/dist/index.js',
        build: 'npm run build:server',
        domains: ['weather'],
    },
    ui: { build: 'npm run build:ui', output: 'ui/dist' },
    environments: {
        production: {
            host: 'weather.example.com',
            api: 'https://weather.example.com/api',
            policy: { 'window-manager/mode': 'tiled' },
        },
        local: { host: 'localhost', api: 'http://127.0.0.1:5005' },
    },
};

const parse = (value: unknown) => parseDescriptor(JSON.stringify(value));

/** Every message is read by someone who has not seen this code. */
const refusal = (value: unknown): string => {
    try {
        parse(value);
    } catch (error) {
        if (error instanceof DescriptorError) return error.message;
        throw error;
    }
    throw new Error('the descriptor was accepted');
};

describe('the build is declared once, for the repository', () => {
    it('applies ui.build to every environment', () => {
        const descriptor = parse(UI_ONLY);

        for (const name of ['production', 'local']) {
            expect(environmentOf(descriptor, name).build)
                .toEqual({ command: 'npm run build', output: 'out' });
        }
    });

    it('lets one environment override it without the others knowing', () => {
        const descriptor = parse({
            ...UI_ONLY,
            environments: {
                ...UI_ONLY.environments,
                local: {
                    host: 'localhost',
                    api: 'http://127.0.0.1:5005',
                    build: { command: 'npm run build:fast', output: 'out' },
                },
            },
        });

        expect(environmentOf(descriptor, 'local').build?.command).toBe('npm run build:fast');
        expect(environmentOf(descriptor, 'production').build?.command).toBe('npm run build');
    });

    it('leaves an environment with no build at all when the repo declares no ui', () => {
        // A service-only repository. There is nothing to build into an artifact and nothing to
        // serve, and that is a legitimate descriptor rather than a broken one.
        const descriptor = parse({
            application: 'weather',
            service: { entry: './dist/index.js', domains: ['weather'] },
            environments: { production: { host: 'weather.example.com', api: 'https://weather.example.com/api' } },
        });

        expect(descriptor.ui).toBeUndefined();
        expect(environmentOf(descriptor, 'production').build).toBeUndefined();
    });
});

describe('both halves are optional, and the file grows the way the stack does', () => {
    it('reads a service and a ui together', () => {
        const descriptor = parse(BOTH_HALVES);

        expect(descriptor.service).toEqual({
            entry: './server/dist/index.js',
            build: 'npm run build:server',
            domains: ['weather'],
        });
        expect(descriptor.ui).toEqual({ build: 'npm run build:ui', output: 'ui/dist' });
    });

    it('reads a ui with no service', () => {
        const descriptor = parse(UI_ONLY);

        expect(descriptor.service).toBeUndefined();
        expect(descriptor.ui?.output).toBe('out');
    });

    it('refuses a repository that declares neither', () => {
        const message = refusal({
            application: 'nothing',
            environments: { production: { host: 'x.example.com', api: 'https://x.example.com' } },
        });

        expect(message).toContain('"service"');
        expect(message).toContain('"ui"');
    });
});

describe('service.domains says what the repo provides without running it', () => {
    it('carries the domains through', () => {
        expect(parse(BOTH_HALVES).service?.domains).toEqual(['weather']);
    });

    it('allows a service that declares none', () => {
        const descriptor = parse({
            ...BOTH_HALVES,
            service: { entry: './server/dist/index.js' },
        });

        expect(descriptor.service?.domains).toBeUndefined();
        expect(descriptor.service?.entry).toBe('./server/dist/index.js');
    });

    it('refuses domains that are not a list of names', () => {
        expect(refusal({ ...BOTH_HALVES, service: { entry: './x.js', domains: 'weather' } }))
            .toContain('"domains"');
        expect(refusal({ ...BOTH_HALVES, service: { entry: './x.js', domains: ['weather', ''] } }))
            .toContain('"domains"');
    });
});

describe('a path in the descriptor may not leave the source', () => {
    // The builder runs code from a repository it does not trust, and both of these are joined onto
    // the workspace. A descriptor that could name `/etc` or climb out of its own tree would publish
    // whatever it found there.
    it('refuses a ui.output that escapes', () => {
        expect(refusal({ ...UI_ONLY, ui: { build: 'x', output: '/etc' } })).toContain('leaves the source');
        expect(refusal({ ...UI_ONLY, ui: { build: 'x', output: '../elsewhere' } })).toContain('leaves the source');
    });

    it('refuses a service.entry that escapes', () => {
        expect(refusal({ ...BOTH_HALVES, service: { entry: '/etc/passwd' } })).toContain('leaves the source');
        expect(refusal({ ...BOTH_HALVES, service: { entry: '../../secrets.js' } })).toContain('leaves the source');
    });
});

/**
 * Roadmap A9.1: every Application and Extension is its own artifact, and a site's composition names
 * them by id. So the ids have to be real before anything is built with them — a duplicate id makes a
 * composition ambiguous about which part it loaded, and the artifact would still build.
 */
describe('a repository declares the parts it builds', () => {
    const withParts = (parts: unknown) => ({ ...UI_ONLY, ui: { ...UI_ONLY.ui, parts } });

    it('reads the declared parts', () => {
        const descriptor = parse(withParts([
            { kind: 'extension', id: 'console.chrome', entry: 'app/chrome.js' },
            { kind: 'application', id: 'console', entry: 'app/main.js' },
        ]));

        expect(descriptor.ui?.parts).toEqual([
            { kind: 'extension', id: 'console.chrome', entry: 'app/chrome.js' },
            { kind: 'application', id: 'console', entry: 'app/main.js' },
        ]);
    });

    it('is absent, not empty, when a repository declares none', () => {
        expect(parse(UI_ONLY).ui?.parts).toBeUndefined();
    });

    it('refuses an empty list rather than reading it as none', () => {
        // "I have none" and "I have not finished editing this" look identical as `[]`, and the second
        // is far more likely.
        expect(refusal(withParts([]))).toContain('leave it out');
    });

    it('refuses two parts sharing an id, naming the id', () => {
        const message = refusal(withParts([
            { kind: 'extension', id: 'chrome', entry: 'a.js' },
            { kind: 'application', id: 'chrome', entry: 'b.js' },
        ]));

        expect(message).toContain('"chrome"');
        expect(message).toContain('twice');
    });

    it('names a missing kind, id and entry separately', () => {
        expect(refusal(withParts([{ id: 'x', entry: 'a.js' }]))).toContain('"kind"');
        expect(refusal(withParts([{ kind: 'extension', entry: 'a.js' }]))).toContain('"id"');
        expect(refusal(withParts([{ kind: 'extension', id: 'x' }]))).toContain('"entry"');
    });

    it('refuses a kind that is not an application or an extension', () => {
        // 'service' is a real DeclaredPart kind, but it comes from `service.domains` — a UI part
        // claiming to be one would put a mesh domain in an artifact that cannot mount it.
        expect(refusal(withParts([{ kind: 'service', id: 'x', entry: 'a.js' }]))).toContain('"kind"');
    });

    it('refuses an entry that leaves the artifact, naming it', () => {
        const message = refusal(withParts([{ kind: 'extension', id: 'x', entry: '../secrets.js' }]));

        expect(message).toContain('leaves the artifact');
        expect(message).toContain('../secrets.js');
    });

    it('says which entry of the list is wrong', () => {
        const message = refusal(withParts([
            { kind: 'extension', id: 'ok', entry: 'a.js' },
            { kind: 'extension', id: 'bad' },
        ]));

        expect(message).toContain('[1]');
    });
});

describe('every refusal names the field', () => {
    it('says which file it is talking about', () => {
        expect(DESCRIPTOR_FILE).toBe('mesh.json');
        expect(refusal({ environments: {} })).toContain(DESCRIPTOR_FILE);
    });

    it('names a missing application', () => {
        expect(refusal({ ...UI_ONLY, application: undefined })).toContain('"application"');
    });

    it('names a missing ui.build and a missing ui.output separately', () => {
        expect(refusal({ ...UI_ONLY, ui: { output: 'out' } })).toContain('"build"');
        expect(refusal({ ...UI_ONLY, ui: { build: 'x' } })).toContain('"output"');
    });

    it('names a service with no entry', () => {
        expect(refusal({ ...BOTH_HALVES, service: { domains: ['weather'] } })).toContain('"entry"');
    });

    it('lists the environments a repository does declare', () => {
        const descriptor = parse(UI_ONLY);

        expect(() => environmentOf(descriptor, 'staging')).toThrow(/production, local/);
    });

    it('says a descriptor with no environments is the problem, rather than failing per lookup', () => {
        expect(refusal({ ...UI_ONLY, environments: {} })).toContain('declares no environments');
    });
});
