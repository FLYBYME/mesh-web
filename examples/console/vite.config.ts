/**
 * `npm run example:console` — the reference console on http://localhost:5191, against mesh-web's
 * own source (not a build), so a framework change shows up on reload.
 */

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    server: { port: 5191, strictPort: true },
    resolve: {
        alias: { '@flybyme/mesh-web': fileURLToPath(new URL('../../src/index.ts', import.meta.url)) },
    },
    appType: 'spa',
});
