import { provider, type ProviderToken } from '../contribution/provider.js';
import type { Action, IntentActor, IntentValue, Node } from '../description/types.js';

export interface Dispatcher {
    dispatch(action: Action, value?: IntentValue, actor?: IntentActor): void;
}

export interface RendererOptions {
    readonly dispatch: Dispatcher;
    readonly part?: string;
}

export interface Mounted {
    dispose(): void;
}

export interface Renderer<THost = unknown> {
    render(description: Node, host: THost, options: RendererOptions): Mounted;
}

export const RENDERER: ProviderToken<Renderer> = provider<Renderer>('mesh-web/renderer');
