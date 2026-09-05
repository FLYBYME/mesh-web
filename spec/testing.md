# Testing

What this design makes testable, what it does not, and the one thing to be careful about.

**Status.** **Proposed**, except where it records a property another document already decided.

Companions: [the view layer](./view-layer.md) · [the kernel](./kernel.md) · [input](./input.md) ·
[the network layer](./network.md) · [the roadmap](./roadmap.md).

---

## 1. The claim

Most of this framework is pure functions over data, and that is not luck. It falls out of one rule:

> **What is shown and the logic for what is shown are two different things.**

A view that returns a description instead of DOM is a function you can call in a test. The *same*
boundary that makes isolation possible makes testing possible — a description you can post to a
worker is a description you can assert on.

The corollary is the honest part: the untestable surface does not disappear, it **concentrates**. It
ends up in the renderer and the input adapters, and it is small, which is good, and it is where the
bugs will live, which is the thing to plan for.

---

## 2. Pure — no framework, no DOM, no fakes

Data in, data out. These are table-driven tests.

| what | test |
| --- | --- |
| **a view** | state → description. The biggest win in the design. |
| **the focus graph** | rects and groups → navigation result, per direction ([input §3](./input.md)) |
| **intent mapping** | device signal + bindings → intent ([input §2](./input.md)) |
| **registry resolution** | build → system → user → device → default ([storage §2](./storage-and-registry.md)) |
| **manifest merge** | manifests → merged map, or a named conflict ([kernel §3](./kernel.md) step 4) |
| **route resolution** | URL → application, view type, params |
| **description diffing** | tree A, tree B → patches |
| **grant evaluation** | `can(grants, action)`, pure in the contract package ([Extensions §4](./extension.md)) |
| **the tile split tree** | layout + resize → geometry |

The last row in the Extensions entry is worth noting as a pattern rather than an item: **moving
synchronous logic out of a provider and into its contract package as a pure function was forced by
isolation, and paid for itself in testability.** `can(grants, action)` needs no Extension, no kernel
and no page. When a constraint makes something more testable, it is usually the right constraint.

---

## 3. Fakes, not mocks

Every capability is an interface the kernel hands out ([kernel §4](./kernel.md)). So a contribution
under test gets a **fake context** — real objects with in-memory behaviour, not recorded
expectations:

- `mesh` backed by a table of action → response
- `storage` in memory
- `windows`, `commands`, `menus` recording what was asked for
- `state` the real implementation, because signals are pure
- `events` a queue you push into

An Extension or Application is then testable with **no kernel running and no DOM**: construct it,
hand it a context, call `activate` or `start`, assert on what it returned and what it asked for.

This is the practical payoff of capability narrowing. A contribution declaring
`needs('mesh', 'notifications')` needs a fake with exactly two things on it, and the type system says
so — you cannot forget one, and you cannot be surprised by a call to something you did not fake.

**Mocks specifically are the wrong tool here.** Asserting "`mesh.call` was invoked once with these
arguments" tests the code's shape rather than its behaviour, and this design changes shape often.

### Conformance suites

Two places want one suite run against many implementations:

- **Storage providers** — memory, `localStorage`, IndexedDB, remote. One suite covering `get`, `set`,
  `stat`, `usage`, conditional writes by `version`, and the `durability` a provider claims. A new
  provider is trusted when it passes.
- **Renderers** — the in-process one and the test one. [view-layer §4](./view-layer.md) already
  argues for a single render path; running both against one suite is how you discover the description
  is missing something.

---

## 4. Needs a real browser

Small, concentrated, and unavoidable.

| what | why |
| --- | --- |
| **the renderer** | description → DOM. Needs a DOM. It is *one* component, and everything above it is testable without it. |
| **window mechanics** | move, resize, hit zones, snapping. Needs real layout. |
| **focus in the DOM** | the *graph* is pure (§2); making the browser agree is not. |
| **text entry, IME, OSK** | composition is notoriously untestable and platform-specific |
| **pen and touch** | pressure, tilt, palm rejection |
| **gamepad** | the Gamepad API cannot meaningfully be synthesised |
| **the builder and CDN** | integration, by nature |

### How, concretely

Two vitest projects, because the split is real and should cost nothing to run:

| | `npm test` | `npm run test:browser` |
| --- | --- | --- |
| config | `vitest.config.ts` | `vitest.browser.config.ts` |
| runs in | node, with `@vitest-environment jsdom` per file | real Chromium, via Playwright |
| input | the test synthesises the event | the browser delivers it, over CDP |
| holds | everything that can be answered without layout | `test/browser/**` only |

Vitest browser mode serves `src/` with Vite and runs the test file **inside the page**, so a test
imports the framework exactly as an Application would and there is no bundle step. Two details that
are not obvious and cost an afternoon each:

