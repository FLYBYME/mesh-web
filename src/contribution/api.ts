/**
 * **What a part offers other parts.**
 *
 * `provides` used to be `ProviderToken<unknown>` and the type behind it was whatever the author
 * felt like, so a consumer of one part and a consumer of another had nothing in common and the
 * answer to *how do I call this* was *read the source*. Three failures came out of that, and the
 * third is the one that matters:
 *
 * 1. **A richer implementation cannot publish what it adds.** `mesh-core`'s auth replaced
 *    `mesh-web`'s under the same `AUTH` token and added `selectOrganization`. The token is typed
 *    `ProviderToken<AuthApi>` against the *declaring* interface, so that method was unreachable
 *    through the token no matter which implementation was mounted.
 * 2. **A poorer one cannot be detected.** Satisfy the three members and the type is happy.
 * 3. **Nothing can be enumerated at run time.** A TypeScript interface is erased, so neither a
 *    generated client nor a tool caller can ask what a part offers.
 *
 * So a part publishes exactly three things, and the shape is the same for every part in the system.
 *
 * ## Read is a value. Write is a command.
 *
 * `state` is `ReadonlySignal`, never `Signal`. A consumer must be able to observe a change and must
 * not be able to cause one except by calling something that says what it does. This is not tidiness:
 * anything published is reachable by a tool caller, and `PeopleApi` shipped
 * `newAccountPassword: Signal<string>` — a password buffer, publicly readable and writable by any
 * part holding the token.
 *
 * ## Declared statically, bound at start
 *
 * The same split the server has had all along: a contract is static, a handler is runtime.
 * `Declarations.publishes` is readable before anything runs — which is what a review, a tool caller
 * or a generated client wants — and `start()` returns the bindings. The kernel refuses a part whose
 * declared command has no implementation, because a declaration nothing implements is worse than an
 * absent one: it advertises.
 *
 * (`Declarations.commands` is a different list and stays what it was: palette entries and key
 * bindings. A part may declare a palette command that calls a published one, or either alone.)
 */

import type { ReadonlySignal } from '../reactivity/types.js';

/** Imported as a type alias so this file does not depend on the description layer's runtime. */
type DescriptionNode = import('../description/types.js').Node;

// ---------------------------------------------------------------------------- schemas

/**
 * **A schema is a compile-time shape and, optionally, run-time data. It is never a validator.**
 *
 * This package has no runtime dependencies and does not acquire one here. `ApiCall` in `net/api.ts`
 * already settled the pattern for exactly this problem — a phantom `types?` member that is *"never
 * assigned, present only so the compiler carries the shapes"* — and reaching for zod would give the
 * kernel its first dependency in order to re-solve a solved problem.
 *
 * `json` is separate and optional, because the two jobs are different. The phantom type checks the
 * caller at build time. The JSON Schema describes the call to something that cannot be type-checked
 * at all — a tool caller, a generated form, a person reading what a part offers. The server already
 * publishes exactly this on `ExposedContract.input`, described there as *"JSON Schema, as published.
 * Enough to build a form from without inventing one."*
 *
 * A part with no `json` still type-checks and still runs. It is simply not describable, and
 * therefore not callable by anything that reads rather than compiles.
 */
export interface Schema<T> {
    /** Never assigned. Present only so the compiler carries the shape. */
    readonly type?: T;
    /** JSON Schema, for readers that cannot compile: tool callers, generated forms, review. */
    readonly json?: Json;
}

type Json = import('../description/types.js').Json;

/** Declares a shape without a runtime cost. `schema<{ id: string }>()` carries the type and nothing else. */
export function schema<T>(json?: Json): Schema<T> {
    return json === undefined ? {} : { json };
}

// ---------------------------------------------------------------------------- availability

