// GENERATED FILE — do not edit.
//
// Emitted from demo.blog's exposure descriptor by @flybyme/mesh-api.
// Exposure: sha256:ee06c4d73f2857e38cd68fa5df39a141
//
// Regenerate rather than editing. The exposure hash above is checked at run time against
// the one the API reports, so a hand-edited client is a client that lies about a surface
// nobody can verify (mesh-web spec/network.md section 6).

import { call, defineApi } from '@flybyme/mesh-web';

export interface PostCreateInput {
    readonly title: string;
}

export interface PostCreateOutput {
    /** The post’s stable id */
    readonly slug: string;
    readonly title: string;
    readonly published: boolean;
    /** Which organization owns it */
    readonly organizationId: string;
}

export interface PostListInput {
    readonly includeDrafts?: boolean;
}

export interface PostListOutputItem {
    /** The post’s stable id */
    readonly slug: string;
    readonly title: string;
    readonly published: boolean;
    /** Which organization owns it */
    readonly organizationId: string;
}

export interface PostListOutput {
    readonly items: readonly PostListOutputItem[];
    readonly organization: string;
}

export interface PostPublishInput {
    readonly slug: string;
}

export interface PostPublishOutput {
    /** The post’s stable id */
    readonly slug: string;
    readonly title: string;
    readonly published: boolean;
    /** Which organization owns it */
    readonly organizationId: string;
}

export const blogApi = defineApi({
    id: "demo.blog",
    exposure: "sha256:ee06c4d73f2857e38cd68fa5df39a141",
    base: "/api",
    calls: {
        /**
         * Start a new draft.
         *
         * POST /post — permission: post.write, destructive
         */
        "post.create": call<PostCreateInput, PostCreateOutput, "title_taken">("POST", "/post"),
        /**
         * Every post in the calling organization.
         *
         * GET /post — auth: user
         */
        "post.list": call<PostListInput, PostListOutput, never>("GET", "/post"),
        /**
         * Publish or unpublish a post.
         *
         * POST /post/publish — permission: post.write, destructive
         */
        "post.publish": call<PostPublishInput, PostPublishOutput, "not_found">("POST", "/post/publish"),
    },
});
