/**
 * The adapter between the kernel's `windows` capability and the real window manager.
 *
 * It exists so the broker never imports the window manager. The kernel can then be booted with a
 * recording sink and no DOM — which is what most of its own tests do — and with the real manager in
 * a browser, without either knowing about the other.
 */

import type { Json } from '../description/types.js';
import type { WindowSink } from '../kernel/broker.js';
import type { ViewDecl } from '../contribution/contract.js';
import type { WindowManager } from './manager.js';

/**
 * `lookup` resolves a pid and a view id to that view's declaration, which is what carries the
 * default size, the minimum size and whether the window may be closed.
 *
 * A view opening under a name its Application never declared is a bug worth catching here rather
 * than rendering an empty window.
 */
export function windowSink(
    manager: WindowManager,
    lookup: (owner: string, view: string) => ViewDecl<never, never> | undefined,
): WindowSink {
    return {
        open(owner: string, view: string, params: Readonly<Record<string, Json>>): string {
            const decl = lookup(owner, view);
            if (decl === undefined) {
                throw new Error(
                    `${owner} opened view "${view}", which its Application does not declare. ` +
                    `Views are declared statically so the kernel knows them before start().`,
                );
            }

            const record = manager.open({
                owner,
                view,
                params,
                title: decl.title,
                // Read from the declaration at open time, like the sizes beside it — the manager
                // must not know what a view is.
                ...(decl.tile === undefined ? {} : { tile: decl.tile }),
                ...(decl.defaultSize ? { size: decl.defaultSize } : {}),
                ...(decl.minSize
                    ? { minSize: { width: decl.minSize.width ?? 0, height: decl.minSize.height ?? 0 } }
                    : {}),
                closable: decl.closable ?? true,
            });

            return record.id;
        },

        close: (id) => manager.close(id),
        focus: (id) => manager.focus(id),
        ownedBy: (owner) => manager.windows().filter((w) => w.owner === owner).map((w) => w.id),
        closeOwnedBy: (owner) => manager.closeOwnedBy(owner),

        // The chrome half. Reachable only through `needs('chrome')` — see the capability, which is
        // where the narrowing is decided. Everything here is a *projection* of the manager's records
        // rather than the records themselves, so what an outside author writes chrome against is a
        // stated shape and not whatever the manager happens to store this week.
        all: () => manager.stacked().map((w) => ({
            id: w.id,
            owner: w.owner,
            view: w.view,
            title: w.title,
            tile: w.tile,
            x: w.rect.x,
            y: w.rect.y,
            width: w.rect.width,
            height: w.rect.height,
            closable: w.closable,
        })),
        focused: () => manager.focused(),
        mode: () => manager.mode(),
        setMode: (mode) => { manager.setMode(mode); },
        move: (id, dx, dy) => { manager.move(id, dx, dy); },
        resize: (id, edge, dx, dy) => { manager.resize(id, edge, dx, dy); },
    };
}
