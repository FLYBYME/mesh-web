# Type safety

> "type safety is number one if i have to write 10 more lines of code to stick to a standard that's
> ok"
>
> "the mesh framework is fully typed because of code generation"

**Status.** **Decided.** This is a standard the other documents comply with, not a proposal. Where an
earlier document conflicts, this one wins and §8 lists the conflicts.

Companions: [the network layer](./network.md) · [Applications](./application.md) ·
[Extensions](./extension.md) · [testing](./testing.md).

---

## 1. The trade, stated once

Ergonomics loses. If a safe version costs ten more lines, write the ten lines.

That is not a licence for ceremony — a design that is both safe and short is better than one that is
safe and long. It settles the argument when the two conflict, so it does not have to be re-litigated
per interface.

---

## 2. The rule that catches most of it

Not all type parameters are equal.

```ts
cx.state.signal(0)                    // T inferred from the argument       — safe
cx.net.get<Session>('/api/me')        // T supplied, nothing checks it      — an assertion
```

The second is `as Session` wearing generic syntax. Nothing verifies it; the compiler believes the
caller, and when the endpoint changes the compiler keeps believing them.

> **If the framework cannot verify a type parameter, it must not accept one.**

An interface that takes `<T>` and cannot check it should return the honest type and force the caller
to do something visible about it.

### The sink exception

Data flowing *outward* with nothing downstream depending on its type may be `unknown`:

```ts
cx.log.info('build finished', anything);      // fine — a sink
cx.notifications.error('failed', anything);   // fine — a sink
```

The test is whether anything reads it back as a type. A logger does not.

---

## 3. Everything string-keyed gets its type from a declaration

This is the unification, and it is why [the manifest](./application.md) turned out to matter more
than it first looked. Six things are addressed by string, and every one of them draws its type from
something declared:

| call | typed by |
| --- | --- |
| `cx.net.call('credential.resolve', input)` | the site's exposure descriptor ([network](./network.md)) |
| `cx.events.on('identity.ticket_revoked', h)` | the same descriptor's event contracts |
| `cx.windows.open({ view: 'editor', params })` | the `views` declaration — params checked per view |
| `cx.commands.run('blog.newPost', args)` | the `commands` declaration |
| `cx.settings.get('blog.postsPerPage')` | the `settings` declaration's schema |
| `cx.storage.get('draft')` | a declared storage schema |

Same mechanism throughout: a literal union of declared keys, and a mapped type from key to value.
A typo is a compile error at the typo. An unknown key does not compile. And the value type comes
from a declaration nobody can quietly disagree with, rather than from the caller's hopes.

**This is the ten lines.** Declaring a settings schema to read one setting is more typing than
`storage.get<number>('postsPerPage')`. It is also the difference between a rename being caught and a
rename being discovered in production.

---

## 4. Banned

Concrete, so a review can point at a line.

- **Caller-supplied type parameters the framework cannot check** — §2.
- **`get<T>(path)`, `post<T>(path, body)`** on the network. Deleted, not deprecated. There is one
  typed way to call an API, and it is generated.
- **Subscribing by bare string** — `events.onNamed(name, (payload: unknown) => …)`. An event handler
  with a mistyped payload fails *silently*, which is worse than a call that throws.
- **Index signatures on props.** `[attr: string]: unknown` on a component's props means every typo is
  legal and nothing is checked. Component props are exact.
- **`Record<string, unknown>` for view params.** A view declares its params type; opening it checks
  against that.
- **`as` casts across a boundary.** `as unknown as X` was already found to be unnecessary once
  ([status §2](./status.md)); it is now banned rather than discouraged.
- **`any`, anywhere.** Already the standing rule — `as any` / `as never` is a real bug in this
  codebase, not a style nit.

---

## 5. Errors are part of the type

The open question in [network §8](./network.md), now decided by the principle rather than by taste.

A call that returns `Promise<Credential>` and can fail with 401, 403, 404, a validation error or a
transport failure is **not typed**. Its failure mode is invisible, and every caller either ignores it
or writes `catch (e: unknown)` and starts guessing.

> **A network call returns a result that names its failures.**