/**
 * **Whether a thing may be done right now, and if not, which standing is missing.**
 *
 * Carried as data rather than a boolean because a refusal has to be *rendered*: `spec/ui/states.md`
 * §4 requires a control that stays visible, disabled, and labelled with what is missing. A boolean
 * can only produce a control that is absent or dead, and both of those lie about a working platform.
 */
export type Availability =
    | { readonly can: true }
    | {
        readonly can: false;
        readonly why: 'not_exposed' | 'needs_session' | 'needs_operator' | 'not_ready';
        /** Optional detail for the label: which role, which gate. Never a stack trace. */
        readonly detail?: string;
    };

export const AVAILABLE: Availability = { can: true };

// ---------------------------------------------------------------------------- commands

/**
 * **A command is a contract: what it is called, what it does, what it takes, what it answers.**
 *
 * `available()` lives *on* the command and not beside it. `PeopleApi` had five `*Availability()`
 * methods sitting parallel to five commands, kept in sync by hand and by memory. Folded in, a
 * command cannot exist without an availability answer — which is roadmap U3 solved by shape rather
 * than by asking every author to remember a rule.
 */
export interface CommandContract<I = void, O = void> {
    readonly action: string;

    /**
     * What it does and what it changes, in a sentence.
     *
     * Read by people, and by tool callers deciding whether this is the thing to call. *"Adds a
     * person to an organization with a role"* is useful; *"addMembership"* restated is not.
     */
    readonly description: string;

    readonly input: Schema<I>;
    readonly output: Schema<O>;

    /**
     * Whether it may be called right now.
     *
     * Declared, so a screen can render the refusal before anybody clicks, and a tool caller can be
     * told *why* rather than receiving an error it cannot interpret.
     */
    available(): Availability;

    /**
     * A write a person must agree to, per `spec/ui/rules.md` §7.
     *
     * On the command rather than on the button, because the same command reached from a palette, a
     * keyboard binding or a tool call must confirm identically. A confirmation that lives on one
     * control protects one path.
     */
    readonly confirm?: ConfirmDecl;
}

export interface ConfirmDecl {
    /** What the person is agreeing to. Names the consequence, not the verb. */
    readonly message: string;
    /**
     * Whether a human must be the one to agree.
     *
     * `true` means an agent-raised intent cannot satisfy this confirmation — see `actor` on the
     * description layer's intents. Every irreversible write should set it: otherwise the mechanism
     * that automates the UI is the same mechanism that defeats the check protecting it.
     */
    readonly requiresUser?: boolean;
}

/** A declared command with its implementation attached. What `start()` returns. */
export interface BoundCommand<I = void, O = void> extends CommandContract<I, O> {
    run(input: I): Promise<O>;
}

// ---------------------------------------------------------------------------- components

/**
 * **A component has no logic. A composite has state.**
 *
 * The distinction is not stylistic and it was measured: `PeopleApi` carried twelve orphaned form
 * buffers — `newOrgId`, `newRoleKey`, `newAccountEmail`, `newOrgSlug` and the rest — which exist,
 * have to live somewhere, and were public only because there was no *somewhere*. A composite is a
 * component with a reason to hold state, and those twelve are the reason.
 *
 * Neither may touch the DOM. A part that genuinely needs an element — a canvas, an editor — is
 * asking for a **driver**, which is bundled into the kernel artifact and is not this.
 */
export interface ComponentContract<P = void> {
    readonly name: string;
    readonly description: string;
    readonly props: Schema<P>;
    render(props: P): DescriptionNode;
}

/**
 * A composite: created per use, owns state for as long as it is mounted, and renders itself.
 *
 * `create` returns the state alongside `view` so the consumer can read what the composite knows —
 * a form's validity, whether it is running — without the composite having to publish it separately.
 */
export interface CompositeContract<P = void, S = unknown> {
    readonly name: string;
    readonly description: string;
    readonly props: Schema<P>;
    create(props: P): S & { view(): DescriptionNode };
}

export type BoundComponent<P = void> = ComponentContract<P> | CompositeContract<P, unknown>;

