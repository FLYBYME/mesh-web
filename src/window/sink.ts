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

            /**
             * `instances: 'one'` means **one window for this view, not one per open call.**
             *
             * The field was declared on `ViewDecl` and read by nothing, so every open produced
             * another window: a "Notes Overview" button opened a fourth, fifth and sixth Notes
             * Overview, each identical, stacked on the last. An Application cannot fix that itself
             * without tracking its own windows, which is precisely the bookkeeping the window
             * manager exists to own.
             *
             * Focus rather than ignore, because the caller asked to *see* the view. Silently doing
             * nothing would make the button look broken for the opposite reason.
             */
            if (decl.instances === 'one') {
                const already = manager.windows().find((w) => w.owner === owner && w.view === view);
                if (already !== undefined) {
                    manager.focus(already.id);
                    return already.id;
                }
            }

            const record = manager.open({
                owner,
                view,
                params,
                title: decl.title,
                /**
                 * Read from the declaration at open time — the manager must not know what a view is.
                 *
                 * All of it comes from `decl.window`, which is where window furniture lives now.
                 * It used to be four fields at the top level of `ViewDecl`, which made a view
                 * declare pixels and split-tree nodes it has no business knowing about; **this is
                 * the only code in the kernel that reads them**, which is what made moving them
                 * cheap and what proves they were in the wrong place.
                 */
                ...(decl.window?.tile === undefined ? {} : { tile: decl.window.tile }),
                ...(decl.window?.defaultSize ? { size: decl.window.defaultSize } : {}),
                ...(decl.window?.minSize
                    ? {
                        minSize: {
                            width: decl.window.minSize.width ?? 0,
                            height: decl.window.minSize.height ?? 0,
                        },
                    }
                    : {}),
                closable: decl.window?.closable ?? true,
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
