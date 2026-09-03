# Service modules

> "so the mesh-web and mesh-api and mesh-identity need to be ServiceModules. look at the paas style
> is how I want it"

**Status.** Design. **Decided** is settled. **Proposed** is mine. **Open** is not answered.

Companions: [the model](./README.md) · [storage and the registry](./storage-and-registry.md) ·
[hosting](./hosting.md) · [authentication](./auth.md).

---

## 1. The convention — **Decided**

Every server half is a mesh `ServiceModule`, laid out as paas lays them out:

```
<domain>.contract.ts     contracts: defineContract, defineCrud, defineEvent
<domain>.schema.ts       zod schemas, and nothing else
<domain>.service.ts      the ServiceModule class — mounts, and nothing else
<domain>.service.spec.ts
tools/
  <action>.ts            one action, exported as <domain>_<action>
```

The class is a manifest and holds no logic:

```ts
export class IdentityService extends ServiceModule {
    public readonly domain = 'identity';

    constructor() {
        super();
        this.mountTool(tokenIssueContract, identity_token_issue);
        this.mountTool(tokenVerifyContract, identity_token_verify);
        this.mountCrud(userCrud);
        this.mountCrud(membershipCrud);
    }
}
export default IdentityService;
```

`ServiceModule` in mesh v2 provides `mountTool`, `mountCrud`, `mountTimeSeries`, `mountCrudHook` and
`mountEventHandler`. All of it is current; none of this needs new framework.

### Why this shape holds up — **Proposed**

Worth stating, because "a class" is not the interesting part and the interesting parts are what to
preserve if any of it is ever rearranged:

- **The contract is separate from the implementation.** A contract file can be read, exposed and
  code-generated from without loading a line of handler code. That is what lets the API know what
  exists without running it.
- **One action per file, named `<domain>_<action>`.** The name is greppable, the file is testable
  alone, and a diff touching one action touches one file.
- **The service class is a list.** Reading it tells you everything the domain answers, in one screen,
  with no logic in the way. A constructor that starts doing work is the smell to watch for.
- **Schemas live apart from contracts.** Which is the rule surfdns states more strictly — every input
  and output is a named schema and contract files hold no `z.` literals — and that stricter version
  should win where the two differ.

---

## 2. The three modules — **Proposed**

Domains and collections sketched, not settled. What is settled is that each is a ServiceModule in
the layout above.

**mesh-identity** — `identity`

CRUD: `user`, `organization`, `membership`, `team`, `role`, `grant`, `apiToken`, `ticket`.
Tools: `user_create`, `org_create`, `member_invite`, `member_remove`, `team_create`, `role_create`,
`grant_set`, `token_issue`, `token_revoke`, `ticket_issue`, `ticket_validate`, `ticket_revoke`,
`passkey_register`, `passkey_challenge`.
Events: `identity.ticket_revoked`, `identity.principal_suspended`, `identity.grant_changed` — the
revocation fan-out [authentication](./auth.md) §3 depends on.

**mesh-web** — `web`

CRUD: `site` (the hostname → application mapping), `build`, `artifact`.
Tools: `site_resolve`, `build_start`, `build_status`, `artifact_get`.
Events: `web.build_started`, `web.build_completed`, `web.build_failed`, `web.site_changed`.

`site_resolve` is the one every CDN node calls, and `site` is the shared mutable state
[hosting](./hosting.md) §7 flags as the design's most likely bottleneck. Making it an ordinary CRUD
collection on the mesh is the answer that avoids building a second distributed system beside the one
already running.

**mesh-api** — `api`

Least obviously a service module, because its real job is being an HTTP server rather than answering
mesh calls. It still has state worth modelling: which contracts are exposed, to which roles, on
which routes.

CRUD: `exposure` (contract → roles → route).
Tools: `api_routes` (what this instance serves), `api_status`.

**Open:** whether exposure is a CRUD collection the API reads, or comes from each site's deployment
descriptor ([hosting](./hosting.md) §5), or both with the descriptor as the source and the
collection as the resolved cache. The descriptor is where the site team owns it, which argues for
that being the source.

---

## 3. The tension with per-unit assignment — **Open**

Flagged because it is a real conflict and quietly picking a side would be wrong.

surfdns's runtime deliberately moved *away* from ServiceModule classes to plain unit records. The
reasoning, from its own plan: a class is "a class whose methods cannot be placed, cannot be assigned,
and cannot be reasoned about individually" — and surfdns's whole placement model depends on units
being individually addressable. A node is told to run `resolver.query` and not `resolver.await_resolution`,
and `Catalog` holds units, not modules.

Adopting the paas layout for these three is compatible with that, but only if one of these is true:

1. **A module can mount a subset of its tools**, chosen at construction from the assignment. The
   class stays a manifest; what it mounts depends on what this node was told to run.
2. **Assignment moves to module granularity** for these three, and per-unit assignment stays for
   surfdns's own domains. Simpler, and it means a node runs all of `identity` or none of it — which
   is probably fine for identity and probably not for a CDN.
