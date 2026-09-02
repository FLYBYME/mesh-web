# Hosting: the builder, the CDN, and how a site is found

> "like mesh-api mesh-web is it's own process running it's own http server"
> "every application/site is come from the host name. so console.surfdns.net will load the console
> app from any cdn that is asked to serve it"
> "this cdn system needs to be able to serve many independent site from any number of people"

**Status.** Design. **Decided** is settled. **Proposed** is mine. **Open** is not answered.

Companions: [the model](./README.md), [storage and the registry](./storage-and-registry.md).

---

## 1. mesh-web is two things — **Decided**

A browser framework, and a **server process running its own HTTP server** — the builder and the CDN.
The same package name covers both halves, the way mesh-api does.

That is a correction to how this repo currently describes itself: the README says mesh-web is
"everything that runs in a tab" and that nothing in `src` may import a node builtin. The browser
half keeps that rule. The server half is a peer of it, in its own directory, with its own build,
and the two never import each other's internals — the same split mesh-api draws between `runtime/`
and `server/`, which is the split that made this repo necessary in the first place.

### mesh-api as it exists is not the destination — **Decided**

> "what ever mesh-api is will most likely be deleted and adapted to how the mesh-web works"

Recorded so nothing is built on the assumption that mesh-api is stable. The exposure layer
(contract → REST/SSE/MCP) is the part with obvious value; the rest is subject to being replaced by
whatever mesh-web needs. **mesh-web leads and mesh-api follows**, not the other way round.

This also settles a live question from the registry doc, where the answer was "mesh-api owns the
registry contracts." That answer assumed mesh-api was a fixed point. It is not, so the contracts go
wherever mesh-web needs them and mesh-api adapts.

---

## 2. A site is a hostname — **Decided**

`console.surfdns.net` loads the console. The hostname *is* the address of the application; there is
no path prefix, no query parameter, no build-time coupling between a site and a server.

**Any CDN node asked to serve it can serve it.** A node receiving a request for a hostname it has
never seen resolves it, fetches what it needs, and serves. Nodes are interchangeable; none is the
home of a particular site.

### Resolution — **Proposed**

A request arrives with a `Host` header. The node resolves, in order:

1. **hostname → site** — which application, which version, which environment
2. **site → artifact** — the content-addressed bundle set for that version
3. **serve** — from local cache, or fetch the artifact from wherever it lives and then serve

The first step is a lookup against shared state, the second is content-addressed and therefore
cacheable forever, and the third is why any node can answer. A node with a cold cache is slower and
not wrong.

### Discovery is not access control — **Decided**

> "if I know where to find the app it will show and if I know the auth I can log in"

Knowing the hostname gets you the page. Authentication gets you data. These are separate, and the
page being reachable grants nothing — the same rule already applied to the manifest in surfdns,
where the manifest is identical for every caller and the API refuses what the caller may not have.

---

## 3. Many sites, many owners — **Decided**

> "this cdn system needs to be able to serve many independent site from any number of people"

Multi-tenant, with tenants who do not trust each other.

### What isolation comes free — **Proposed**

Each site has its own hostname, therefore its own **browser origin**. That gives, without any work:
separate cookie jars, separate `localStorage` and IndexedDB, separate service worker scope, and no
DOM access between sites. The strongest isolation boundary available in a browser is the one already
implied by the addressing scheme.

Consequences worth stating because they are easy to lose:

- **Never serve two tenants from one hostname.** No `cdn.example.com/site-a/`. That would collapse
  every boundary above into nothing.
- **The `device` hive is per-origin**, so it is already per-site. Window geometry for one site is
  invisible to another, correctly and for free.
- **The `system` hive is per-site**, not per-CDN.

### What does not come free — **Open**

Per-tenant quotas, per-tenant build resource limits, abuse handling, and what a node does when one
tenant's artifact is enormous or its build never terminates. A CDN serving strangers needs all of
these and none is designed.

---

## 4. Every application defines its own API and its own auth — **Decided**

> "every application defines it's API and how it auths. one application with does not automatically
> auth you with the second API."

