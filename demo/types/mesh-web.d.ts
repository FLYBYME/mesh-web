/**
 * @flybyme/mesh-web — declarations only.
 *
 * There is no implementation behind any of this. It exists so the demo under `demo/` typechecks
 * and so an editor gives real completion and real errors while reading it.
 *
 * Everything here follows spec/kernel.md, spec/extension.md and spec/application.md. Where the
 * spec has not decided something, this file picks the smallest thing that lets the demo be
 * written, and demo/README.md lists every one of those.
 */

declare module '@flybyme/mesh-web' {
    // ---------------------------------------------------------------- reactivity

    export interface Signal<T> {
        (): T;
        set(value: T): void;
        update(fn: (previous: T) => T): void;
    }

    export interface Resource<T> {
        (): T | undefined;
        readonly loading: () => boolean;
        readonly error: () => Error | undefined;
        refetch(): void;
    }

    // ---------------------------------------------------------------- dom

    export type Child =
        | string | number | boolean | null | undefined
        | Node
        | (() => Child)
        | readonly Child[];

    export interface Props {
        readonly class?: string | (() => string);
        readonly id?: string;
        readonly style?: string | Record<string, string>;
        readonly onclick?: (e: MouseEvent) => void;
        readonly oninput?: (e: Event) => void;
        readonly onsubmit?: (e: SubmitEvent) => void;
        readonly [attr: string]: unknown;
    }

    export function h(tag: string, props?: Props | null, ...children: Child[]): HTMLElement;

    /** Render `child` only while `when` is true. */
    export function when(cond: () => boolean, child: () => Child): Child;

    /** Render one node per item, keyed, without rebuilding the list. */
    export function each<T>(items: () => readonly T[], render: (item: T, index: () => number) => Child): Child;

    // ---------------------------------------------------------------- capabilities

    export interface ContractRef<TInput, TOutput> {
        readonly domain: string;
        readonly action: string;
        readonly __in?: TInput;
        readonly __out?: TOutput;
    }

    export interface EventRef<TPayload> {
        readonly name: string;
        readonly __payload?: TPayload;
    }

    export interface Net {
        readonly baseUrl: string;
        call<TIn, TOut>(contract: ContractRef<TIn, TOut>, input: TIn): Promise<TOut>;
        get<T>(path: string): Promise<T>;
        post<T>(path: string, body: unknown): Promise<T>;
        /** A GET whose result is a signal: undefined until it resolves, never blocking paint. */
        resource<T>(path: () => string): Resource<T>;
    }

    export interface Events {
        on<T>(event: EventRef<T>, handler: (payload: T) => void): void;
        /** Subscribe by name when there is no typed reference to hand. */
        onNamed(event: string, handler: (payload: unknown) => void): void;
    }

    export interface CommandDefinition<TArgs extends readonly unknown[] = readonly []> {
        readonly id: string;
        readonly title: string;
        readonly handler: (...args: TArgs) => void | Promise<void>;
    }

    export interface Commands {
        register<TArgs extends readonly unknown[]>(command: CommandDefinition<TArgs>): void;
        run(id: string, ...args: readonly unknown[]): Promise<void>;
    }

    export interface Keys {
        bind(binding: string, commandId: string): void;
    }

    export type MenuTarget = 'menubar' | 'window' | 'status' | `context:${string}`;

    export interface Menus {
        add(target: MenuTarget, item: { readonly title: string; readonly command: string; readonly group?: string }): void;
    }

    export interface NotificationHandle {
        update(message: string): void;
        dismiss(): void;
    }

    export interface Notifications {
        info(message: string): NotificationHandle;
        warn(message: string): NotificationHandle;
        error(message: string, error?: unknown): NotificationHandle;
        progress(message: string): NotificationHandle;
    }

    export interface WindowHandle {
        readonly id: string;
        focus(): void;
        close(): void;
    }

    export interface Windows {
        open(options: { readonly view: string; readonly params?: Record<string, unknown> }): WindowHandle;
        close(id: string): void;
        /** Windows this contributor owns. */
        readonly own: () => readonly WindowHandle[];
    }

    /** Namespaced to the contributor, and async because a provider may be remote. */
    export interface ScopedStorage {
        get<T>(key: string): Promise<T | undefined>;
        set<T>(key: string, value: T): Promise<void>;
        remove(key: string): Promise<void>;
        /** A read as a signal: `undefined` until the provider answers. */
        signal<T>(key: string): Signal<T | undefined>;
    }

    export interface Log {
        debug(message: string, data?: unknown): void;
        info(message: string, data?: unknown): void;
        warn(message: string, data?: unknown): void;
        error(message: string, error?: unknown): void;
    }

    export interface State {
        signal<T>(initial: T): Signal<T>;
        computed<T>(fn: () => T): () => T;
        effect(fn: () => void): void;
    }

