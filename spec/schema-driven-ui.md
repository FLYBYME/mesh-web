# Schema-driven UI: forms and collections the framework already knows how to draw

Written 2026-09-07, from reading what the API layer already builds and throws away.

**Status.** Proposed. The finding in §1 is fact — it is in the code today. Everything from §3 on is
a design that needs a yes or no.

The question that started it: *"because input and output is defined on all contracts you could
create dynamic windows that can list and call all contracts it knows about. this way most app logic
does not even have to deal with most form data because a standard form is used every time."*

The answer is that this is not a new subsystem. **The description it needs is already built, on
every boot, and never leaves the server.**

---

## 1. What exists — measured

Two layers already derive a machine-readable description of every contract from the same zod schema
that validates the call.

**mesh's registry**, [`Registry.ts:469`](../../mesh/src/core/Registry.ts), publishes for every
registered contract:

```ts
params:   zodToJsonSchema(contract.inputSchema),
returns:  zodToJsonSchema(contract.outputSchema),
metadata: { isCrud, destructive },
timeout, description, visibility
```

**mesh-serve's `ExposureDescriptor`**,
[`api/schema/descriptor.ts:27`](../../mesh-serve/src/api/schema/descriptor.ts), is the better of the
two, because it is already narrowed to what a given site exposes. Per call:

| field | what a UI would do with it |
| --- | --- |
| `key`, `domain`, `action` | the name in a list |
| `description` | the heading, and the empty state |
| `method`, `path` | how to call it |
| **`input`** | **the form** |
| **`output`** | **the table, or the detail surface** |
| `gate` | whether to ask for sign-in *before* calling, rather than rendering a 401 |
| `destructive` | whether this needs a confirmation step |
| `errors` | the declared failure list, instead of "something went wrong" |
| `stream` | whether the result arrives all at once |

### The scale of what is already described

| | |
| --- | --- |
| `defineCrud` collections in mesh-serve | **14** — `artifact` `build` `edge` `grant` `membership` `organization` `part` `partVersion` `release` `role` `site` `ticket` `user` `apiToken` |
| generated actions each | **11** — `find` `findOne` `count` `get` `resolve` `create` `createMany` `update` `replace` `delete` (+ `create_many` naming) |
| addressable contracts from CRUD alone | **~154**, every one with an input schema and an output schema |
| of those, hand-written UI today | **0** |

### And the browser cannot see any of it

[`net/api.ts:33`](../src/net/api.ts) is explicit — `ApiCall.types` is a phantom:

> *"Never assigned. Present only so the compiler carries the shapes."*

The descriptor is consumed at **build** time to emit a typed client, and then discarded. Nothing
serves it at run time, so a page has method and path and nothing else.

**That is the entire gap.** Not a new capability: a value that is computed, used once, and dropped.

---

## 2. Why this is the same problem as `ui`

[components.md](./components.md) measured 578 `element()` calls across the demos and **446 inline
`style` objects** — 77% of call sites. `ui@0.1.0` answered the display half of that: `entityList`,
`entityItem`, `detailSurface`, `propertyGrid`, `table`, `tableRow`.

It has **no vocabulary for entering a record.** No field, no label, no select, no button row, no
dialog. So the first console that needs a create form re-opens the same hole `ui` was built to
close, and the second one re-opens it differently.

The two facts meet: there is no form vocabulary, and there is a complete description of every form
the system could ever need, going unread. **Writing the vocabulary against the description is
cheaper than writing it against twelve screens**, and it is the only version that does not need
writing again for the thirteenth.

---

## 3. What to build — **Proposed**

### 3.1 Serve the descriptor

`GET /api/_describe`, gated, returning the `ExposureDescriptor` the site already computed. It is a
read of a value in memory; the only real decisions are the gate and the cache header.

It must carry the **`shapeHash`**, not the exposure hash — [network §4](./network.md) and the
staleness fix of 2026-09-06. A client checking whether its rendering is stale is asking a
site-independent question, and the gate hash answers a different one.

### 3.2 `ui.form` — a form from an input schema

Takes a JSON Schema, renders fields, emits a value of that shape. The mapping is unremarkable —
`string` to `Input`, `boolean` to a checkbox, `enum` to a select, `array` to a repeater, `object` to
a group — and unremarkable is the point.

