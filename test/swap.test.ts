import { describe, expect, it } from 'vitest';
import { RENDERER, type Renderer, type RendererOptions, type Mounted } from '../src/render/index.js';
import { Kernel } from '../src/kernel/kernel.js';
import { text } from '../src/description/build.js';
import type { Node } from '../src/description/types.js';
import { mountView } from '../src/window/host.js';
import type { WindowManager } from '../src/window/manager.js';

describe('A8.18 renderer swap', () => {
    it('mounts a part against an in-memory renderer', () => {
        const renders: Node[] = [];
        const inMemoryRenderer: Renderer = {
            render(description: Node, host: unknown, options: RendererOptions): Mounted {
                renders.push(description);
                return { dispose: () => {} };
            }
        };

        const kernel = new Kernel();
        kernel.provide(RENDERER, inMemoryRenderer);

        const resolved = kernel.provided(RENDERER)!;
        expect(resolved).toBe(inMemoryRenderer);

        const t = text('Hello from swapped renderer');
        
        mountView(null as any, {
            windowId: 'w1',
            decl: { render: () => t } as any,
            api: {},
            params: {},
            windows: {} as WindowManager,
            resolve: <T>(token: any) => kernel.provided(token),
            renderOptions: { dispatch: { dispatch: () => {} } },
            onCommand: () => {},
        });

        expect(renders).toContain(t);
    });
});
