# mesh-web, for someone arriving cold

**The kernel.** What boots in a browser, hands out capabilities, and runs the process table.
~11,300 lines — the largest single piece of the client, and every part on every site depends on it.

This file exists because every dispatch was re-deriving the same facts. Measured across the
transcripts: `src/render/dom.ts` opened 31 times, `src/kernel/start.ts` 18, `src/window/shell.ts` 16,
`src/contribution/contract.ts` 12. **Read this first; it is the index, not the documentation.**

## Where things are

| | |
| --- | --- |
| `src/kernel/` | `start.ts` boots a page, `kernel.ts` is the process table and provider registry, `broker.ts` is the credential seam |
| `src/description/` | **the vocabulary, as pure data.** `types.ts` is the node shapes; `flatten.ts` renders with no DOM |
| `src/render/` | `component.ts` is the 19 primitives and the registry; `dom.ts` is the reconciler |
| `src/window/` | `manager.ts` is the model, `shell.ts` paints, `layout.ts` is tiles, `persistence.ts` is geometry |
| `src/contribution/` | `contract.ts` — `Application`, `Extension`, `Context`, `ViewContext`. The types every part implements |
| `src/reactivity/` | signals, computed, effects, scopes, `resource` |
| `src/net/` · `src/models/` | the typed client, and typed reactive collections over CRUD |

**`spec/` is not aspirational.** Every document there records decisions with the argument attached,
and several of them predicted defects before anyone hit them. `spec/status.md` is the index;
`spec/roadmap.md` is what is done and open.

## Six things that are true and expensive to rediscover

**A description is data, and there is deliberately no `HTMLElement`, `Node` or `Event` anywhere in
the description layer.** A part returns a tree naming *components*, never tags. The renderer decides
what element each becomes, if any. This is why `flatten.ts` can render a full view with no DOM and no
jsdom.

**The one exception, and it is deliberate:** a `ComponentDefinition` creates a DOM element, because a
component *implements* the vocabulary rather than using it. That boundary is the whole reason the
rest of the rule holds.

**Provider tokens resolve by id string, not object identity** — `provider.ts:20` makes a token
`{ id }` and `kernel.ts:123` does `#providers.get(token.id)`. So a contract module bundled into two
artifacts still resolves to one provider, which is what makes the `AUTH` / `THEME_TOKEN` pattern
work. If tokens ever matched by identity this would fail silently at runtime.

**Anything the kernel needs before a part runs must be declared, not registered.** Commands, keys,
menus, views, layout, settings, api — the palette lists commands before the Application starts, and
geometry is restored at boot step 9 while Applications start at step 10. **Conflicts are therefore
resolved at load** (`mergeManifests` → `manifest.conflicts`), not by whoever registered last.

**`Application`/`Extension` carry `TApi`, and a view has an internal context.** As of 0.14, a view no
longer reaches its state through the published API — which is what stopped every signal a view needed
from having to be public. `spec/components.md` §5 has the argument.

**Three window modes, and `single` is not "one window maximised".** `windowed` and `tiled` are modes
where the manager positions things; `single` is the mode where it **stops** positioning and the
document scrolls. There is a test asserting `document.scrollingElement`, and it is the assertion that
separates the two implementations.

## Conventions

Zero `as any`, zero `as never`, **zero casts.** This repository exists because its owner nearly
rewrote MoleculerJS for type safety. A cast is a bug, not a style nit — and where a type genuinely
cannot express something, that is a report finding, not a cast.

**Props are exact per component.** `spec/type-safety.md` §4 bans an index signature: with one, every
prop typo is legal and nothing is checked.

**Every action has a non-pointer path** (`spec/input.md` §3). A component reachable only by pointer
is not finished. This is also why the primitives reach for native elements — `<dialog>`, real
headings, `<input type=range>` — rather than styling a `div`.

## Running it

```bash
npm run build        # tsc + copy kernel.css
npm run typecheck
npm test             # unit + browser (playwright)
```

A published kernel version is what sites resolve against, so **bump the minor for anything
additive** and tag it (`git tag -a v0.x.0`, push the tag) — the builder clones by tag.
