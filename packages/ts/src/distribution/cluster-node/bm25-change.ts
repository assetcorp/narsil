import { ErrorCodes, NarsilError } from '../../errors'
import { storedBM25Params, validateBM25Params } from '../../search/bm25-params'
import type { BM25Params } from '../../types/schema'
import {
  indexConfigKey,
  metadataWithBm25,
  readIndexMetadataSnapshot,
  validateIndexName,
} from '../cluster/index-metadata'
import type { ClusterCoordinator } from '../coordinator/types'
import { bm25NotReady, registeredNodesBelowBm25Tuning } from '../query/bm25-routing'
import type { Bm25View } from './bm25-view'
import { MAX_SETTINGS_REPLACEMENT_ATTEMPTS, SETTINGS_CONTENTION_REASON } from './constants'

function indexNotFound(indexName: string): NarsilError {
  return new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index '${indexName}' does not exist in the cluster`, {
    indexName,
  })
}

export async function replaceClusterBm25(
  coordinator: ClusterCoordinator,
  view: Bm25View,
  indexName: string,
  value: BM25Params,
): Promise<void> {
  validateIndexName(indexName)
  const schema = await coordinator.getSchema(indexName)
  if (schema === null) throw indexNotFound(indexName)
  validateBM25Params(value, schema, ErrorCodes.CONFIG_INVALID)
  const bm25 = storedBM25Params(value)
  const olderNodes = registeredNodesBelowBm25Tuning(await coordinator.listNodes())
  if (olderNodes.length > 0) throw bm25NotReady('The cluster has', olderNodes, indexName)

  for (let attempt = 1; attempt <= MAX_SETTINGS_REPLACEMENT_ATTEMPTS; attempt++) {
    const current = await readIndexMetadataSnapshot(coordinator, indexName)
    if (current === null) throw indexNotFound(indexName)
    const revision = (current.settings?.bm25Revision ?? 0) + 1
    const next = metadataWithBm25(current, bm25, revision)
    if (await coordinator.compareAndSet(indexConfigKey(indexName), current.bytes, next)) {
      await view.applyWritten(indexName, { indexUuid: current.record.indexUuid, bm25, revision })
      return
    }
  }
  throw new NarsilError(
    ErrorCodes.CLUSTER_WRITE_BLOCKED,
    `Index '${indexName}' kept changing while its BM25 setting was replaced ${MAX_SETTINGS_REPLACEMENT_ATTEMPTS} times over, so the new setting was not stored. Retry the request`,
    { reason: SETTINGS_CONTENTION_REASON, indexName, attempts: MAX_SETTINGS_REPLACEMENT_ATTEMPTS },
  )
}
