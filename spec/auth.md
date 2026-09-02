# Authentication: tickets, validation, and the API as gatekeeper

> "I do what some ticket issuing service and the API be the ticket validation step"
> "tickets can be revoked through the event system. every API on the first time seeing the ticket
> makes a mesh call to validate it."
> "the browser has some kind of passkey or something like that and it identifys a person"
> "I would like the API to be the gatekeeper for the underlying mesh. some contracts are public some
> require user x and some by an admin."

**Status.** Design. **Decided** is settled. **Proposed** is mine. **Open** is not answered.

Companions: [the model](./README.md) · [storage and the registry](./storage-and-registry.md) ·
[hosting](./hosting.md).

This answers what [hosting](./hosting.md) §4 left open: how a credential resolves on an API instance
that did not issue it, when there are ten of them.

---

## 1. Not Kerberos — **Decided**

Kerberos is a KDC split into an Authentication Server issuing ticket-granting tickets and a
Ticket-Granting Server issuing service tickets. An earlier draft of this document proposed copying
that shape. **It is not what is wanted**, and the two pieces actually wanted are simpler:

- **a ticket issuing service**
- **the API as the ticket validation step**

The parts of Kerberos being dropped are the TGT/TGS indirection and offline signature verification.
What replaces the second is better (§3), and dropping the first removes a whole tier.

---

## 2. Three components — **Decided**

> "there should be 3 repos mesh-api mesh-web and mesh-identity but they should also just be the same
> repo but that's what ever"

| | owns |
| --- | --- |
| **mesh-identity** | people, passkeys, keys, API keys, tickets. **The only thing that issues.** |
| **mesh-api** | the gatekeeper to the mesh. Validates tickets, enforces per-contract auth. |
| **mesh-web** | the browser framework, the builder, the CDN. |

Whether these are three repositories or one is left open by the requirement and does not change the
design — the boundary that matters is that **only mesh-identity issues**, and a single repository
can hold that boundary as well as three can. Three makes it visible; one makes it easier to move.

Issuance stays central even though everything else distributes. Ten instances able to mint
credentials is ten times the blast radius for no gain: verification is what needs to be near the
user, and verification is what §3 distributes.

---

## 3. Validate on first sight, cache, invalidate by event — **Decided**

> "every API on the first time seeing the ticket makes a mesh call to validate it"
> "tickets can be revoked through the event system"

An API instance seeing a ticket it does not recognise asks mesh-identity over the mesh: is this
valid, and who is it? It caches the answer. Every later request carrying that ticket is a cache hit.
When a ticket is revoked, mesh-identity **emits an event** and every instance drops it.

```
first request at instance N   →  mesh call to mesh-identity  →  cache
later requests at instance N  →  cache hit, no call
revocation anywhere           →  event on the mesh  →  every instance drops it
```

The cost is one mesh call per (ticket, instance) pair, not per request. Ten instances mean a
frequently-used ticket is validated at most ten times in its life.

### Why this is better than what it replaced — **Proposed**

The previous draft proposed signed tickets verified offline, and accepted "revocation is bounded by
ticket lifetime rather than instant" as the price. This design does not pay that price:

- **Revocation is event-driven, so it is near-immediate** rather than bounded by expiry. That
  preserves the property surfdns chose server-side sessions for in the first place — *logout, expiry
  and forced revocation are real rather than advisory* — without a shared read in the hot path.
- **Tickets can be opaque random strings.** Nothing verifies them by signature, so **there is no
  signing key**, and therefore no key to distribute to ten instances and no key rotation. That was
  the largest open item in the previous draft and it disappears rather than being solved.
- **The mesh is already the event bus.** Revocation fan-out is not new machinery.

### What has to be got right — **Proposed**

The cache is correctness-critical, so its failure modes need naming rather than discovering:

- **A missed event serves a revoked ticket.** An instance that was down, partitioned, or resubscribed
  late will not have seen the revocation. So a cache entry needs a **TTL as a safety net** — short
  enough to bound the damage, long enough that it is not the primary mechanism. The event is the
  mechanism; the TTL is the backstop.
- **Subscription must be durable enough to survive a reconnect.** A restarting instance should
  re-validate rather than resume with a warm cache it cannot vouch for, or reconcile before serving.
- **Negative results need caching too**, or an invalid ticket presented in a loop is a mesh call per
  request — which is a denial-of-service against mesh-identity written by the attacker.
- **A cache entry must not outlive the ticket**, independent of the TTL.

---

## 4. What identifies a person — **Decided**

> "we are 2026. the browser has some kind of passkey or something like that and it identifys a
> person."

A **passkey**. The private key never leaves the authenticator; the browser signs a challenge and
mesh-identity issues a ticket. There is no password to store, phish or rotate, and — the point for
this design — **the browser never holds a long-lived credential.** It holds a ticket, and the durable
thing lives in hardware.

