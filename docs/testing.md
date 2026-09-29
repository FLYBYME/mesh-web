# Testing

Two rules, both learned the hard way:

- **Press, don't call.** A browser test clicks, types and presses keys through a real Chromium
  (Vitest browser mode, input over CDP). A test that calls `command.run()` or fires a handler
  directly proves nothing about the button — the part model once shipped buttons that rendered,
  looked enabled and did nothing, with every such test green.
- **Typecheck is part of the suite.** Vitest transpiles without typechecking, so `npm test` runs
  `tsc` first; type-level rules live in `*.types.ts` files full of `@ts-expect-error` that only
  the compiler runs (`test/app-model.types.ts`).

`mountPart` and the part-model test harness were deleted with the part model.

## Setup: one line

```ts
// vitest.browser.config.ts
import { definePartBrowserConfig } from '@flybyme/mesh-web/testing/config';
export default definePartBrowserConfig();
```

It resolves `@flybyme/mesh-web` to exactly one copy, runs a real Chrome rather than jsdom, and sizes
the viewport so a window is not clamped to nothing.

## Mounting an App

`mountSite` mounts the App as the single-page site the kernel would, on the real browser history:

```ts
import { mountSite, replace, type MountedApp } from '@flybyme/mesh-web';
import Console from '../src/app.js';
import { FakeApi } from '../src/api/fake-api.js';

class InstantApi extends FakeApi { override latency = 0; }

let site: MountedApp;
beforeEach(() => {
    history.pushState(null, '', '/domains');
    site = mountSite(Console, { root, replace: [replace(FakeApi, InstantApi)] });
});
afterEach(() => site.dispose());
```

Two ways to take the network out, depending on where the app talks to it:

- **`replace(Base, Substitute)`** constructs `Substitute` wherever `Base` is injected. The types
  require it to produce what `Base` does (a subclass, typically). Used by `examples/console`.
- **A stand-in capability**: `mountSite(App, { root, granted: { mesh, credentials } })` hands the
  runtime your own `mesh` object (`{ api, call(action, input) }`). Used by
  `surfdns-company-site/test/*.browser.test.ts`, which also records the headers each call went out
  with — how it proves a sign-in ticket is attached to the next call and not before.

`MountedApp` also gives the test `runtime.commands.live()` (which commands are live right now —
keys go with their owner) and `handlerCount()` (a number that only grows while someone uses the
page is a leak).

## Waiting

Loading is asynchronous even with a zero-latency fake. Wait for what a person would see:

```ts
await vi.waitFor(() => expect(rows()).toHaveLength(8), { timeout: 2000, interval: 10 });
```

`history.back()` is asynchronous too: wait for the `popstate` it causes.

## Where the examples are

- `test/browser/app-site.browser.test.ts` — routing, query state, layouts and a guard, titles.
- `examples/console/test/console.browser.test.ts` — a whole app clicked through.
- `surfdns-company-site/test/` — sign-in with a recorded ticket, the dashboard.
