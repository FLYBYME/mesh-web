/**
 * A generated client types each call's input by its schema's *input* side (mesh-serve's emitter
 * writes `call<z.input<typeof xInputSchema>, ...>`), so a field with a default may be left out.
 *
 * Checked by `npm run typecheck`, never executed. Before the emitter fix, calls were typed with
 * `z.infer` — the parsed side — and `domain.find` demanded `offset` at every call site.
 */

import { z } from 'zod';
import { call, defineApi } from '../src/net/api.js';
import type { MeshClient } from '../src/net/client.js';

const domainFindInputSchema = z.object({ limit: z.number().default(100), offset: z.number().default(0), sort: z.string().optional() }).strict();
const domainFindOutputSchema = z.array(z.object({ name: z.string() }));
type DomainFindOutput = z.infer<typeof domainFindOutputSchema>;

const api = defineApi({
    id: 'api.test',
    exposure: 'x',
    calls: {
        'domain.find': call<z.input<typeof domainFindInputSchema>, DomainFindOutput, never>('GET', '/domains'),
    },
});

declare const client: MeshClient<typeof api>;

export async function callers(): Promise<void> {
    await client.call('domain.find', {});
    await client.call('domain.find', { limit: 5, sort: '-createdAt' });
    // @ts-expect-error still checked: `limit` is a number
    await client.call('domain.find', { limit: 'five' });
    // @ts-expect-error still checked: the schema is strict, and so is the type
    await client.call('domain.find', { lmit: 5 });
}
