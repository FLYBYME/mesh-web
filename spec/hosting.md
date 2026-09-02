# Hosting: the builder, the CDN, and how a site is found

> "like mesh-api mesh-web is it's own process running it's own http server"
> "every application/site is come from the host name. so console.surfdns.net will load the console
> app from any cdn that is asked to serve it"
> "this cdn system needs to be able to serve many independent site from any number of people"

**Status.** Design. **Decided** is settled. **Proposed** is mine. **Open** is not answered.

Companions: [the model](./README.md) · [storage and the registry](./storage-and-registry.md) ·
[authentication](./auth.md).

---

## 1. mesh-web is two things — **Decided**

A browser framework, and a **server process running its own HTTP server** — the builder and the CDN.
The same package name covers both halves, the way mesh-api does.

That is a correction to how this repo currently describes itself: the README says mesh-web is
"everything that runs in a tab" and that nothing in `src` may import a node builtin. The browser
half keeps that rule. The server half is a peer of it, in its own directory, with its own build,
and the two never import each other's internals — the same split mesh-api draws between `runtime/`
and `server/`, which is the split that made this repo necessary in the first place.

### Both servers sit behind the surfdns proxy — **Decided**

> "both the mesh-api and mesh-web http servers will be route through surfdns proxy system. they
> don't need to think about tls it's just a container running somewhere."

mesh-api and mesh-web are **plain HTTP containers**. They do not terminate TLS, do not hold
certificates, do not renew anything, and do not need to know their own public hostname to serve —
the proxy knows it, routes by it, and hands them an ordinary request.

Consequences, all simplifications:

- **No certificate machinery in this repo.** The custom-domain question in §7 is the proxy's, not
  mesh-web's, and is struck from the open list here.
- **A node is disposable.** No per-node state, no cert on disk, no hostname pinned to a machine —
  which is what makes "any CDN node asked to serve it can serve it" (§2) operationally true rather
  than aspirational.
- **`Host` is what a node routes on**, and the proxy is what guarantees the value is real. A node
  behind the proxy may trust it; a node exposed directly may not, and should not be exposed
  directly.
- **In-cluster API URLs are the normal case.** An Application's `api` endpoint points at a service
  address the proxy fronts, not at a public URL, which is why the deployment descriptor in §5 uses
  one.

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

> "same there might be 10 cdn"

Ten CDN nodes around the world, exactly as there may be ten APIs (§4). **The symmetry is exact and
it is the organising idea of this document:** both tiers are geographically distributed, both are
interchangeable, neither has a node that is the home of anything, and both are made interchangeable
by the same thing — they are nodes on one mesh.

So there is one set of problems here, not two. Whatever answers "how does a CDN node it has never
been asked about before find a site" should also answer "how does an API instance resolve a session
it did not issue", because both are asking the mesh for state that is not local. A design that
solves them separately has built the same distributed system twice.

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

## 4. A site defines its API and how it authenticates — **Decided**

> "every application defines it's API and how it auths. one application with does not automatically
> auth you with the second API."

**There is no session ambient across sites.** Signing into one site does not sign you into another,
because a site is an origin and the credentials for one origin's API are not the credentials for
another's.

Within a site it is the opposite, and deliberately so — see "The boundary is the site" below. Every
Application on a page shares that page's API and therefore its session. The unit of authentication
is the site, not the Application.

### Many instances, and addressing is a deployment choice — **Decided**

> "there might be 10 apis all around the world serving the same understanding mesh network"
> "the cdn might be behind a load balancer but the API might not and it might have its own url
> unique to that process and the same for the cdn"

An earlier draft said "a site talks to one API *address*, behind which are many instances". **That is
wrong**, and the correction matters because a lot follows from it.

**A process may have its own URL.** A mesh-api instance can be individually addressed, and so can a
mesh-web node. A load balancer in front of either is one deployment option among several, not the
architecture — the CDN might sit behind one while the API does not, or the reverse.

So the design must not assume a single address for a tier. What it may assume is what is actually
true:

- **Instances are equivalent in what they can answer**, because they are nodes on one mesh. Not
  replicas kept in step by a synchronisation mechanism — any of them can answer anything by asking
  the network. That is what the mesh is for.
- **Instances are not equivalent in how they are reached.** One may be `api-fra-1.example.net`,
  another behind `api.example.net`, another only reachable in-cluster. Addressing is deployment.

The consequences are worth spelling out because they are easy to get wrong in the other direction:

- **A site's `api` endpoint is whatever that deployment says it is** — a load-balanced name, one
  specific process, or an in-cluster address. The deployment descriptor (§5) already carries it per
  environment, which turns out to be exactly right.
- **Nothing may be built on "the same client keeps reaching the same instance."** No instance-local
  session state, no sticky assumptions. This is what makes
  [first-sight ticket validation](./auth.md) §3 the right design rather than merely a good one: it
  assumes nothing about which instance a request lands on.
- **Equally, nothing may assume a client is spread across instances.** A deployment with one API and
  one CDN is legitimate and common, and must not require a load balancer to work.

The CDN and API still have the same *shape* — distributed, interchangeable in capability, none the
home of anything. They just do not necessarily share an address.

#### What the mesh does *not* solve — **Proposed**

Three things, and they are the same thing wearing different clothes: **state that is not in the
mesh**.

**1. Sessions.** Sign in against Frankfurt, and the next request lands in Sydney. That request must
recognise you. surfdns already made the relevant decision and made it deliberately — sessions are
server-side records, not self-describing tokens, *so that logout, expiry and forced revocation are
real rather than advisory*. That decision is right and this does not overturn it, but it does put a
cost on it: every instance needs to resolve a session it did not issue, which is a shared read on
every authenticated request.