- **`channel: 'chrome'` uses the system Chrome**, so `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is safe and
  CI needs a browser rather than a 400MB cache.
- **Set a viewport.** `userEvent.dragAndDrop` clamps a drop point that falls outside the target
  element's box, so a viewport narrower than the desktop under test silently turns a 120px drag into
  a drag to the middle of the page — which reads exactly like a framework bug and is not one.

A third thing to look at rather than run: `browser/` is a harness, not a demo — one Application in a
window, `npm run harness`. §6 is why it exists.

**You cannot unit test a Steam Deck.** The input model is designed so that most of it — bindings,
intents, the focus graph — is pure and testable, and the part that genuinely needs the hardware is
the adapter that turns a poll result into a signal. Keep that adapter thin, precisely because it is
the part nobody can test in CI.

---

## 5. The type level is a test surface

Already proven rather than proposed. `@ts-expect-error` assertions in `demo/rejected.ts` cover
undeclared capabilities, undeclared providers, providing what you do not return, and routing to a
view that does not exist — and they were verified load-bearing: deleting one directive produces
`Property 'windows' does not exist on type 'Context<readonly ["mesh", "notifications"]>'` and the file
stops compiling.

That is the property to preserve. **These assertions fail the build when they start passing**, which
is the only way a type-level guarantee stays guaranteed.

The generated network client belongs here too: a test that calling an unexposed action does not
compile is the only check that [network §3](./network.md)'s exposure boundary is real.

---

## 6. The trap

> **The deleted runtime had 182 passing tests, a clean typecheck and a clean build. Nobody ever saw
> the console render.**

That is in this repository's own history ([status §5](./status.md)), and it is the failure mode this
design makes *easier*, not harder. A large pure core with a thin untestable shell is exactly the
shape that produces a green board and a blank page.

So:

- **A real browser test exists from the first milestone**, not added later. [roadmap M1](./roadmap.md)
  is "a window you can drag" for this reason — it is defined as something you look at.
- **Every milestone's definition of done is something visible**, not a test count.
- **The renderer and input adapters carry the browser tests**, because they carry the risk, and unit
  test count there is close to meaningless.

Testability is not verification. This document is about the first; the second needs someone to look.

---

## 6a. Testing a part, from outside this repository — **built 0.5.0**

Everything above is about testing *this* package. A part repository — `mesh-auth`,
`surfdns-console` — is the other side, and until 0.5.0 it had nothing: a part could be built,
published and served, and the only way to find out whether it activated was to open a page and look.

```ts
// vitest.browser.config.ts
import { definePartBrowserConfig } from '@flybyme/mesh-web/testing/config';
export default definePartBrowserConfig();
```

```ts
const site = await mountPart({ parts: [{ id: 'auth', contribution: AuthExtension }] });
expect(site.kernel.provided(AUTH)).toBeDefined();
site.dispose();
```

Three properties earn it, and each is a mistake a part author would otherwise make once:

**It boots through `start()`.** The same path a deployed site takes. A harness that booted a part its
own way would be testing something that does not ship — which is precisely what happened to this
repository's previous harness, and it took a while to notice because the harness worked.

**It asserts one copy of the framework.** A part is built with `@flybyme/mesh-web` external and the
page's import map resolves it to one kernel; two copies under two URLs are two module graphs and two
of every singleton the capability model depends on. A test setup that quietly gave a part its own
copy would pass everything and prove nothing, so the check is explicit rather than assumed.

**The configuration is the framework's knowledge.** Resolving to one copy, a real Chrome rather than
jsdom, a viewport large enough that a window is not clamped to nothing — a part author writing that
by hand would be copying thirty lines they cannot evaluate.

**The test tools stay in a part's own `devDependencies`.** They are not dependencies of this package:
a browser automation tool in `dependencies` means every part *and every site* downloads Chromium to
install a UI library.

## 7. Open

- **Snapshot testing descriptions.** Tempting, since a description is data. Also the classic way to
  end up with a thousand snapshots nobody reads. Probably: snapshot structure, assert behaviour.
- **How the test renderer reports layout.** The focus graph needs rects, so a pure focus test needs
  a layout oracle. Either the test renderer computes a simple box layout, or focus tests supply rects
  directly and real layout is only checked in the browser.
- **Fixtures for the generated client** — whether a fake `mesh` is generated from the same exposure
  descriptor, so a fake cannot drift from the contract it stands in for. Probably yes, and it is not
  free.
- **Whether contributions get a conformance suite too**, so a third-party Extension can be checked
  against the contract before a site trusts it. §6a is the machinery for it — `mountPart` already
  boots a part the way a site does, so a suite would be assertions rather than infrastructure.
- **A test that fails when a part ships a class the kernel cannot construct.** `PartRef` accepted
  `new (options?: unknown) => …` until 0.5.0, which *rejected every part with a typed constructor*
  because constructor parameters are contravariant. It typechecked because the fixture testing it
  took `unknown` too — **a type tested only against a shape built to satisfy it has not been
  tested** — and it was found by the first part somebody else wrote. The type is fixed; the class of
  mistake is not covered.
