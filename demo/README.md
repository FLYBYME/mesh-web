# demo

> ## ⚠ Superseded in one important way
>
> These files were written before [`spec/view-layer.md`](../spec/view-layer.md), and they are wrong
> where the two disagree. Specifically:
>
> - **`mount(el: HTMLElement, vx)` is gone.** A view is a pure function from state to a
>   *description*. No container, no DOM types. The whole point of the layer is that an Application
>   cannot construct a node, because a view that can construct a node can hold logic.
> - **`h('div', …)` is gone.** An Application's vocabulary is components — `Stack`, `Text`,
>   `Button` — never tags. Returning a description but writing `h('div')` is the same problem with
>   extra steps.
> - **`content` is a tile, not a view.** The blog declares a *layout* with named regions
>   (`header`, `sidebar`, `content`, `footer`); `post` and `editor` are views that both target the
>   `content` tile. Naming a view and a tile the same thing was the confusion.
> - **`commands` and `keys` are declared, not registered in `start()`** — along with `layout`,
>   `views`, `menus` and `settings`. See [application §2](../spec/application.md).
>
> Everything below about `needs()`, provider tokens, `vx.app`, headless Applications and the
> `rejected.ts` assertions still holds. The files are kept as they are rather than rewritten twice:
> the component vocabulary ([roadmap A7.1](../spec/roadmap.md)) has to be settled first.

Illustrative code, to see the shape of the thing before it exists.

**There is no framework behind this.** `types/mesh-web.d.ts` is declarations only — every function
in it is a signature with nothing on the other side. Nothing here runs.

It does, however, **typecheck**, which is most of the value: open any file and the editor gives real
completion and real errors. That is the claim the design rests on, and it is cheaper to test on a
demo than after the framework is written.

```bash
cd demo && npx tsc -p tsconfig.json     # exits 0
```

---

## What is here

```
types/mesh-web.d.ts       the contract, as declarations. No implementation.
contracts/auth.ts         a shared interface + token — the "third place" both sides import
extensions/auth.ts        an Extension: session, passkeys, revocation
apps/blog.ts              an Application with views: header, sidebar, content, footer, editor
apps/link-checker.ts      a headless Application — no views at all
rejected.ts               what the contract refuses, as compiling assertions
```

Read them in that order. `rejected.ts` is the interesting one.

---

## The five things worth looking at

**1. The list is written once.**

```ts
const NEEDS = needs('net', 'notifications', 'state', 'storage', 'events', 'log');

export default class AuthExtension implements Extension<typeof NEEDS, readonly [], typeof AUTH> {
    readonly needs = NEEDS;
    activate(cx: Context<typeof NEEDS, readonly []>): AuthApi { ... }
}
```

No `as const`. `needs()` is a rest parameter with a `const` type parameter, so the literal tuple
survives on its own; naming it makes the list a single source of truth. In the editor, typing
`needs('` completes capability names, and `needs('net', 'nett')` puts the error on `'nett'` rather
than somewhere downstream.

**2. An undeclared capability is not there.**

In `extensions/auth.ts`, add `cx.windows.open(...)` and it will not compile — `windows` is not in
`NEEDS`. `rejected.ts` asserts this, and the assertion is load-bearing: deleting the
`@ts-expect-error` above it produces

```
Property 'windows' does not exist on type 'Context<readonly ["net", "notifications"]>'.
```

so the file stops compiling if the narrowing ever widens.

**3. A type crosses a boundary neither side imports over.**

`apps/blog.ts` calls `cx.use(AUTH)` and gets a fully typed `AuthApi`. It never imports
`extensions/auth.ts`. Both import `contracts/auth.ts`, which is an interface and a token and nothing
else. Take `AUTH` out of `CONSUMES` and the `use` call is an error.

**4. A blog and an IDE are the same kind of thing.**

`apps/blog.ts` declares five views. Four of them are website regions — header, sidebar, content,
footer — and in tiled mode they are exactly that. Switch to windowed and the header becomes a window
you can drag. **Nothing in the file knows which mode it is in**, which is the whole claim.

The fifth view, `editor`, is `instances: 'many'`. Open two and you get two editors with independent
geometry. mesh-ui could not do this — its `ViewRegistry` kept one container per provider id.

**5. A process does not need a screen.**

`apps/link-checker.ts` has no `views` at all. It runs on a timer and is reached through its API. Put
it next to `extensions/auth.ts`: both are small, neither renders, and the difference is that stopping
the link checker leaves everything working while stopping auth breaks every consumer. That is the
test for which contract a thing should use.

---

## Things this demo invents

The demo needs details the spec has not decided. They are **illustration, not design**, and are
listed here so they are not mistaken for settled:

| invented | status |
| --- | --- |
| `mount(el, vx)` as a view's render function | The factory shape is from mesh-ui and is right. The exact signature is a guess. |
| `ViewContext` — `params`, `setTitle`, `close`, `onDispose` | Plausible, undecided. |
| `h()`, `when()`, `each()` | The deleted DOM layer's shape, roughly. Not respecified. |
| `Net.resource()` returning a signal | Follows storage §4's "reads are signals", applied to HTTP. |
| `Events.onNamed(string, …)` | The typed `on(EventRef)` is the real one; this is the escape hatch. |
| `instances: 'one' \| 'many'` on a view | Proposed in application.md §6, not confirmed. |
| `singleton` on an Application | Same. |
| grant patterns (`'post.*'`, `'*'`) in the auth Extension | A stand-in for mesh-identity, which does not exist. |

And two the demo deliberately gets *right* in a way the spec argued for but never showed:

- **`stop()` is nearly empty.** `blog.ts` disposes nothing, because the kernel disposes every
  capability it scoped. `link-checker.ts` clears a timer, because it got that from `window` rather
  than from a capability — the line is exactly "did the kernel hand it to me".
- **Construction does nothing.** No DOM, no network, no registration in any constructor. That is
  what lets the kernel construct every contribution and inspect the graph before activating any of
  it (kernel §3).

---

## What it does not show

The window manager, because there is nothing to show — no code tiles, floats, moves or resizes yet,
and the mode switch that makes point 4 true is entirely unwritten. The blog's views declare where
they would go. Nothing puts them there.
