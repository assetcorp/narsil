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
 * A Narsil server, and everything you do with it.
 *
 * Every method has the name the embedded engine uses, so a call written against
 * {@link Narsil} works here. HTTP forces two differences. Every method takes
 * per-call request settings as its last argument, and the operations that can
 * run for minutes answer with a task record while the work carries on.
 *
 * The client reaches a server through `fetch` alone, so it runs in a browser,
 * in Node, and in an edge function.
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
 * capabilities it has read. Nothing needs closing, so keep one client for the
 * application's lifetime.
 *
 * @param options - The server address, the credentials, and the defaults every
 * request inherits.
 * @returns The client, ready to use.
 * @throws A `NarsilError` with `CONFIG_INVALID` when the address cannot be read
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