Two things it must get right, because both are already settled elsewhere and a new form layer is
exactly where they get lost:

- **The dispatcher's rules** ([input §2](./input.md), A7 tail). It listens for `input`, not `change`
  — *"`change` fires on blur, so a form whose button is clicked straight from a focused field never
  sees the last thing typed, which is the classic dropped password."* An empty number field is
  `undefined`, not `0`.
- **`Props = Reactive<Json> | undefined`.** A field's value is a value or a getter, never a
  callback. A generated form does not get to invent a second convention.

### 3.3 `ui.collection` — a CRUD collection as one component

Given a domain and the descriptor, a collection is fully determined: `find` gives the table,
`get` the detail surface, `create` and `update` the form, `delete` the destructive action. One
component, fourteen collections, and none of them written by hand.

This is the *"some crud collections drive state"* case. The user writes the row; the write fires the
scoped event; something acts on it. The UI never needed to know what the row **meant** — only its
shape, which it was told.

---

## 4. The part that will bite — **Decided, and it goes in from the start**

Schema-driven forms are excellent for the common case and bad for the rest, and a design that does
not admit this up front gets abandoned in week two.

**What a schema carries:** types, requiredness, enums, ranges, nesting, and — through a zod
discriminated union — genuine variance. A DNS record where `MX` requires a priority and `A` requires
an IPv4 is expressible, and converts to `oneOf`.

**What a schema does not carry:** field order, labels a person would use, grouping, help text, which
three of nineteen fields matter, and which two fields are meaningless apart.

So `ui.form` needs an **override seam from the first commit**: generic by default, refined per
contract where a screen earns it, refining *fields* rather than replacing the form. The failure mode
without it is not that the forms are ugly — it is that the first screen with real requirements
hand-writes its form, and then every screen does.

This is the same shape as `defaultFrame` and `createSite` (A6.10): *the ordinary thing, with every
piece overridable.* Third time that shape has been the answer.

---

## 5. Why this is safe, and why it makes policy visible

The obvious objection to a window that can list and call every contract it knows about is that it is
a data-leak generator. It is not, and the reason is already built.

**`scopedBy` is not for this — but it is what makes this safe.** It confines every generated read
and write to the caller's organization, and a cross-scope `get` answers **404, not 403**
([D3](./roadmap.md), mesh v2.2.0). A generic window cannot be talked into showing another
organization's rows, because *no caller can*. Confinement is structural, so it does not have to be
re-established per screen — which is exactly what a per-screen implementation would get wrong on
screen nine.

**And the menu is the exposure list.** A dynamic window can only offer what the site exposes, and
`describeExposure` already refuses to publish a contract mesh marks `internal`:

> *"mesh defaults a contract to `internal` precisely so a `defineCrud` that mints ten addressable
> contracts does not publish all ten; exposing one to the public internet is a decision that
> deserves to be made out loud rather than by omission."*

This is the strongest argument for policy found so far, and it is an argument *for* the generic UI
rather than against it: **tighten the exposure and the UI narrows automatically.** There is no second
list of what the console may touch, so there is no second list to drift. A build restricted to what
it needs has a console restricted to the same thing, by construction rather than by discipline.

---

## 6. What this changes about the `platform` Extension

The `platform` Extension was scoped as *reads, writes, and the components that go with them* for
`part`, `partVersion`, `release`, `site`. That still holds, but the components it owns become far
fewer: a site editor is `ui.collection` pointed at `site`, plus the overrides that site editing
genuinely earns.

`platform` then owns what a schema cannot describe — that composing a release and deploying it are
one action to a person and two to the server, that a release is site-independent, that publishing
needs a token — and inherits the rest.

---

## 7. Open

- **Where the override lives.** In the Extension that owns the domain, or beside the contract on the
  server? The server knows the schema; only the client knows the screen. Leaning client.
- **Whether `_describe` is one document or one per domain.** One document is simpler and is a larger
  cache invalidation.
- **Whether a generated form may be *composed* into a hand-written view**, or is only ever a whole
  window. Composition is more useful and much easier to get subtly wrong.
- **Write-time validation.** The client has the input schema and could validate before calling. It
  must not become the *only* validation — the gate validates regardless — but a form that reports a
  bad field without a round trip is the reason to have the schema at all.
