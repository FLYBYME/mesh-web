/**
 * What the window layer mounts in a window — its own contract, not an authoring surface.
 *
 * App code never writes one of these. An App's routes are views (`src/app/units.ts`), and the
 * desktop (`src/app/desktop.ts`) hands the shell one `WindowView` per route whose `render` mounts
 * that route's view through the runtime. This is the narrow seam between the two: what a window is
 * called, the hints for its frame, and a function from the window's context to a description.
 *
 * It replaces the part model's `ViewDecl` / `ViewContext`, which were the authoring surface — and
 * carried an Application's `internal` and published `app`, so every view could reach its whole
 * process's state. None of that is here: a window knows its params and its handler table, and the
 * view it shows gets everything else from the runtime.
 */

import type { Action, IntentValue, Json, Node, Registrar } from '../description/types.js';

export interface WindowView {
    readonly id: string;
    readonly title: string;
    /** Hints for a frame that draws windows. Every field is a suggestion. */
    readonly window?: {
        readonly tile?: string;
        readonly defaultSize?: { readonly width?: number; readonly height?: number };
        readonly minSize?: { readonly width?: number; readonly height?: number };
        readonly closable?: boolean;
    };
    render(vx: WindowViewContext): Node;
}

/** What one window gives what it shows. */
export interface WindowViewContext {
    readonly windowId: string;
    /** What the window was opened with — for a desktop route, the route's raw params. */
    readonly params: Readonly<Record<string, Json>>;
    /** Register a closure for an intent in this window's handler table. */
    readonly on: Registrar;
    /** Forget one — so something shorter-lived than the window can give its handlers back. */
    off(action: Action): void;
    setTitle(title: string): void;
    close(): void;
    onDispose(fn: () => void): void;
}

export type { IntentValue };
