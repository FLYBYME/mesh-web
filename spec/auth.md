# Authentication across many regions

> "the cdn can back channel through the mesh to the API"
> "one auth extension is right and I think ether cdn or API controls it"
> "some kind of trusted certification or token service is needed and like kerbroth I think it's
> called"
> "some client might not have to log in just because they are using private public key system"

**Status.** Design. **Decided** is settled. **Proposed** is mine. **Open** is not answered.

Companions: [the model](./README.md) · [storage and the registry](./storage-and-registry.md) ·
[hosting](./hosting.md).

This answers the question [hosting](./hosting.md) §4 left open: how a session resolves on an API
instance that did not issue it, when there are ten of them.

---

## 1. The CDN back-channels over the mesh — **Decided**

A CDN node is a mesh node. When it needs something from the API — validate a ticket, resolve a
hostname to a site, fetch an artifact record — it **asks over the mesh**, not over HTTP.

This is not a hole in "the API is the only way into the cluster". That rule is about callers from
outside. A CDN node is not outside; it is a node, with a node's identity, running platform code. The
rule it must not break is the other one: **no privileged back door for first-party callers** — no IP
allowlist, no shared secret header, no god token. A CDN node authenticates as itself, holds its own
credential, and is authorized like anything else. What it gets is a shorter path, not more authority.

What this buys:

- **No public verification endpoint.** Ticket validation is a mesh call, so nothing has to be
  exposed to the internet to make the CDN work.
- **No HTTP hop in the hot path**, and no second protocol to secure, rate-limit and monitor.
- **The mesh already routes it.** Any CDN node can reach any API instance because both are on the
  network. This is the same answer as everything else in [hosting](./hosting.md) §2 and §4, which is
  the point — one distributed system, not several.

---

## 2. Who controls auth — **Decided**

> "I think ether cdn or API controls it"

It is the **API**, and the split is clean:

| | |
| --- | --- |
| **API** issues | It owns identity, users, organizations and credentials. It is the authority. |
| **CDN** verifies | It accepts what the API issued, checking over the mesh (§1). It is never the authority. |

The CDN holding issuing authority would mean ten CDN nodes each able to mint credentials, which is
ten times the blast radius for no gain. Verification distributes; issuance should not.

The auth Extension in the browser is the third piece and is unchanged: it owns the *flow* — sign-in
screens, renewal, storing what it was given — for the one site it runs on. It is not an authority
either.

---

## 3. Kerberos, and why it is the right shape here — **Proposed**

The problem [hosting](./hosting.md) §4 raised: server-side session records are revocable, which is
why surfdns chose them on purpose, but with ten regions they cost a shared read on every
authenticated request. Signed tokens avoid the read and make revocation advisory, which is the thing
that was rejected.

Kerberos resolves that tension by **splitting the credential in two**, and that is what makes it
worth copying rather than the specific protocol:

| | long-lived | short-lived |
| --- | --- | --- |
| Kerberos | ticket-granting ticket | service ticket |
| here | **grant** | **ticket** |
| presented | rarely — to get tickets | on every request |
| lifetime | hours to days | minutes |
| verified by | a shared read, and it can afford one | signature alone, no read |
| scoped to | the principal | **one named service** |

The hot path is verified by signature with no lookup — so ten regions cost nothing extra. The shared
read moves to the rare path, where a cross-region hop is fine. And revocation is bounded rather than
advisory: revoking a grant stops new tickets immediately, and existing tickets expire in minutes.

**Bounded is not instant, and that is a real trade.** It should be chosen deliberately, with the
ticket lifetime as the dial: shorter means faster revocation and more traffic on the rare path. For
anything that must die *now* — a compromised credential — the grant is revoked and a revocation list
covers the remaining ticket lifetime. That list is small precisely because tickets are short.

### Tickets are scoped to a service — **Proposed**

The property that a bearer session does not have. A ticket is issued *for* something: a site's API,
the CDN, a contract domain. A ticket presented to the wrong service is refused even though it is
perfectly valid.

This matters immediately here. A CDN node handling a request holds a ticket good for the CDN and
nothing else, so a node that is compromised cannot turn its visitors' credentials into API access.
Under a shared bearer session it could.

---

