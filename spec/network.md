# The network layer

> "cred has full types and the 'network' needs to be the same. the network layer is what links the
> mesh and the ui."

**Status.** **Decided:** the browser's network calls are as fully typed as `ctx.call` is inside the
mesh. **Proposed:** how, which is where it stops being a copy of what mesh does.

Companions: [hosting](./hosting.md) · [Applications](./application.md) · [the kernel](./kernel.md) ·
[authentication](./auth.md) · [service modules](./service-modules.md).

---

## 1. The requirement — **Decided**

Inside the mesh this already works:

```ts
const cred = await ctx.call('credential.resolve', { id: input.credentialId });
// cred: { status: 'pending' | 'validating' | 'active' | ...; kind: 'tls'; spec: {...}; ... }
```

The action is a string; the input is checked against that action's schema; the result is the full
output type with every union member and optional field intact. No generic parameter, no cast, no
`unknown`.

**The browser gets the same.** Not "similar", not "typed at the edges" — the same. A view rendering
a certificate's `status` gets the six literal values, and a typo in the action name is a compile
error.

---

## 2. But the browser is not on the mesh — **Decided**

The constraint that shapes everything below, and it is already settled:

> **The browser never joins the mesh.** It speaks HTTP to a node's API.

So this is not `ctx.call`. It is an HTTP request to mesh-api, which is the gatekeeper
([auth §5](./auth.md)), and **it can only reach what this site exposes**
([hosting §5](./hosting.md)). The typing has to survive that hop *and* respect that boundary.

That second half is the interesting part, and it is where copying mesh's approach would go wrong.

---

## 3. How mesh does it, and what does not transfer

mesh's generator emits `src/generated/api.ts`:

```ts
declare global {
    interface IServiceToolRegistry {
        'demo.hello': {
            params:  z.input<typeof Contract_0.demoHelloContract['inputSchema']>,
            returns: z.infer<typeof Contract_0.demoHelloContract['outputSchema']>
        };
        // …
    }
}
```

It works, and inside a mesh process it is the right design. Three properties do not survive the trip
to a browser.

### 3.1 `z.infer` across a package boundary is fragile — **Decided**

Those types are not types; they are *references* that TypeScript must resolve through `typeof` into
another package's zod. If the browser bundle ends up with a second copy or a different version of
zod, `z.infer` resolves against a different declaration and quietly yields `unknown`.

This is not hypothetical. It is **surfdns #15** — "generated client degrades to `unknown` when zod is
duplicated" — already observed, and mesh-api already has a commit for a neighbouring symptom
("Take z from `@flybyme/mesh/contracts`, not from zod").

A browser is exactly where this bites: an import map, several packages, and a site that may not
control every dependency's zod range.

> **The generated browser types are structural TypeScript, not zod references.** The generator
> resolves the schema and emits the finished type. Nothing at the call site imports zod, and there is
> no version of the dependency graph in which the types silently degrade.

The cost is a larger generated file and a generator that must render every zod construct correctly.
That is a generator bug when it happens — visible, fixable, and in one place — rather than an
environment-dependent collapse to `unknown` that looks like nobody's fault.

### 3.2 `declare global` is wrong here — **Decided**

Correct inside mesh, because mesh contracts genuinely are a global namespace: there is exactly one
`credential.resolve` in a cluster, and [Extensions §2](./extension.md) already records that "a
contract is a global declaration" is the actual mesh model.

A browser page is not that. mesh-web is explicitly **many sites, many authors**
([hosting §3](./hosting.md)), and a global interface is a namespace two independently-built things
can collide in, with whichever augmentation loaded last winning silently.

This is the same reasoning that rejected module augmentation for provider tokens
([Extensions §4](./extension.md)) — and the two conclusions are consistent rather than contradictory,
because the test is whether the namespace is *genuinely* global. Mesh contracts are. Provider ids
and site APIs are not.

### 3.3 Typing the whole contract set is worse than typing none — **Decided**

mesh's registry lists every contract in the process. A browser that inherited it would autocomplete
hundreds of actions the site does not expose, every one of which compiles and then fails at run time
with a 403.

**Autocomplete that offers you things you are not allowed to call is worse than no autocomplete**,
because it moves a compile-time error to a production one.

> **The browser's typed surface is generated from the site's exposure descriptor, not from the mesh's
> contract set.** What a site exposes is what an Application can call, and calling anything else does
> not compile.

That is the exposure list [hosting §5](./hosting.md) already puts in the site's own repo, owned by
the site's own team. It now has a second job: it is the type boundary.

---

## 4. The shape — **Proposed**