**There is no ambient session.** Signing into one Application does not sign you into another. Two
Applications running side by side may be authenticated as different people, or one authenticated and
one not, and that is normal rather than a bug.

This follows from §2 and §3: a site is an origin, an Application talks to the API its own
`endpoints` declares, and the credentials for one origin's API are not the credentials for another's.

### What this changes — **Proposed**

The auth Extension as previously described — a singleton providing *the* session — is wrong. An
Extension is a singleton, but a session is not: it belongs to an (Application, API) pair.

Two ways to express it, and the second is better:

1. The auth Extension provides a factory: `auth.forEndpoint(url)` returns a session for that API.
2. **Auth is per-Application, and the `net` capability carries it.** An Application's `net` is
   already bound to its own `baseUrl`; the session is the credential state of that binding. What an
   auth Extension contributes is the *flow* — sign-in screens, token refresh, storage — not the
   identity.

The second keeps the invariant that makes the rule enforceable: **an Application cannot obtain
credentials for an API that is not its own**, because it never holds a `net` bound to one.

**Open:** whether two Applications pointing at the *same* API share a session. Same origin, same
cookie jar, so at the transport level they will unless prevented. Probably right, and it should be a
decision rather than a side effect.

---

## 5. An application repo declares its deployment — **Decided**

> "surfdns-console repo defines the production url and production API but must also support the
> environments"

The repo is the source of truth for where it lives — production, and every other environment.

### Shape — **Proposed**

```yaml
# surfdns-console, in the repo
application: surfdns.console

environments:
  production:
    host: console.surfdns.net
    api:  https://api.surfdns.net
  staging:
    host: console.staging.surfdns.net
    api:  https://api.staging.surfdns.net
  development:
    host: localhost:5601
    api:  http://localhost:5600
```

One build per environment, because `api` is baked in — and because the build is also where policy
is frozen and stripped ([registry](./storage-and-registry.md) §2), so environments already differ by
more than a URL. A development build with the window-mode switcher and a production build without it
are different artifacts, and pretending otherwise means shipping the switcher.

**Under paas these are filled in rather than written.** A hand-written `api` is the development case
and the escape hatch; the platform assigning one is the normal path, which is what the
`ApplicationEndpoints` declaration already anticipated.

---

## 6. The builder — **Proposed**

Carried forward from what the previous generation got wrong, which was concrete: source had to be a
directory on the building node's disk (`UIManifest.sourceDir`), and the artifact record was an
absolute path on whichever node built it (`UIArtifact.filePath`). So nothing could be built from
elsewhere and nothing could move once built. In a CDN with many nodes and many tenants, both are
fatal.

- **Source is a reference**, not a path: a git repository and ref, or an uploaded archive. The
  builder fetches into a scratch workspace it owns.
- **The artifact is content**, not a path: bytes plus a hash, addressable and servable from any node.
- **The build is per environment** (§5), and produces the frozen policy and the stripped bundle.
- **Builds are reproducible enough to be cached by input hash** — same source ref, same environment,
  same artifact, no rebuild.

The builder also owns the shared-module set and the import map, which is framework knowledge that
should not be rediscovered per consumer. It has already been got wrong twice by hand: duplicating
zod made `instanceof z.ZodObject` fail inside the form generator, which rendered a submit button and
no fields, with nothing in the console.

---

## 7. Open

- **Per-tenant limits and abuse.** §3.
- **Where the hostname → site mapping lives**, who may write it, and how a node that has never seen
  a hostname resolves it. This is the one piece of genuinely shared, mutable, cross-node state in
  the design, which makes it the piece most likely to be a bottleneck or a single point of failure.
- **Who administers a site.** > "who ever has control of the cdn/builder/API they all work together"
  Recorded as the answer in principle: administrative authority over a site is control of its
  deployment, not a role inside the running application. What is not settled is how a CDN node
  *verifies* that — a signature on the artifact, an identity at the builder, or trust in the
  hostname mapping. For a locked site this does not arise, because policy is frozen at build.
- **Do two Applications on one API share a session?** §4.
- **Custom domains and certificates.** A tenant bringing `blog.theirdomain.com` needs certificate
  issuance and renewal per hostname. Implied by §2 and not addressed.