```ts
const r = await cx.net.call('credential.resolve', { id });
if (!r.ok) {
    // r.error is a discriminated union: 'unauthorized' | 'forbidden' | 'not_found'
    //                                 | 'invalid' | 'transport'
    return;
}
r.value;    // Credential — only reachable after the check
```

The cost is real: every call site handles the failure explicitly, and that is more than ten lines
across a codebase. It is exactly the trade §1 settles. It also removes the largest source of
`unknown` in the whole design.

**Not everything becomes a result.** In-page provider calls, capability calls and pure functions
throw or cannot fail. This is for the network boundary, where failure is ordinary rather than
exceptional.

---

## 6. What is generated

mesh is fully typed because of code generation, and mesh-web inherits the approach. Generated,
never hand-written, never edited:

| generated | from |
| --- | --- |
| the API client — actions, inputs, outputs, errors | the site's exposure descriptor |
| event subscriptions and payloads | the same |
| typed collections for CRUD contracts | the same |
| settings accessors | the manifest's `settings` declarations |

With one rule carried over from [network §3](./network.md), because it is the difference between
generated types that hold and generated types that collapse:

> **Emit structural types, never `z.infer` references across a package boundary.**

A generated file that says `z.infer<typeof Contract['outputSchema']>` is not a type, it is a
reference TypeScript must resolve through another package's zod — and a duplicate copy silently
yields `unknown`. That is surfdns #15, already observed. The generator resolves the schema and emits
the finished type; nothing at a call site imports zod.

**And a stale generated file is worse than none**, because the compiler now vouches for something
false. The exposure hash is checked in CI and reported by the running API
([network §6](./network.md)).

---

## 7. One escape hatch, made unattractive

A third-party HTTP API with no mesh contract has to be reachable. Pretending otherwise would push
people into worse workarounds.

So there is exactly one, and it is deliberately awkward:

- it lives on a separate surface, not beside the typed calls
- it returns `unknown` and will not be told otherwise
- getting a usable value requires parsing, explicitly, at the call site
- it is a declared capability, so reaching for it appears in the manifest and in review

The goal is that it never gets used out of convenience — only when there is genuinely no contract.
The same principle as `dom` ([view-layer §8](./view-layer.md)): the escape hatch exists, it is
declared, and it is visible from outside the file.

---

## 8. Where the current specs violate this

Found by auditing what is already written against this standard. All of it is design on paper, so
none of it is deployed — but it would have been.

**In `demo/types/mesh-web.d.ts`** (the demo is already superseded; these add to the list):

| line | violation | fix |
| --- | --- | --- |
| `get<T>(path)`, `post<T>(path, body)`, `resource<T>(path)` | caller asserts the response type | §4 — generated `call` only |
| `onNamed(event: string, (payload: unknown) => void)` | untyped subscription | §3 — typed from the descriptor |
| `storage.get<T>(key)`, `set<T>`, `signal<T>` | caller asserts stored shapes | §3 — declared storage schema |
| `Props[attr: string]: unknown` | every prop typo is legal | §4 — exact props |
| `windows.open({ params?: Record<string, unknown> })` | params unchecked against the view | §3 — per-view params |
| `commands.run(id: string, ...args: unknown[])` | any id, any args | §3 — declared ids |

**Safe, and staying:** `each<T>`, `state.signal<T>`, `computed<T>` — inferred from an argument, not
supplied. `provider<T>` — declared and checked against `activate`'s return.
`log`/`notifications` taking `unknown` — sinks, §2.

**In `storage-and-registry.md`:** the provider interface passes `value: unknown` and
`StoredValue.value: unknown`. That is correct at the *provider* layer — a provider genuinely stores
opaque bytes — and wrong if it reaches a caller. The typed layer sits above it, driven by declared
schemas, and the boundary needs stating in that document.

---

## 9. Open

- **How a storage schema is declared** — alongside `settings` in the manifest, or separately. They
  are different things: settings are user-facing configuration, storage is an Application's own
  data.
- **Whether the result type in §5 applies to `models`** collection operations, which are network
  calls wearing a collection's clothes.
- **Whether component props are generated too**, once components can be contributed by Extensions
  ([view-layer §3](./view-layer.md)). If a design system ships as an Extension, its props are a
  contract like any other.
- **Generated file size**, per [network §8](./network.md). Structural types are larger than
  references.