The API a site talks to is **declared in the manifest**, like everything else the kernel needs before
an Application runs ([Applications §2](./application.md)):

```ts
import { surfdnsApi } from '@surfdns/console-api';   // generated from the exposure descriptor

export default class ConsoleApp implements Application<...> {
    readonly needs = NEEDS;
    readonly api   = surfdnsApi;          // ← part of the manifest

    async start(cx: Context<typeof NEEDS, typeof CONSUMES, typeof surfdnsApi>) {
        const cred = await cx.net.call('credential.resolve', { id });
        //    ^ fully typed, exactly as ctx.call is inside the mesh
    }
}
```

The ergonomics are identical to `ctx.call` — a string action, inferred input, inferred output — and
the namespace is scoped to the API this Application declared rather than to the page. An Application
talking to two APIs declares two, and neither can shadow the other.

Declaring it in the manifest earns the usual benefits: the kernel knows which APIs a site's
Applications will contact before any of them runs, which is exactly the list a review, a CSP, or an
audit wants.

---

### This is not how an Application talks to an Extension — **Decided**

Two boundaries that look superficially alike and are nothing like each other. They should not read
the same, and they do not.

```ts
// → the API. Over the network. Gatekept. Can 403. Typed from the site's exposure.
const cred = await cx.net.call('credential.resolve', { id });

// → the auth Extension. In the page. Typed by a contract package both sides import.
const auth = cx.use(AUTH);
```

| | `cx.net.call` | `cx.use` |
| --- | --- | --- |
| declared as | `api` in the manifest | `consumes` |
| crosses | the network | a contribution boundary |
| owned by | the site's exposure descriptor | a contract package ([Extensions §4](./extension.md)) |
| fails with | 401, 403, 404, transport | a missing provider, at boot |
| gatekept by | mesh-api | nothing — it is in the page |

The last row is the one to keep straight. `cx.use` reaches something already running in the page and
enforces nothing; **the API is still the only security boundary** ([kernel §4](./kernel.md)). An
Extension is not a way to get privileged data — it is a way to share what the page already legitimately
has.

**And the console mostly does not call auth at all.** It does not fetch a ticket and attach it: the
auth Extension attaches it to `net` for every caller, so an Application never handles a credential.
What is left is small — read `session` to render who is signed in, `signIn`/`signOut` from a command,
and an effect that reacts when the session goes null.

---

## 5. The same treatment for the rest of the link — **Proposed**

"The network layer is what links the mesh and the ui" is three things, not one, and all three come
from the same generated descriptor:

**Calls.** §4.

**Events.** SSE and WebSocket subscriptions typed from event contracts:

```ts
cx.events.on('identity.ticket_revoked', (payload) => { /* payload typed */ });
```

Unknown event name → compile error. This matters more than calls, because a subscription with a
mistyped payload fails silently rather than throwing.

**Collections.** CRUD contracts are already generated as `create`/`find`/`get`/`update`/`delete` sets
— mesh's own generated file shows them. The `models` capability exposes them as typed reactive
collections, so a table binds to a query and re-renders on a `web.site_changed` event without
anybody writing a fetch.

One generator, three surfaces, one descriptor.

---

### 5.1 Scoping an event is a different problem from scoping a call — **Decided**

Found while building mesh-api's SSE support, 2026-09-03, and it is the sharpest thing in this
document because the previous implementation got it wrong in a way that fails **open**.

**A call is scoped by a query filter.** mesh confines a request in `beforeCrud`, using
`meta.user.tenant_id` — the scope the gate resolved from the caller's memberships. The database never
sees the other organizations' rows. That works because a request has one caller and one scope, both
known before the query runs.

**An event has neither.** It is emitted once, to the whole mesh, by whatever caused it — a request, a
daemon, a timer. It arrives at an API instance holding connections for many users in many
organizations, and the instance must decide, per subscriber, whether this event is theirs. There is
no query to filter, and the mesh does not carry the answer: a CRUD event payload is
`{ domain, id, item }`, and nothing in it is *declared* to be a scope.

`archive/pre-rewrite` guessed. `extractEventScope` searched the payload, then one level of nested
objects, then packet meta, for any of `orgId`, `tenantId`, `tenant_id`, `organizationId` or `scope`.
Then:

```js
if (isScoped && eventScope !== undefined && !sub.isOperator && eventScope !== sub.effectiveScope)
    continue;   // ← skipped only when a scope was found
```

**When the guess failed, `eventScope` was `undefined` and the event went to every subscriber.** An
event declared `scope: 'org'` whose payload happened to name its organization field something else —
`org`, `ownerOrg`, nested two deep, or an arbitrary `item` from a generic `data.created` — fanned out
to every connected browser in every organization. The replay path on reconnect had the same check and
the same hole.

