import { ErrorCodes, NarsilError } from '../../errors'
import { CLEAR_PAGE_SIZE } from './constants'
import { type ClusterReadDeps, listCluster } from './reads'
import { routableAllocation } from './routable-allocation'
import type { WriteRoutingDeps } from './write-routing'
import { routeRemoveBatch } from './write-routing'

export async function clearCluster(
  readDeps: ClusterReadDeps,
  writeDeps: WriteRoutingDeps,
  indexName: string,
): Promise<void> {
  const allocation = await routableAllocation(readDeps.config.coordinator, indexName)
  if (allocation === null) {
    return readDeps.engine.clear(indexName)
  }

  for (;;) {
    const page = await listCluster(readDeps, indexName, { limit: CLEAR_PAGE_SIZE, document: false })
    if (page.documents.length === 0) {
      return
    }

    const result = await routeRemoveBatch(
      indexName,
      page.documents.map(listed => listed.id),
      writeDeps,
    )

    if (result.succeeded.length === 0) {
      const firstFailure = result.failed[0]
      throw new NarsilError(
        ErrorCodes.QUERY_ROUTING_FAILED,
        `Clearing index '${indexName}' stalled: no document in the current page could be removed`,
        {
          indexName,
          remaining: page.total,
          firstFailureDocId: firstFailure?.docId,
          firstFailureCode: firstFailure?.error.code,
          firstFailureMessage: firstFailure?.error.message,
        },
      )
    }
  }
}
