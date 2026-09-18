import { provider, type ProviderToken } from '../contribution/provider.js';

export interface HostWindowDriver {
    open(url: string, target?: string, features?: string): WindowProxy | null;
    addEventListener(event: 'message', listener: (e: MessageEvent) => void): void;
    removeEventListener(event: 'message', listener: (e: MessageEvent) => void): void;
}

export interface OnlineDriver {
    readonly isOnline: boolean;
    watch(onChange: (isOnline: boolean) => void): () => void;
}

export const HOST_WINDOW_DRIVER: ProviderToken<HostWindowDriver> = provider<HostWindowDriver>('hostWindow');
export const ONLINE_DRIVER: ProviderToken<OnlineDriver> = provider<OnlineDriver>('online');