That is a cross-tenant disclosure, arrived at by a name-guess, failing open.

**So, decided:**

1. **An event that cannot be scoped is not delivered.** Fail closed, always. The absence of a scope
   is not evidence that the event is global.
2. **Scope is declared, never inferred.** An exposed event names the path to its scope
   (`scope: { field: 'organizationId' }`) or declares itself unscoped (`scope: 'global'`), and
   `global` is a decision someone typed. There is no fallback that searches for likely field names —
   that is the same mistake as extracting `requestedScope` from four caller-controlled keys across
   three locations, except that the consequence is disclosure rather than confusion.
3. **A declared field missing at run time is an error, not a broadcast.** It means the contract and
   the payload disagree, and the safe reading of a disagreement is to deliver to nobody and say so
   loudly.
4. **The subscriber's scope comes from the gate**, exactly as a call's does — resolved from
   memberships at subscribe time, never from a query parameter.
5. **A revoked ticket closes the stream.** A subscription outlives the request that opened it, so
   authorization has to be re-checked rather than assumed for the life of the connection. The ticket
   cache already learns about revocation by event ([auth §3](./auth.md)); a stream holding a revoked
   ticket is dropped rather than left running.

**Replay is bounded by what one instance saw.** `Last-Event-ID` can only be honoured against that
instance's own buffer, and [hosting §4](./hosting.md) forbids assuming sticky routing — so a
reconnect landing elsewhere gets no replay. The honest answer is that the buffer is a
convenience, not a delivery guarantee: a client that must not miss an event has to reconcile by
calling, not by replaying. Stated here so nothing is built on the assumption that it can.

---

## 6. A stale client is a lie — **Proposed**

The generated types assert what the API accepts. If the API changed and the client did not, the
compiler now vouches for something false, which is worse than the untyped case where a developer
would at least be suspicious.

So: the descriptor carries a hash of the exposure it was generated from; CI regenerates and fails on
a diff; and the API reports its exposure hash so a deployed client can be checked against a running
server rather than against a file in a repo. That last one is what catches the case CI cannot — a
client deployed against an API that has since moved on.

**Which environment's exposure?** A site declares several ([hosting §5](./hosting.md)) and they need
not expose identically. Generating against production and letting development add to it is probably
right; it is not decided, and it is §8.

---

## 7. What this settles elsewhere

- **surfdns #15** stops being a mystery and becomes a design rule: emit structural types, never zod
  references across a boundary.
- **The surfdns-console schema boundary** ([roadmap D.1](./roadmap.md)) is answered. The three
  options were: declare shapes locally, publish a schema package, or generate a typed client. It is
  the third, and the four symbols the console currently imports from surfdns
  (`WhoamiOutputSchema`, `MembersOutputSchema`, `NodeStatusOutputSchema`, `roleSatisfies`) come from
  the generated descriptor instead.
- **mesh-api's `generate-client`** ([roadmap C3.8](./roadmap.md)) moves from a nice-to-have to the
  thing the whole browser type story rests on.
- **The exposure descriptor** gains a second job, and that argument won:
  [service-modules §2](./service-modules.md) now **decides** the site's repo is the source and the
  API's `exposure` collection is a resolved cache. So the generator reads a file in the site's
  repository, needs no running cluster, and the generated client is a build artifact rather than
  something fetched at deploy time.

---

## 8. Open

- **Which environment's exposure the types are generated from**, per §6.
- **Whether roles narrow the types.** Exposure records which roles may call what
  ([auth §5](./auth.md)). Typing an admin-only action as unavailable to a public build is possible
  and might be over-clever, since roles are runtime facts about a *user* and types are build-time
  facts about a *bundle*.
- **How large the generated file gets** for a real site, once types are structural rather than
  references. Probably fine; nobody has measured, and it is the kind of thing that is only a problem
  after it is a problem.
- ~~**Errors.**~~ **Decided** in [type-safety §5](./type-safety.md): a call returns a result that
  names its failures, and `r.value` is only reachable after checking `r.ok`. A `Promise<T>` that can
  fail five ways is not typed. Every call site handles it explicitly, which is more than ten lines
  across a codebase and is exactly the trade that was accepted.
- ~~**Whether `net` should expose anything untyped at all.**~~ **Decided** in
  [type-safety §7](./type-safety.md): exactly one escape hatch, on a separate surface, returning
  `unknown`, requiring explicit parsing, and declared as a capability so reaching for it is visible
  in the manifest. `get<T>` and `post<T>` are deleted rather than deprecated —
  [type-safety §2](./type-safety.md) is why.