    export interface CapabilityMap {
        readonly net: Net;
        readonly events: Events;
        readonly commands: Commands;
        readonly keys: Keys;
        readonly menus: Menus;
        readonly notifications: Notifications;
        readonly windows: Windows;
        readonly storage: ScopedStorage;
        readonly log: Log;
        readonly state: State;
    }

    export type CapabilityName = keyof CapabilityMap;

    // ---------------------------------------------------------------- declaring

    /**
     * Declare the capabilities a contributor needs.
     *
     * A rest parameter with a `const` type parameter, so the literal tuple survives without
     * `as const` and the editor completes capability names inside the call.
     */
    export function needs<const T extends readonly CapabilityName[]>(...names: T): T;

    /** Declare the provider tokens a contributor may `use`. */
    export function consumes<const T extends readonly ProviderToken<unknown>[]>(...tokens: T): T;

    // ---------------------------------------------------------------- providers

    declare const PROVIDED: unique symbol;

    export interface ProviderToken<T> {
        readonly id: string;
        /** Phantom. Carries T across a boundary neither side imports over. */
        readonly [PROVIDED]?: T;
    }

    export function provider<T>(id: string): ProviderToken<T>;

    export type Provided<TToken> = TToken extends ProviderToken<infer T> ? T : never;

    export interface Consumer<TConsumes extends readonly ProviderToken<unknown>[]> {
        use<TToken extends TConsumes[number]>(token: TToken): Provided<TToken>;
    }

    // ---------------------------------------------------------------- context

    export interface ContributionBase {
        /** Kernel-assigned. Not the id in the bundle. */
        readonly id: string;
        onDispose(fn: () => void): void;
    }

    export type CapabilityContext<TNeeds extends readonly CapabilityName[]> = ContributionBase & {
        readonly [K in TNeeds[number]]: CapabilityMap[K];
    };

    export type Context<
        TNeeds extends readonly CapabilityName[],
        TConsumes extends readonly ProviderToken<unknown>[] = readonly [],
    > = CapabilityContext<TNeeds> & Consumer<TConsumes>;

    // ---------------------------------------------------------------- views

    export interface ViewContext<TParams = Record<string, never>, TApi = void> {
        readonly params: TParams;
        /**
         * The Application's own API — whatever `start()` returned.
         *
         * Present, not optional, because a view mounts only after `start()` resolves. That is what
         * lets an Application declare views statically without holding half-initialised fields
         * for them to read.
         */
        readonly app: TApi;
        setTitle(title: string): void;
        close(): void;
        onDispose(fn: () => void): void;
    }

    export interface ViewDecl<TId extends string = string, TParams = Record<string, never>, TApi = void> {
        readonly id: TId;
        readonly title: string;
        /** Which named node of the layout's split tree, in tiled mode. Ignored when windowed. */
        readonly tile?: string;
        readonly instances?: 'one' | 'many';
        readonly closable?: boolean;
        readonly default?: {
            readonly width?: number;
            readonly height?: number;
            readonly minWidth?: number;
            readonly minHeight?: number;
        };
        mount(el: HTMLElement, vx: ViewContext<TParams, TApi>): void;
    }

    /** Declares a view type. `const` so the id survives as a literal. */
    export function view<const T extends ViewDecl<string, never, never>>(decl: T): T;
    export function view<TParams, TApi, const T extends ViewDecl<string, TParams, TApi>>(decl: T): T;

    /** The API an Application exposes, derived from its `provides` token. */
    export type ApiOf<TProvides> = TProvides extends ProviderToken<infer TApi> ? TApi : void;

    // ---------------------------------------------------------------- contracts

    export interface Extension<
        TNeeds extends readonly CapabilityName[],
        TConsumes extends readonly ProviderToken<unknown>[] = readonly [],
        TProvides extends ProviderToken<unknown> | undefined = undefined,
    > {
        readonly needs: TNeeds;
        readonly consumes?: TConsumes;
        readonly provides?: TProvides;
        /** Called once. Never deactivated — see spec/extension.md §6. */
        activate(cx: Context<TNeeds, TConsumes>): TProvides extends ProviderToken<infer TApi> ? TApi : void;
    }

    export interface Application<
        TNeeds extends readonly CapabilityName[],
        TConsumes extends readonly ProviderToken<unknown>[] = readonly [],
        TProvides extends ProviderToken<unknown> | undefined = undefined,
    > {
        readonly needs: TNeeds;
        readonly consumes?: TConsumes;
        readonly provides?: TProvides;
        /** Optional. A headless Application is a background process. */
        readonly views?: readonly ViewDecl<string, never, ApiOf<TProvides>>[];
        readonly singleton?: boolean;
        start(cx: Context<TNeeds, TConsumes>): Promise<ApiOf<TProvides>>;
        stop?(): Promise<void>;
    }
}
