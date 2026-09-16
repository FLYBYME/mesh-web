# Testing Framework

`@flybyme/mesh-web/testing` provides utilities for testing Applications, Extensions, and components in both headless Node environments and real browser engines (via Vitest & Playwright).

---

## 1. Mounting Parts in a Browser ([`mountPart`](file:///home/ubuntu/code/mesh-web/src/testing/mount.ts#L82))

The primary testing utility is [`mountPart`](file:///home/ubuntu/code/mesh-web/src/testing/mount.ts#L82). It boots a part using the real [`start(composition)`](file:///home/ubuntu/code/mesh-web/src/kernel/start.ts#L159) bootloader, guaranteeing high fidelity:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mountPart, cleanup } from '@flybyme/mesh-web/testing';
import CounterApp from '../src/counter.app.js';

describe('Counter Application', () => {
    afterEach(() => {
        cleanup(); // Automatically unmounts and disposes active sites
    });

    it('renders the initial count and increments on click', async () => {
        const site = await mountPart({
            id: 'counter',
            contribution: CounterApp,
            open: [{ application: 'counter', views: ['main'] }],
        });

        // Wait for async start() to complete:
        await site.ready;

        // Verify framework singleton integrity:
        site.assertSingleFramework();

        // Inspect DOM:
        const button = site.root.querySelector('button');
        expect(button?.textContent).toBe('+1');

        button?.click();
        expect(site.root.textContent).toContain('Count: 1');
    });
});
```

### The `MountedSite` Interface ([`src/testing/mount.ts`](file:///home/ubuntu/code/mesh-web/src/testing/mount.ts#L29))

`mountPart` returns a [`MountedSite`](file:///home/ubuntu/code/mesh-web/src/testing/mount.ts#L29) object giving tests complete access to internal subsystems:

```ts
export interface MountedSite extends Started {
    /** The DOM container element the site mounted into. */
    readonly root: Element;
    /** All URLs under which @flybyme/mesh-web was evaluated. */
    readonly frameworkInstances: readonly string[];
    /** Asserts that exactly one copy of @flybyme/mesh-web was evaluated. */
    assertSingleFramework(): void;
    assertSingleKernel(): void;
}
```

---

## 2. Framework Singleton Assertion

If a Vite configuration or import map fails to deduplicate `@flybyme/mesh-web`, multiple module graphs execute concurrently. This duplicates reactivity contexts and capability registries, causing silent synchronization bugs.

Every part test should verify singleton execution:

```ts
it('loads exactly one copy of the framework', async () => {
    const site = await mountPart(MyExtension);
    site.assertSingleFramework();
});
```

If multiple URLs evaluated `@flybyme/mesh-web`, it throws with the full list of distinct module URLs:
```
Framework singleton violation: @flybyme/mesh-web was evaluated 2 times under multiple URLs:
  - http://localhost:5173/node_modules/@flybyme/mesh-web/dist/index.js
  - http://localhost:5173/src/vendor/mesh-web/dist/index.js
```

---

## 3. Configuring Vitest for Browser Testing ([`src/testing/config.ts`](file:///home/ubuntu/code/mesh-web/src/testing/config.ts))

To test in real browser engines (Chromium, Firefox, or WebKit) using Playwright, export [`definePartBrowserConfig`](file:///home/ubuntu/code/mesh-web/src/testing/config.ts#L13) in your `vitest.browser.config.ts`:

```ts
import { definePartBrowserConfig } from '@flybyme/mesh-web/testing/config';

export default definePartBrowserConfig({
    browser: 'chromium',
    headless: true,
});
```

---

## 4. Headless Unit Testing Patterns

When testing parts in non-DOM unit test environments (e.g. standard Node test runs), use the kernel's recording sinks:

### Recording Windows without a DOM ([`recordingWindows`](file:///home/ubuntu/code/mesh-web/src/kernel/broker.ts#L187))
```ts
import { Kernel, createServices, recordingWindows } from '@flybyme/mesh-web';

const sink = recordingWindows();
const services = createServices(sink);
const kernel = new Kernel({ services });

kernel.boot([/* loaded parts */]);
await kernel.start('my-app');

// Inspect opened windows without DOM:
expect(sink.opened).toHaveLength(1);
expect(sink.opened[0].view).toBe('main');
```

### Mocking User Confirmations
```ts
const services = createServices(undefined, {
    // Automatically accept confirmations in automated test suites:
    confirm: async (request) => {
        expect(request.message).toContain('Are you sure?');
        return true;
    }
});
```
