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
    /** What this hostname currently serves. Changing it is the deploy. */
    readonly artifactDigest: string;
    readonly updatedAt: number;
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