The alternatives looked like the usual three — shared store read every time; short-lived signed
token; signed token plus a revocation list. The answer turned out to be a fourth, and better than
any of them here: **validate on first sight, cache, invalidate by event**. See
[authentication](./auth.md) §3. An instance seeing an unfamiliar ticket asks over the mesh once and
caches; revocation arrives as an event and every instance drops it. One call per (ticket, instance)
rather than per request, revocation near-immediate rather than bounded by expiry, and — because
nothing is verified by signature — no signing key to distribute across ten regions at all.

**2. The registry's remote hives.** `user` and `system` are backed by a remote provider, and "remote"
is now ten places. This is where `EntryStat.version` and conditional writes stop being a nicety: two
regions writing one setting is not a hypothetical when the instances are this far apart. The
per-setting conflict policy already proposed — `reject` by default, geometry opting into
last-write-wins — is the mechanism, and its default matters more than it did an hour ago.

**3. The hostname → site mapping.** Already the open item flagged as the only shared, mutable,
cross-node state in the design. Ten regions makes it worse and also suggests its answer: it is
exactly the kind of thing the mesh's own registry is for, and putting it anywhere else means
building a second distributed system beside the one already running.

#### Live connections pick an instance and keep it — **Proposed**

An SSE stream or a WebSocket is a long-lived connection to one instance, and it must stay there for
its life. That is fine and needs no affinity machinery: the instance holding the connection is a
mesh node, so events raised anywhere in the network reach it. The fan-out is the mesh's job and it
already does it.

What does need care is reconnection. A dropped stream may come back on a different instance, so
`Last-Event-ID` resumption has to mean the same thing everywhere — which it does only if the event
log is in the mesh rather than in the instance's memory.

### The boundary is the site, not the Application — **Decided**

> "these apps are not logging into anything but the mesh-api"

An earlier draft of this section concluded that a session belongs to an (Application, API) pair and
that a singleton auth Extension was therefore wrong. That was an overcorrection. **The auth
Extension is right as originally described.**

The reconciliation is that §2 already drew the boundary, and it is the site:

- A **site is a hostname is an origin**, and a site talks to **one mesh-api address** — which may be
  any of ten instances, all equivalent because all on one mesh.
- Every Application running on that page therefore talks to the same API.
- One session for that API, provided by one auth Extension, is exactly correct — and the Extension
  being a singleton is not a compromise, it is the right shape.

"One application does not automatically auth you with the second API" is a statement about
**different sites**, which are different origins and different pages. There is no shared page on
which two APIs meet, so no ambient-session problem to solve. The browser's own origin model enforces
it, and nothing in the framework needs to.

This also means the earlier open question — do two Applications on one API share a session — is not
open. They share a page, a site and an API, so of course they do. That is the point.

---

## 5. An application repo declares its deployment — **Decided**

> "surfdns-console repo defines the production url and production API but must also support the
> environments"

The repo is the source of truth for where it lives — production, and every other environment.

It carries more than URLs. It carries **the mesh-api routing information and the mesh-web
configuration** — where the API is, what of it this site uses, and how the site is built and served.

### The site team owns its own exposure — **Decided**

> "surfdns-console team is responsible for what mesh stuff they expose and how and to who"

This is a real allocation of responsibility and worth stating as one. The team that owns the site
decides which mesh contracts its API surface exposes, by what route, and to whom. Not the platform
team, and not by a default that quietly widens.

It puts the decision where the knowledge is: the people writing the screens know which calls those
screens make, and an exposure list that lives beside the screens can be reviewed against them. An
exposure list owned elsewhere drifts open, because nobody removing a screen remembers to go and
close the route it used.

### Shape — **Proposed**

```yaml
# surfdns-console, in the repo
application: surfdns.console

environments:
  production:
    host: console.surfdns.net
    api:  http://surfdns-api            # in-cluster; the proxy fronts it
  staging:
    host: console.staging.surfdns.net
    api:  http://surfdns-api.staging
  development:
    host: localhost:5601
    api:  http://localhost:5600

# What of the mesh this site exposes, and to which roles. Owned by this team.
# Roles are records in mesh-identity, not an enum — see auth.md §5.
expose:
  - contract: identity.register      roles: [public]
  - contract: identity.whoami        roles: [member, admin]
  - contract: identity.members       roles: [member, admin]
  - contract: node.status            roles: [operator]

# How mesh-web builds and serves it.
web:
  entry: src/main.ts
  policy:
    mesh/window-manager/mode: tiled     # frozen at build; see the registry doc
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

- **Per-tenant limits and abuse.** §3. Ten nodes makes this worse: a limit enforced per node is ten
  times the limit, and a limit enforced globally is a shared counter in the hot path.
- **How sessions resolve on an instance that did not issue them.** Answered — see
  [authentication](./auth.md). What remains open there is ticket lifetime, ticket signing and key
  rotation.
- **Where the hostname → site mapping lives**, who may write it, and how a node that has never seen
  a hostname resolves it. Shared, mutable, cross-node state, and now the same question as sessions
  (§4) — which is the argument for answering them together and with the mesh, rather than building a
  second distributed system alongside the one already running.
- **Who administers a site.** > "who ever has control of the cdn/builder/API they all work together"
  Recorded as the answer in principle: administrative authority over a site is control of its
  deployment, not a role inside the running application. What is not settled is how a CDN node
  *verifies* that — a signature on the artifact, an identity at the builder, or trust in the
  hostname mapping. For a locked site this does not arise, because policy is frozen at build.
Closed since the first draft: two Applications on one API share a session (§4 — they share a site,
which is the boundary). Custom domains and certificates are the surfdns proxy's problem, not
mesh-web's (§1).
