/**
 * @flybyme/mesh-web-protocol — the types both halves agree on.
 *
 * D6 (spec/hosting.md §0): one repository, several packages, drawn so **an Application author
 * imports one package and never sees the other**. This is the third package, and it has no runtime
 * at all: the browser package and the two server packages may both depend on it precisely because
 * there is nothing here to pull in.
 *
 * ## The two mistakes this file exists to prevent
 *
 * spec/hosting.md §6 records what the previous generation got wrong, and both defects are the same
 * mistake wearing different clothes:
 *
 * > source had to be a directory on the building node's disk (`UIManifest.sourceDir`), and the
 * > artifact record was an absolute path on whichever node built it (`UIArtifact.filePath`). So
 * > nothing could be built from elsewhere and nothing could move once built.
 *
 * So the types below make both unrepresentable:
 *
 * - **Source is a reference**, never a path. A git repository and ref, or an uploaded archive.
 * - **An artifact is content**, never a location. Bytes and a hash, addressable from any node.
 *
 * There is deliberately no `path`, `dir` or `filePath` field anywhere in this file. A type cannot
 * stop someone putting a path in a string, but it can stop the shape from inviting it.
 */

// ---------------------------------------------------------------------------- source

/**
 * Where a build gets its input.
 *
 * A *reference*, resolvable by any builder anywhere. The builder fetches it into a scratch workspace
 * it owns and destroys afterwards, which is what makes "the code must not have to be local to the
 * server" true rather than aspirational.
 */
export type SourceRef =
    | {
        readonly kind: 'git';
        readonly repository: string;
        /** A branch, tag or commit. Resolved to a commit before anything is hashed. */
        readonly ref: string;
        /** Build from a subdirectory of the repository, for a monorepo. Not a path on any disk. */
        readonly subdirectory?: string;
    }
    | {
        readonly kind: 'archive';
        /** Where the archive can be fetched from, by anyone who needs it. */
        readonly url: string;
        /** So a builder can refuse an archive that changed under it. */
        readonly digest: string;
    };

// ---------------------------------------------------------------------------- artifacts

/**
 * One file in an artifact.
 *
 * `path` here is a path *within the artifact* — `index.html`, `assets/app.js` — which is a name, not
 * a location. It says nothing about where the bytes are, and any node holding the content can serve
 * it under this name.
 */
export interface ArtifactFile {
    readonly path: string;
    /** Content hash of this file alone, so an unchanged file is not re-fetched between builds. */
    readonly digest: string;
    readonly size: number;
    readonly contentType: string;
}

/**
 * A built site, as content.
 *
 * `digest` addresses the whole set, so "is this the artifact I mean" is answerable without trusting
 * a name, and a node that already has it can skip the fetch entirely. Immutable once built: a new
 * build is a new artifact, never an edit of this one, which is what lets a CDN cache it forever.
 */
export interface Artifact {
    readonly digest: string;
    readonly files: readonly ArtifactFile[];
    readonly totalSize: number;
    readonly builtAt: number;
    /** Which build produced it, for tracing back. Not needed to serve it. */
    readonly buildId: string;
    /**
     * What this artifact provides, and what it was built against — roadmap A9.1a.
     *
     * Optional only because artifacts built before this existed do not have one. A build produces it
     * now, always.
     */
    readonly declaration?: Declaration;
}

// ---------------------------------------------------------------------------- declaration

/**
 * What an artifact says it provides — *declared*, in the sense of
 * [declared/desired/observed](https://github.com/FLYBYME/mesh/blob/master/docs/DECLARED_DESIRED_OBSERVED.md).
 *
 * **The artifact carries this, rather than a registry computing it later.** Decided 2026-09-05: a
 * build writes the description, so registering an artifact is a write rather than a compile, and an
 * artifact that has been copied to another node arrives already able to say what it is.
 *
 * It is deliberately *not* a copy of the deployment descriptor. `mesh.json` is build input — what
 * someone asked to be built. This is build output — what was actually produced, with the versions
 * that were actually resolved.
 */
export interface Declaration {
    readonly parts: readonly DeclaredPart[];
    /**
     * The resolved versions this artifact's code was compiled and linked against — roadmap A9.1a.
     *
     * **This is the whole price of building parts separately.** With one build per site, a mismatched
     * framework could not happen: everything compiled together or nothing did. With a part built
     * against `@flybyme/mesh-web` 1.2 and loaded into a site serving 2.0, nothing catches it — there
     * is no longer a build that sees both. It fails at run time, in a user's browser.
     *
     * So the version is recorded here, at the only moment it is known for certain, and whatever loads
     * a part compares before loading. Resolved from the built tree, never from a range in a
     * `package.json`: `^1.2.0` is a wish, and the installed version is the fact.
     */
    readonly builtAgainst: readonly ResolvedDependency[];
}

