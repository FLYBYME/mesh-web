# Server-side rendering — the decision, not the task

Written 2026-09-06. **This is a decision document, deliberately not a dispatch prompt.** Every option
below is defensible, they differ in what they cost, and one of them moves an M4 item into the
blocking path. An agent should not pick for us.

Destination when a slot frees: `mesh-web/spec/prerender.md`, linked from `hosting.md`.

---

## The hole

`mesh-serve/src/cdn/methods/page.ts` line 164 emits `<body>` and then closes it. Every site we serve
is a blank document that fills in once the kernel boots and the parts fetch.

For a console that is correct and cheap. For a normal site it is fatal twice over: nothing paints
until two round trips have completed, and a crawler sees an empty document. M1 proved the title and
description reach the *document* — that was deliberate and it is why the sites are not completely
invisible — but the content does not.

**The path exists and nothing uses it.** `mesh-web/src/description/flatten.ts` says so in its own
header:

> This is the test renderer, and it is also the **server-side-rendering path**: it resolves every
> reactive value once and expands control flow, producing a plain tree with no functions in it.

It is exported from the package. `grep` for an importer outside mesh-web's own tests returns
nothing. It is a reader-audit entry of exactly the kind that predicted `manifest.layouts`.

---

## Why the obvious fix does not work

The obvious fix is: have the cdn import `flatten`, render the page, emit it into `<body>`.

**A release pins a kernel artifact, and different sites on one edge run different kernels.** Right
now `demos.localhost` and `console.localhost` are on 0.11.x while other releases still name 0.6.x. If
the cdn bundled a kernel to render with, it would render every site with *its* kernel rather than the
one that site's release names.

That is not a version-skew annoyance; it breaks the claim the whole artifact model rests on. A part
artifact never contains the kernel precisely so that one mounted kernel resolves the import map, and
`DeclarationSchema.kernel` exists to stop a part built against one kernel loading into a page serving
another. Rendering server-side with the wrong kernel is that same failure, made invisible — it would
happen on our machine, in the HTML, before anyone's browser could disagree.

Second thing to notice before trading it away: **mesh-serve does not depend on `@flybyme/mesh-web` at
all.** The cdn moves bytes it never executes. That is a real property — a security and stability one
— and every option below except (B) gives it up.

---

## The three options

### A. Load the release's own kernel artifact at render time

The cdn dynamically imports the kernel the release names, mounts the application, flattens, emits.

**Correct, and the only one that renders live content.** It is also the expensive one: the server
now executes part code it did not write, per request, which needs isolation, a time budget, and a
failure mode that still serves *something*.

**It moves B6 into the blocking path.** "Who may publish" is currently an M4 item — the marketplace
question. The moment a third party's part executes on our server rather than in the visitor's
browser, it stops being about protecting the site and starts being about protecting the platform.
That reordering is the single most important consequence on this page.

### B. Prerender at build time, into the artifact

The builder renders the part once and stores the HTML alongside `index.js`.

Fits everything we already have: deterministic, content-addressed, cached forever, and the cdn stays
a pure byte server that executes nothing. Cheap and safe.

**And it cannot render a blog's posts**, because they come from the API and the builder does not know
them. It buys a first paint of the shell, not the content — which is worth something for perceived
speed and nothing at all for a crawler.

### C. A separate render service

A node that holds kernels and renders on demand; the cdn calls it and splices the result.

Keeps execution off the edge and gives it somewhere to be isolated and rate-limited. Costs a hop on
the first paint, and adds a service that has to be running for pages to be complete — so it needs a
defined behaviour when it is not, which is (B)'s output or an empty body.

---

## Recommendation

**B now, A designed but gated behind B6.**

B is small, it is safe, it makes the artifact carry its own first paint, and it does not require
deciding anything about executing other people's code. It is honest about what it gives: a shell, not
content.

A is what a real blog needs, and the right time to build it is after "who may publish" has an answer,
not before. Building A first would mean the first third-party part we ever accept runs on our
hardware — and we would have got there by accident, chasing a first paint.

C is the eventual shape of A if A's isolation turns out to need a process boundary. Not a separate
decision to make now.

## What to answer before any of this is dispatched

1. **Is the target a blog, or a marketing site?** A marketing site is static and B is sufficient, so
   the whole of A may be premature.
2. **What does a render failure serve?** A blank body is the current behaviour and is a defensible
   floor, but it has to be chosen rather than inherited.
3. **Does the router (A0.6) come first?** SSR renders *a route*, and there is no router. Rendering
   the default view of a site whose URL says otherwise is a cache poisoned at the first request.

That third one may reorder everything: **A0.6 probably blocks useful SSR**, and A0.6 is itself
blocked on A0.6a. Answering "what does one URL mean" with *it depends on the window mode* — trivial
under `single`, hard under `windowed` — would unblock both.
