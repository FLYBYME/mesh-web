# @flybyme/mesh-web

The web half of the mesh framework: an abstract operating system in a browser, and the builder and
CDN that serve it.

**Start with [`spec/status.md`](./spec/status.md)** — what exists, what was decided, and what is
open. Then [`spec/roadmap.md`](./spec/roadmap.md) — the checklist for the UI framework, the CDN and
the API, ordered, with what blocks what.

| | |
|---|---|
| **mesh** | the framework — services, contracts, broker, registry |
| **mesh-api** | the gatekeeper: mesh constructs turned into interfaces — REST, SSE, MCP |
| **mesh-identity** | people, credentials, tickets, roles. The only thing that issues. Not built. |
| **mesh-web** | the browser framework, the builder, the CDN |

This package was `@flybyme/mesh-api/runtime` until those parts were separated. The browser runtime is
the same code, moved, plus the contribution layer.

**mesh-web is two things**, and only the first exists today: a browser framework, and a server
process running its own HTTP server. See [`spec/hosting.md`](./spec/hosting.md) §1. The rule below
about node builtins applies to the browser half; the server half will be a peer of it with its own
build, and the two never import each other's internals.

## What is here

```
src/
  reactivity/     signals, computeds, effects, resources, scopes
  dom/            h(), control flow, bindings, 13 components + their CSS
  router/         routing, scoped routers, views, scroll and focus restoration
  manifest/       the manifest schema, validation, merge, layout policy
  app/            the app host, compositor, instance lifecycle, surfaces
  events/         the SSE event-bridge client
  contribution/   Applications, Extensions, and the capabilities they declare
  schema.ts       zod introspection, shared with mesh-api's exposure layer
  session.ts      the session shape the browser sees
```

## Applications and Extensions

Two contracts over one runtime.

An **Application** is a destination — routes, screens, windows. The console, a blog, an IDE. Several
are loaded at once.

An **Extension** is a capability contributed to whatever is running — commands, menus, views,
providers. Auth, logging, source control. It has no route, activates once, and spans every
Application. The workbench is an Extension like any other.

**A bundle exports a class. The host constructs it.**

```ts
export default class AuthExtension implements Extension<['net', 'notifications'], AuthApi> {
    readonly needs = ['net', 'notifications'] as const;

    activate(cx: CapabilityContext<['net', 'notifications']>): AuthApi {
        cx.net.baseUrl;              // declared
        cx.notifications.info('hi'); // declared
        cx.windows.open({ ... });    // compile error: not declared
        return { session: cx.state.signal<Session | null>(null) };
    }
}
```

There is no `defineExtension()` and no registry, deliberately. That pattern is how *mesh contracts*
work and it is right there — a contract is a global declaration, there is one of each, and importing
the file is the act of declaring it. None of that is true of a screen, and copying it across bought
three problems: importing a bundle became a side effect, so a host could not inspect one before
trusting it; one definition meant one instance, which a window manager whose point is two chart
windows cannot use; and identity came from the code rather than from the manifest that asked for it.

The mesh is the network. It is not a model for how a page is put together.

Capability narrowing is the other half of the design, and it is checked in CI:
`test/contribution/contract.test.ts` asserts with `@ts-expect-error` that an undeclared capability is
not on the context. Removing one of those directives produces
`Property 'notifications' does not exist on type 'CapabilityContext<readonly ["net", "commands"]>'`,
so the assertions fail the build if the narrowing ever widens.

The reason it matters: the previous generation handed every extension a `Shell` object carrying
`layout, activityBar, tabs, docking, transport`, so every extension was implicitly an extension *of
an IDE* — a blog written against it still received a docking system. Declaring capabilities is what
lets one contributor run unchanged whether the host arranges windows as tiles, as floating windows,
or as a single maximised page.

## Status

The runtime is complete and in use. The contribution layer is **declarations**: the Application and
Extension contracts and the capability interfaces are settled, and only `state` is implemented.
`net`, `events`, `commands`, `keys`, `menus`, `notifications`, `models` and `windows` are being
built. They are written down first because a capability whose shape is decided after its consumers
exist is a capability shaped by whoever called it first.

The window manager, the registry, the builder and the CDN are design only. So is mesh-identity.
[`spec/status.md`](./spec/status.md) §2 lists what is code, what is design, and the six things
already known to be wrong in the code against the specs — including that `Application.surfaces`
should be optional, since a headless Application is a background process.

## Rules

- Nothing in `src` may import a node builtin, express, or anything else that cannot run in a tab.
  `tsconfig.json` sets `types: []` so that is a compile error, and CI checks it again.
- The browser never joins the mesh. It speaks HTTP to a node's API. Running a `MeshApp` with a
  WebSocket transport in a tab makes every browser a peer on the cluster network, and that is not a
  thing this package will do.

## Commands

```bash
npm run typecheck   # src, test and apps
npm run build       # tsc + copy component CSS into dist/
npm test            # vitest
```