/**
 * One Application, Extension or service module an artifact contains.
 *
 * `entry` is a path *within the artifact*, the same kind of name as `ArtifactFile.path` — a name, not
 * a location, for exactly the reasons in the header of this file.
 */
export interface DeclaredPart {
    readonly kind: 'application' | 'extension' | 'service';
    /** Stable across builds. What a site's composition names when it says it loads this. */
    readonly id: string;
    readonly entry: string;
    /** For an extension: the provider key it returns, so a consumer can be matched to it. */
    readonly provides?: string;
    readonly consumes?: readonly string[];
    /** Capability names, for an Extension or Application. Declared, so it is readable before loading. */
    readonly needs?: readonly string[];
    /** For a service: the mesh domains it mounts, so declared can answer "who provides `identity.*`". */
    readonly domains?: readonly string[];
}

export interface ResolvedDependency {
    readonly package: string;
    /** An exact version. Never a range — see `builtAgainst`. */
    readonly version: string;
    /**
     * The commit, for a dependency installed from a git ref — and **the only identity that means
     * anything for one.**
     *
     * Found 2026-09-05 by running this against the first real repository. `@flybyme/mesh-web` is
     * installed as `github:FLYBYME/mesh-web`, and the version in its `package.json` is `0.1.0`. It
     * will be `0.1.0` on every build forever, because nothing bumps the version of a package consumed
     * from a branch. So `version` — the field A9.1a added specifically to catch a framework
     * mismatch — is **constant across every framework change**, and would have caught nothing.
     *
     * The lockfile knows: `resolved` carries `…mesh-web.git#3482d5d…`. That is the fact worth
     * recording, and it is the same defect the console already met once, when it ran for an hour
     * against a framework that predated A7.8 and type-checked clean the whole time.
     */
    readonly commit?: string;
}

// ---------------------------------------------------------------------------- builds

export type BuildState = 'queued' | 'fetching' | 'building' | 'publishing' | 'succeeded' | 'failed';

/**
 * The hash of everything that determines the output.
 *
 * spec/hosting.md §6: *builds are reproducible enough to be cached by input hash* — same source ref,
 * same environment, same artifact, no rebuild. This names precisely what "same" means, so the answer
 * does not drift as inputs are added.
 */
export interface BuildInputs {
    /** The *resolved* source — a commit, never a branch, or a branch would hash to itself forever. */
    readonly source: SourceRef;
    readonly environment: string;
    /** Frozen policy, which changes the output, so it changes the hash (B3, A4.7). */
    readonly policy: Readonly<Record<string, unknown>>;
    /** The builder's own version: a builder change can change the output too. */
    readonly builderVersion: string;
}

export interface Build {
    readonly id: string;
    readonly application: string;
    readonly environment: string;
    readonly source: SourceRef;
    readonly inputHash: string;
    readonly state: BuildState;
    readonly startedAt: number;
    readonly finishedAt?: number;
    /** Present once published. */
    readonly artifactDigest?: string;
    readonly error?: string;
    /** Build output, kept because a failed build with no log is a bug report nobody can act on. */
    readonly log?: string;
}

// ---------------------------------------------------------------------------- sites

/**
 * A hostname, and what it serves.
 *
 * spec/hosting.md §2: *a site is a hostname*. There is no path prefix and no build-time coupling
 * between a site and a server — **any CDN node asked for it can serve it**, which is only true
 * because everything needed to answer is in this record and the content it names.
 */
export interface Site {
    readonly hostname: string;
    readonly application: string;
    readonly environment: string;
    /**
     * The owner.
     *
     * Carried on the site because §3's isolation boundary *is* the hostname: serving two tenants
     * from one origin would put one tenant's code in the other's origin, with its storage and its
     * cookies. A serving-layer invariant checks this, and it needs the answer to be here.
     */
    readonly tenantId: string;
    /** What this hostname currently serves at `/`. Changing it is the deploy. */
    readonly artifactDigest: string;
    /**
     * Further artifacts, mounted under a path — the kernel/apps split.
     *
     * **Until this existed a hostname served exactly one artifact**, so a site that wanted a
     * framework had no way to reference one and `site.mjs` copied it in. Measured on the first real
     * site: `out/framework` was 1.1 MB across 192 files against `out/app`'s 72 KB across 8 — **94% of
     * every artifact was a private copy of the kernel**, and two sites on one node meant two copies
     * of identical bytes with different URLs.
     *
     * Different URLs is the part that matters. Blobs already dedupe in the store, so the waste was
     * never really storage; it is that a browser resolves modules by URL, so two copies are two
     * module graphs and two of every singleton the capability model depends on. Mounting one
     * content-addressed kernel at one path is what makes it one kernel.
     *
     * Longest prefix wins, and a mount never shadows a file the root artifact actually has — see
     * `resolveMount`.
     */
    readonly mounts?: readonly Mount[];
    readonly updatedAt: number;
}

