import { type AdminOperations, createAdminOperations } from './admin'
import { type BulkOperations, createBulkOperations } from './bulk'
import { createDocumentOperations, type DocumentOperations } from './documents'
import { createTransport } from './http'
import { createIndexOperations, type IndexOperations } from './indexes'
import type { NarsilClientOptions } from './options'
import { createSearchOperations, type SearchOperations } from './search'
import { createServerOperations, type ServerOperations } from './server-info'
import { createTaskOperations, type TaskOperations } from './tasks'

/**
 * This client reaches one Narsil server, and it runs every operation that
 * server serves.
 *
 * Every method has the name the embedded engine uses, so a call written against
 * {@link Narsil} works here. HTTP forces two differences: every method takes
 * per-call request settings as its last argument, and the operations that can
 * run for minutes answer with a task record while the work carries on.
 *
 * The client sends through `fetch` alone, so it runs in a browser, in Node, and
 * in an edge function.
 *
 * @public
 */
export interface NarsilClient
  extends IndexOperations,
    DocumentOperations,
    BulkOperations,
    SearchOperations,
    TaskOperations,
    AdminOperations,
    ServerOperations {}

/**
 * Builds a client for one Narsil server.
 *
 * The client opens no connection, and it holds no state beyond the
 * capabilities it has read, so nothing needs closing. Keep one client for the
 * application's lifetime.
 *
 * @param options - These set the server address, the credentials, and the
 * defaults every request inherits.
 * @returns The client is ready to use.
 * @throws A `NarsilError` with `CONFIG_INVALID` when it cannot read the address
 * as a URL.
 *
 * @public
 */
export function createNarsilClient(options: NarsilClientOptions): NarsilClient {
  const transport = createTransport(options)
  return {
    ...createIndexOperations(transport),
    ...createDocumentOperations(transport),
    ...createBulkOperations(transport),
    ...createSearchOperations(transport),
    ...createTaskOperations(transport),
    ...createAdminOperations(transport),
    ...createServerOperations(transport),
  }
}
