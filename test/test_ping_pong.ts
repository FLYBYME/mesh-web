import { signal, effect, flushSync } from '../src/reactivity/index.js';

const ping = signal(0);
const pong = signal(0);

effect(() => {
    ping.set(pong() + 1);
});

effect(() => {
    pong.set(ping() + 1);
});

try {
    flushSync();
    console.log("No error");
} catch (e) {
    console.log("Error:", e.message);
}
