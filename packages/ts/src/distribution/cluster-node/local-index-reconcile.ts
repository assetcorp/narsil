import { describeError, ErrorCodes, NarsilError } from '../../errors'
import { getIndexMetadata } from '../cluster/index-metadata'
import type { ClusterCoordinator } from '../coordinator/types'
import type { ClusterLocalEngine } from './local-engine'

/**
 * What a node decided about an index it already held when it joined.
 *
 * `adopted` means the cluster owns this copy, `superseded` means the cluster
 * replaced it under the same name and the node dropped it, and `orphaned`
 * means the coordinator knows nothing about the name, so the node keeps the
 * data and serves none of it.
 *
 * @public
 */
export type LocalIndexDisposition = 'adopted' | 'superseded' | 'orphaned'

/**
 * The pieces a join-time reconciliation reads and changes.
 *
 * @public
 */
export interface LocalIndexReconcileDeps {
  engine: ClusterLocalEngine
  coordinator: ClusterCoordinator
  nodeId: string
  onError?: (error: Error) => void
}

/**
 * Settles every local index against the cluster before the node serves anything.
 *
 * A node that was offline while an index was dropped still holds that index on
 * disk, and the name alone cannot tell the old index from a new one created
 * under it. Each index carries the identity the cluster gave it, so this
 * compares that identity with the coordinator's and decides one of three
 * things: adopt the copy, drop a copy the cluster has replaced, or keep an
 * unrecognised copy without serving it.
 *
 * A copy whose identity is absent, which is how an index created before this
 * node tracked identity looks, takes the coordinator's identity so that every
 * later join can decide from evidence.
 *
 * @param deps - The engine holding the local indexes, the coordinator holding
 * the cluster's, this node's id, and where to report an orphan.
 * @returns What was decided for each local index, by index name.
 */
export async function reconcileLocalIndexes(
  deps: LocalIndexReconcileDeps,
): Promise<Map<string, LocalIndexDisposition>> {
  const dispositions = new Map<string, LocalIndexDisposition>()

  for (const index of deps.engine.listIndexes()) {
    const disposition = await reconcileOne(deps, index.name)
    dispositions.set(index.name, disposition)
  }

  return dispositions
}

/**
 * Gives a freshly bootstrapped index the identity the cluster holds for it.
 *
 * A node bootstraps an index it has no identity for whenever it takes on the
 * first partition of a new index, whether as primary or as replica, so this
 * records that identity while the coordinator still holds it.
 *
 * @param engine - The local engine holding the index.
 * @param coordinator - The coordinator holding the cluster's identity.
 * @param indexName - The index that finished bootstrapping.
 */
export async function adoptClusterIdentity(
  engine: ClusterLocalEngine,
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<void> {
  if (engine.indexUuidOf(indexName) !== null) {
    return
  }
  const metadata = await getIndexMetadata(coordinator, indexName)
  if (metadata === null) {
    return
  }
  await engine.stampIndexUuid(indexName, metadata.indexUuid)
}

/**
 * Builds the error a node answers with for an index it holds but the cluster
 * does not claim.
 *
 * @param nodeId - The node holding the copy.
 * @param indexName - The index the caller named.
 * @returns The error to throw.
 */
export function orphanedIndexError(nodeId: string, indexName: string): NarsilError {
  return new NarsilError(
    ErrorCodes.INDEX_ORPHANED,
    `Node '${nodeId}' holds a local copy of index '${indexName}' the cluster does not claim, so it answers nothing for that name. Drop it to reclaim the space`,
    { indexName, nodeId },
  )
}

async function reconcileOne(deps: LocalIndexReconcileDeps, indexName: string): Promise<LocalIndexDisposition> {
  const localUuid = deps.engine.indexUuidOf(indexName)
  let clusterUuid: string | null
  try {
    clusterUuid = (await getIndexMetadata(deps.coordinator, indexName))?.indexUuid ?? null
  } catch (error) {
    report(deps, indexName, `its metadata could not be read: ${describeError(error)}`)
    return 'orphaned'
  }

  if (clusterUuid === null) {
    report(deps, indexName, 'the coordinator holds no metadata for that name')
    return 'orphaned'
  }

  if (localUuid === clusterUuid) {
    return 'adopted'
  }

  if (localUuid === null || localUuid === undefined) {
    await deps.engine.stampIndexUuid(indexName, clusterUuid)
    return 'adopted'
  }

  await deps.engine.dropIndex(indexName)
  return 'superseded'
}

function report(deps: LocalIndexReconcileDeps, indexName: string, reason: string): void {
  if (deps.onError === undefined) {
    return
  }
  deps.onError(
    new NarsilError(
      ErrorCodes.INDEX_ORPHANED,
      `Node '${deps.nodeId}' holds a local copy of index '${indexName}' the cluster does not claim, because ${reason}. The node keeps the data and serves none of it until an operator drops it.`,
      { indexName, nodeId: deps.nodeId },
    ),
  )
}