/**
 * **The erased forms, for the places that hold many contracts of different shapes.**
 *
 * `unknown` rather than `never`, and the difference is not cosmetic. `ViewDecl` gets away with
 * `never` because its only varying member is `render`, a **method** — and methods are bivariant, so
 * a concrete view stays assignable. A command's `input: Schema<I>` is a **property**, which is
 * invariant, so `never` there rejects every real command instead of accepting all of them.
 *
 * `Schema<T>` carries `T` only in an optional readonly phantom member, so `Schema<Anything>` is
 * assignable to `Schema<unknown>` and the erasure is sound. `run` is a method and survives on
 * bivariance the same way `render` does.
 *
 * This was found by the type-checker on the first real use, which is the argument for having written
 * the test before the second one.
 */
export type AnyCommand = CommandContract<unknown, unknown>;
export type AnyBoundCommand = BoundCommand<unknown, unknown>;
export type AnyComponent = ComponentContract<unknown> | CompositeContract<unknown, unknown>;
export type AnyBoundComponent = AnyComponent;

// ---------------------------------------------------------------------------- the published api

/**
 * **What every part publishes. Three slots, the same three for everything.**
 *
 * The point is that a consumer — a person, another part, a generated client, a tool caller — knows
 * where to look without knowing which part it is holding. *How do I call a command, get a component,
 * read state* has one answer everywhere.
 *
 * A part that publishes nothing declares no `provides` and has no `PartApi` at all. Empty slots are
 * for a part that publishes *some* of the three, which is the ordinary case.
 */
export interface PartApi {
    readonly commands: Readonly<Record<string, AnyBoundCommand>>;
    readonly components: Readonly<Record<string, AnyBoundComponent>>;
    /** Observable, never writable. See the header: anything published is tool-reachable. */
    readonly state: Readonly<Record<string, ReadonlySignal<unknown>>>;
}

/** The static half, readable before anything starts. Lives on `Declarations`. */
export interface ApiDecl {
    readonly commands?: readonly AnyCommand[];
    readonly components?: readonly AnyComponent[];
    readonly state?: readonly StateContract<unknown>[];
}

export interface StateContract<T = unknown> {
    readonly name: string;
    readonly description: string;
    readonly schema: Schema<T>;
}

/**
 * Check that what `start()` bound matches what the manifest declared.
 *
 * Called by the kernel before a part is usable. A declared command with no binding is refused rather
 * than warned about: the declaration is what a consumer reads and what a tool caller enumerates, so
 * an unimplemented one is not an omission, it is an advertisement for something that is not there.
 *
 * The reverse — binding something undeclared — is refused for the same reason from the other side:
 * a surface nobody can discover is a surface nobody can review.
 */
export function checkBindings(declared: ApiDecl, bound: PartApi | undefined, source: string): void {
    const problems: string[] = [];
    const boundCommands = new Set(Object.keys(bound?.commands ?? {}));
    const boundComponents = new Set(Object.keys(bound?.components ?? {}));
    const boundState = new Set(Object.keys(bound?.state ?? {}));

    for (const c of declared.commands ?? []) {
        if (!boundCommands.delete(c.action)) problems.push(`command "${c.action}" is declared and not bound`);
    }
    for (const c of declared.components ?? []) {
        if (!boundComponents.delete(c.name)) problems.push(`component "${c.name}" is declared and not bound`);
    }
    for (const s of declared.state ?? []) {
        if (!boundState.delete(s.name)) problems.push(`state "${s.name}" is declared and not bound`);
    }

    for (const name of boundCommands) problems.push(`command "${name}" is bound and not declared`);
    for (const name of boundComponents) problems.push(`component "${name}" is bound and not declared`);
    for (const name of boundState) problems.push(`state "${name}" is bound and not declared`);

    if (problems.length > 0) {
        throw new Error(`${source}: published API does not match its manifest.\n  ${problems.join('\n  ')}`);
    }
}
