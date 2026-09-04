/**
 * The auth Extension.
 *
 * Exported, not installed. spec/extension.md §7 puts it under **site-supplied**: a site decides
 * whether it has accounts at all, and a blog that signs nobody in should not be carrying a session.
 * A site that wants one declares `new AuthExtension(...)` in its manifest like any other Extension.
 */

export * from './extension.js';