That closes the open question about whether a browser holds a grant. It does not. The question only
existed because the previous draft needed somewhere durable to put one.

paas already models this. `PasskeySchema` stores `credentialId` and `publicKey`, described as
*"WebAuthn public keys -- public, not secret; verified via credential.verify"*, and the credential
service's `subjectType` already spans `platform | org | node | service | cluster | user` — so a node
or a service authenticating with a key pair is the same mechanism with a different subject, not a
second system.

### API keys are fine, because they are revocable — **Decided**

> "a user holding an API key is fine because you can tell the API that key is no good"

Revocability is the whole argument, and §3 is what delivers it: telling the API a key is no good is
an event, and it lands everywhere. A credential you cannot withdraw is the thing to avoid; a
long-lived one you can withdraw immediately is fine.

This is also why the design tolerates long-lived API keys and short-lived tickets side by side. They
differ in exposure, not in how they are stopped.

---

## 5. The API is the gatekeeper — **Decided**

> "I would like the API to be the gatekeeper for the underlying mesh. some contracts are public some
> require user x and some by an admin."

Every contract reaching the mesh from outside passes the API, and the API decides. Three levels,
which is what surfdns's exposure policy already has:

| level | meaning |
| --- | --- |
| `public` | no ticket. Registration, a blog's read path, health. |
| `user` | a valid ticket resolving to a person or a key holder. |
| `admin` | an operator. |

Two rules that already exist and are restated because this document is where someone would look for
an exception:

- **There is no bypass.** No trusted-internal-caller path by IP, network origin or shared-secret
  header. A CDN node calling over the mesh ([hosting](./hosting.md) §1) authenticates as itself and
  gets a shorter path, not more authority.
- **No god token.** `admin` is a level, not a key that opens everything.

The unresolved part is what `admin` means: surfdns issue #26 records that `roleSatisfies('admin')`
is organization-scoped while `auth: 'admin'` is cluster-scoped, and nothing connects them — so today
nobody can actually be a platform operator. That gap is upstream of this document and blocks the
third row of the table above.

---

## 6. What to carry from the paas identity service — **Proposed**

Read on request. Four decisions there are better than what surfdns currently has.

**A token derefs to its issuer's current permissions.** `ApiToken` stores `issuedByUserId` and no
grant of its own — *"the token's permissions are the issuer's effective permissions at call time,
never its own grant"*. Suspend the user and every token they ever issued dies, with no enumeration
and no cascade. The single best idea in that service, and it composes with §3: the revocation event
is on the *principal*, and every ticket deriving from them drops.

**Scope narrows and never widens.** `ApiTokenScope` is a *"narrowing ceiling only ... never
exceeding"*. A ticket may be weaker than its issuer, never stronger.

**Authentication is separate from authorization.** `token_verify` returns coarse identity — kind,
org, principal, scope — and leaves fine-grained checks to each service. Merging them is how a
validation endpoint becomes a policy engine nobody can reason about.

**The hash is stored for lookup; the raw value is returned once.** `tokenHash` sits on the record so
validation is a direct lookup rather than a scan over vaulted secrets, and private material lives in
a separate collection from public.

---

## 7. What this changes here — **Proposed**

- **[hosting](./hosting.md) §4 is answered.** Not by any of the three options listed there: validate
  on first sight and invalidate by event is a fourth, and better than all of them for this topology.
- **The `net` capability carries a ticket**, not a cookie. Cookies do not survive the cross-origin
  arrangement in [hosting](./hosting.md), and a ticket is what a revocable credential looks like on
  the wire.
- **The auth Extension owns the passkey flow** — challenge, signature, ticket, renewal — and holds
  nothing durable.
- **mesh-api needs an event subscription it does not have**, plus a validation cache. This is the
  concrete new work in that repo.

---

## 8. Open

- **Ticket lifetime and cache TTL.** Two numbers. The TTL is a backstop for missed events (§3) and
  should be short; the ticket lifetime governs how often a passkey challenge is repeated, and that
  is a usability decision.
- **Delivery guarantees on the revocation event.** At-least-once and ordered, or reconciliation on
  reconnect. §3 depends on this and the mesh's guarantees need checking rather than assuming.
- **Where the validation cache lives** — per instance in memory, or shared. Per-instance is simpler
  and is what §3 assumes; shared would cut the first-sight calls but reintroduces shared state.
- **What `admin` means.** surfdns issue #26. Blocks §5.
- **Bootstrapping a node's own credential.** How a CDN or API node gets the key it authenticates
  with. surfdns's `bootstrapCredential` is the same problem already visible, and it is currently
  reported to anonymous callers — surfdns issue #35.
- **Three repos or one.** Left open by the requirement; does not change the design.
