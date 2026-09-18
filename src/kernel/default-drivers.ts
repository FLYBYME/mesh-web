import type { HostWindowDriver, OnlineDriver } from './drivers.js';

export function createHostWindowDriver(): HostWindowDriver {
    return {
        open: (url: string, target?: string, features?: string) => window.open(url, target, features),
        addEventListener: (event: 'message', listener: (e: MessageEvent) => void) => window.addEventListener(event, listener),
        removeEventListener: (event: 'message', listener: (e: MessageEvent) => void) => window.removeEventListener(event, listener)
    };
}

export function createOnlineDriver(): OnlineDriver {
    return {
        get isOnline() {
            return navigator.onLine;
        },
        watch(onChange: (isOnline: boolean) => void): () => void {
            const handleOnline = () => onChange(true);
            const handleOffline = () => onChange(false);
            window.addEventListener('online', handleOnline);
            window.addEventListener('offline', handleOffline);
            return () => {
                window.removeEventListener('online', handleOnline);
                window.removeEventListener('offline', handleOffline);
            };
        }
    };
}