## 4. Clients that never log in — **Decided**

> "some client might not have to log in just because they are using private public key system"

Authentication is **proof of possession of a key**, and a password is one way to get there, not the
only one. A client holding a private key proves it by signing a challenge and receives a grant. No
password, no interactive login, no session to establish.

This is one mechanism covering two cases that are usually built twice:

- **A person with a passkey.** WebAuthn: the private key stays in the authenticator, the public key
  is registered, the browser signs a challenge.
- **A machine with a key pair.** A CDN node, a service, another cluster. It signs on startup, gets a
  grant, and renews on its own.

paas already models both. `PasskeySchema` stores `credentialId` and `publicKey`, described as
*"WebAuthn public keys -- public, not secret; verified via credential.verify"*, and the credential
service's `subjectType` is already `platform | org | node | service | cluster | user`. A node
authenticating with a key is not a new concept there; it is an existing one with a different
subject.

---

## 5. What to carry from the paas identity service — **Proposed**

Read at your suggestion. Four decisions in it are better than what surfdns currently has, and should
be carried rather than rediscovered.

### A token derefs to its issuer's *current* permissions

> "token's permissions are the issuer's effective permissions at call time, never its own grant"

An `ApiToken` stores `issuedByUserId` and no grant of its own. Suspend the user and every token they
ever issued dies with them, with no enumeration and no cascade. This is the single best idea in that
service, and it applies unchanged to grants and tickets here.

### Scope narrows and never widens

`ApiTokenScope` is documented as *"narrowing ceiling only ... never exceeding them"*. Attenuation
only: a token may be weaker than its issuer, never stronger. That is what makes it safe to hand one
out, and it is what a scoped ticket (§3) needs to mean.

### Authentication is separate from authorization

`token_verify` returns coarse identity — kind, org, principal, scope — and explicitly leaves
fine-grained checks to each service. Resolving *who you are* and deciding *what you may do* are
different questions asked at different places, and merging them is how a verification endpoint
slowly becomes a policy engine nobody can reason about.

### The hash is stored for lookup; the raw value is returned once

`tokenHash` sits on the record so verification is a direct lookup rather than a scan over vaulted
secrets, with the reasoning written down: the hash of a 256-bit random token is not reversible, so a
queryable hash column is the standard pattern. Private material lives in a separate collection from
public material.

---

## 6. What this changes here — **Proposed**

- **[hosting](./hosting.md) §4's three options resolve to the third.** "Signed token plus a
  revocation list" was the pragmatic middle that needed designing; §3 is that design. Recorded so
  nobody re-opens it as if it were still a three-way choice.
- **The `net` capability carries a ticket, not a cookie.** Same-site cookies do not survive the
  cross-origin arrangement in [hosting](./hosting.md), and a ticket is what a scoped credential
  looks like on the wire.
- **A ticket needs renewal in the background.** Minutes-long tickets mean the auth Extension renews
  silently, and a renewal failure has to surface as a real state rather than a stream of 401s.
- **The credential service is nearly the right shape already.** `CredentialKindRegistry` is
  extensible and currently holds only `tls`; a grant and a ticket are further kinds, with the
  lifecycle fields — `status`, `issuedAt`, `expiresAt`, `renewAfter` — already present.

---

## 7. Open

- **Ticket lifetime.** The dial between revocation latency and rare-path traffic. Needs a number,
  and the number is a product decision rather than a technical one.
- **What signs tickets, and how the signing key is distributed and rotated.** Ten API instances that
  can all issue need the key, and a key in ten places is a key with ten chances to leak. Whether
  issuance is genuinely distributed or centralised with distributed *verification* is the real
  question, and §2 leans toward the latter without settling it.
- **Where grants are stored**, given that a grant lookup is the rare-path shared read. Probably the
  same answer as sessions were going to have, and probably the mesh.
- **Whether a browser holds a grant at all**, or only ever tickets with a renewal path through the
  auth Extension. Holding a long-lived grant in a browser is the thing that a stolen-token attack
  wants most.
- **How a CDN node gets its own credential in the first place.** Bootstrapping. surfdns's
  `bootstrapCredential` is the same problem already visible on nodes, and it is currently reported
  publicly — see surfdns issue #35.