/**
 * One artifact, served under a path prefix.
 *
 * `at` is a name within the site's URL space — `/framework` — not a location on any disk, the same
 * distinction this file's header draws for `ArtifactFile.path`.
 */
export interface Mount {
    readonly at: string;
    readonly artifactDigest: string;
}

// ---------------------------------------------------------------------------- deployment

/**
 * What a repository declares about itself — spec/hosting.md §5, and B8.
 *
 * In the site's own repo, which is the same decision C3.2 made for exposure and for the same reason:
 * the people who own the site own what it exposes and where it runs, and a list owned elsewhere
 * drifts.
 */
export interface DeploymentDescriptor {
    readonly application: string;
    /**
     * The service half, if the product has one.
     *
     * Optional, and that is the point ([hosting §0a](../../../spec/hosting.md)): the stack grows by
     * starting with a service and adding a face when you want one, so the descriptor grows the same
     * way. A repo with only a UI omits this; a repo with only a service module omits `ui`.
     */
    readonly service?: ServiceDescriptor;
    /** The UI half, if the product has one. A site with no `ui` builds no artifact and serves no host. */
    readonly ui?: UiDescriptor;
    readonly environments: Readonly<Record<string, EnvironmentDescriptor>>;
}

/**
 * What the repository's service module is and where it lives.
 *
 * **No exposure list here**, and it is not an omission. B8 promised the descriptor would carry one;
 * it cannot, because an exposure entry references a real contract object and JSON holds no such
 * thing. Naming the *module that declares it* is enough — a build loads `entry` and calls
 * `describeExposure()`, which is already how the client generator works with no cluster running
 * (C3.1a).
 */
export interface ServiceDescriptor {
    /** The built module, relative to the repo root. Loaded to read its exposure. */
    readonly entry: string;
    /** What to run to produce `entry`. */
    readonly build?: string;
    /**
     * The domains this repository provides.
     *
     * The one field written for a reader outside this design: a deployer asking *where does
     * `weather.*` come from* answers it from the file, without running anything. One string per
     * domain rather than an interface, because that is the whole of the question.
     */
    readonly domains?: readonly string[];
}

/** What the repository's UI is and how it is built into an artifact. */
export interface UiDescriptor {
    /** What to run to produce `output`. */
    readonly build: string;
    /** The directory the build writes, relative to the fetched source. Becomes the artifact. */
    readonly output: string;
    /**
     * The Applications and Extensions this repository builds — roadmap A9.1.
     *
     * Declared rather than discovered, for the same reason [Extensions §3](../../../spec/extension.md)
     * gives: the kernel needs to know what a part *is* before running it, and a site's composition
     * names these ids. A build turns them into an artifact's `Declaration`.
     *
     * Only what a JSON file can honestly hold: an id, a kind and an entry. `provides`, `consumes` and
     * `needs` are facts about the *code* and are deliberately not repeated here — a hand-written copy
     * of a `needs(...)` call is a second source of truth that drifts silently.
     */
    readonly parts?: readonly DescribedPart[];
}

/** A part as its repository names it, before a build resolves anything about it. */
export interface DescribedPart {
    readonly kind: 'application' | 'extension';
    readonly id: string;
    /** Path within `output` — the built entry, not the source file. */
    readonly entry: string;
}

export interface EnvironmentDescriptor {
    readonly host: string;
    /** Where the browser sends `cx.mesh` calls. Same origin in production, behind the proxy. */
    readonly api: string;
    /**
     * Values frozen into the bundle for this environment (B3, A4.7).
     *
     * Not a setting: there is no provider and no write path, so it cannot be changed at run time.
     * `{ 'window-manager/mode': 'tiled' }` is how a blog is locked, and locking it is a *build*
     * rather than a mechanism in the window manager.
     */
    readonly policy?: Readonly<Record<string, unknown>>;
    /**
     * A build that differs for *this* environment. An override, not the default location.
     *
     * How a repo builds is a property of the repo, so it lives in `ui` — this exists for the case
     * where one environment genuinely builds differently. It was the only location before B8b, and
     * the format's very first user duplicated an identical command across `production` and `local`,
     * which is the drift this shape removes.
     */
    readonly build?: { readonly command: string; readonly output: string };
}
