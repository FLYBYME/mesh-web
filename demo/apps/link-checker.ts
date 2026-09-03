/**
 * A headless Application.
 *
 * No views. No route. Nothing on screen. It runs, it does its work, and it is reached through its
 * API — which is why `views` is optional and why the earlier claim that "a destination that appears
 * nowhere is not a destination" was wrong. An Application is a process, and a daemon with no window
 * is an ordinary thing for an operating system to run (spec/application.md §1).
 *
 * Compare this file with the auth Extension. Both are small and neither renders. The difference is
 * that stopping this one leaves the system working, and stopping auth does not — which is the test
 * that decides which contract a thing should use.
 */

import {
    needs,
    consumes,
    provider,
    type Application,
    type Context,
} from '@flybyme/mesh-web';

import { BLOG, type BlogApi } from './blog.js';

const NEEDS = needs('net', 'state', 'log', 'notifications');
const CONSUMES = consumes(BLOG);

export interface BrokenLink {
    readonly postSlug: string;
    readonly href: string;
    readonly status: number;
}

export interface LinkCheckerApi {
    readonly broken: () => readonly BrokenLink[];
    readonly lastRun: () => number | null;
    checkNow(): Promise<void>;
}

export const LINK_CHECKER = provider<LinkCheckerApi>('demo.link-checker');

export default class LinkCheckerApp
    implements Application<typeof NEEDS, typeof CONSUMES, typeof LINK_CHECKER>
{
    readonly needs = NEEDS;
    readonly consumes = CONSUMES;
    readonly provides = LINK_CHECKER;

    // No `views`. That is the entire difference at the contract level.

    #timer: number | undefined;

    async start(cx: Context<typeof NEEDS, typeof CONSUMES>): Promise<LinkCheckerApi> {
        const blog: BlogApi = cx.use(BLOG);
        const broken = cx.state.signal<readonly BrokenLink[]>([]);
        const lastRun = cx.state.signal<number | null>(null);

        const checkNow = async (): Promise<void> => {
            const found: BrokenLink[] = [];

            for (const post of blog.posts()) {
                for (const href of hrefsIn(post.body)) {
                    try {
                        const result = await cx.net.get<{ status: number }>(
                            `/api/link-check?url=${encodeURIComponent(href)}`,
                        );
                        if (result.status >= 400) {
                            found.push({ postSlug: post.slug, href, status: result.status });
                        }
                    } catch (error) {
                        cx.log.warn(`link check failed for ${href}`, error);
                    }
                }
            }

            broken.set(found);
            lastRun.set(Date.now());

            if (found.length > 0) {
                cx.notifications.warn(`${found.length} broken link(s) found.`);
            }
        };

        /**
         * A timer, and no scheduling guarantee.
         *
         * A tab has one thread and there is no preemption — "process" here is bookkeeping, not
         * enforcement (spec/kernel.md §6). This gets no priority over the foreground Application
         * and must not assume it will be woken on time.
         */
        this.#timer = window.setInterval(() => void checkNow(), 15 * 60 * 1000);

        void checkNow();

        return { broken, lastRun, checkNow };
    }

    async stop(): Promise<void> {
        // This one genuinely has something to clean up: a timer the kernel did not hand out and
        // therefore cannot dispose. Anything obtained through a capability is not the
        // Application's problem; anything obtained from the platform directly is.
        if (this.#timer !== undefined) window.clearInterval(this.#timer);
    }
}

function hrefsIn(html: string): readonly string[] {
    return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}