3. **Per-unit assignment is dropped.** Not proposed; it is the reason surfdns's runtime exists.

The first is the least disruptive and is a small change to how the class is written — the constructor
takes what to mount instead of assuming everything. Worth deciding before the first module is
written, because it decides the constructor signature of all three.

---

## 4. What the three processes actually look like — **Proposed**

The module layout above says how the code is arranged. This says what runs.

### The common shape

Every one of them is a node process that does the same four things:

1. `new MeshApp` → `use(RegistryModule)` → `use(DatabaseModule)` → `use(BrokerModule)`
2. `await app.start()`
3. **register its ServiceModule — after `start()`, never before.** `MeshApp`'s pending-module flush
   is unawaited, so registering first is a race that usually works.
4. optionally bind an HTTP listener

Step 4 is the only real difference between them, and it is a bigger difference than it looks.

### mesh-identity — no listener at all

**Binds nothing. Faces nothing.** It is a pure mesh node answering `identity.*` contracts.

This is the point, not an omission: **nothing outside the cluster can reach identity directly.** The
browser talks to mesh-api; mesh-api makes a mesh call. There is no port to expose by accident, no
route to forget to protect, and the "no internal bypass, no god token" rule
([auth §5](./auth.md)) has one fewer place to be violated.

Holds: users, organizations, memberships, teams, roles, grants, API tokens, tickets. Emits
`identity.ticket_revoked`, `identity.principal_suspended`, `identity.grant_changed` — the fan-out
everything else's cache invalidation depends on.

The awkward part is the beginning. Identity must exist before anything can authenticate, including
the nodes themselves, which is the node-credential bootstrapping problem already visible as
surfdns #35 (`node.status` public, leaking `bootstrapCredential`). Not solved here.

### mesh-api — a listener, and a cache

**Binds a port.** Plain HTTP, no TLS, behind the surfdns proxy ([hosting §1](./hosting.md)).

Turns exposed contracts into REST, SSE and WebSockets. Per request it is stateless; across requests
it holds exactly two things:

- **the exposure map** — which contracts are exposed, to which roles, on which routes
- **the ticket cache** — validate on first sight, cache, invalidate by event
  ([auth §3](./auth.md)). One mesh call per (ticket, instance), not per request.

Plus live SSE and WebSocket connections, which is the only reason an instance is not entirely
interchangeable mid-connection. Nothing may assume sticky routing
([hosting §4](./hosting.md)), so a dropped connection reconnects anywhere and re-subscribes.

### mesh-web — one module, two processes

This is the one that does not fit the pattern, and it is worth being precise rather than tidy.

The `web` domain covers **the CDN** and **the builder**, and they are not the same kind of process:

| | CDN node | builder node |
| --- | --- | --- |
| binds | a port, behind the proxy | nothing |
| triggered by | HTTP requests | mesh calls and events |
| profile | small, stateless, many, everywhere | large, few, CPU and IO heavy |
| mounts | `site_resolve`, `artifact_get` | `build_start`, `build_status` |
| scaling | with traffic | with pushes |

Running a builder inside every CDN node would put a build's memory and CPU next to page serving, and
running one CDN because builds are expensive would defeat the point of ten of them.

**So one ServiceModule, two assignments.** Which is the concrete case for §3's open question — and
it argues for the first option, "a module can mount a subset of its tools, chosen at construction
from the assignment." A CDN node constructs the `web` module with the serving tools; a builder node
constructs it with the build tools. Same contracts, same code, different mount list.

That is no longer an abstract preference. **It is what mesh-web needs to be deployable at all**, and
it decides the constructor signature of all three modules.

### The whole picture

```
browser ──HTTP──▶ surfdns proxy ──▶ mesh-api  :port A   typed calls, SSE, WS
                              └──▶ mesh-web   :port W   html, js, assets  (CDN nodes)

                        mesh-api ──mesh──▶ identity.ticket_validate
                                 ──mesh──▶ whichever domain owns the contract
                    mesh-web CDN ──mesh──▶ web.site_resolve
                    mesh-identity          no listener
                  mesh-web builder         no listener
```

Two ports, as decided early: **the API and the web interface are never on the same one.** Neither
terminates TLS; both are containers behind the proxy.

---

## 5. Open

- **§3, the assignment granularity question.** Decides the constructor signature.
- **Whether `mesh-api`'s exposure is a collection or the deployment descriptor.** §2.
- **Where the three modules' code lives** — three repositories or one
  ([authentication](./auth.md) §2). Does not change this layout either way.
- **Whether mesh-web's server half lives in this repository.** [hosting](./hosting.md) §1 says the
  browser half and the server half are peers that never import each other's internals. A
  ServiceModule for `web` is squarely the server half, and this repository currently has a
  `tsconfig.json` that sets `types: []` specifically to make node imports a compile error.
