import { describeError, ErrorCodes, NarsilError } from '../../errors'
import { getIndexMetadata, readIndexMetadataSnapshot } from '../cluster/index-metadata'
import type { ClusterCoordinator } from '../coordinator/types'
import type { ClusterLocalEngine } from './local-engine'
import { localIndexIsGone } from './local-index-gone'
import { applyStoredSynonyms } from './synonym-sets'

/**
 * What a node decided about an index it already held when it joined.
 *
 * `adopted` means the cluster owns this copy, `superseded` means the cluster
 * replaced it under the same name and the node dropped it, and `orphaned`
 * means the coordinator knows nothing about the name, so the node keeps the
 * data and serves none of it. `unreadable` means a read from the coordinator
 * failed, so the node treats the copy as orphaned and settles it again while it
 * waits to register.
 *
 * @public
 */
export type LocalIndexDisposition = 'adopted' | 'superseded' | 'orphaned' | 'unreadable'

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
 * Each copy that the node adopts takes the synonym set that the coordinator
 * holds for the index, because the set can change while the node is offline.
 * Where the node cannot read that set, it keeps the copy without serving it.
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

export async function settleLocalIndexes(
  deps: LocalIndexReconcileDeps,
  orphaned: Set<string>,
  settleAdopted: (indexName: string) => Promise<unknown>,
): Promise<Set<string>> {
  const unreadable = new Set<string>()
  for (const [indexName, disposition] of await reconcileLocalIndexes(deps)) {
    if (disposition === 'adopted') await settleAdopted(indexName)
    if (disposition === 'orphaned' || disposition === 'unreadable') orphaned.add(indexName)
    if (disposition === 'unreadable') unreadable.add(indexName)
  }
  return unreadable
}

export async function settleUnreadableIndexes(
  deps: LocalIndexReconcileDeps,
  orphaned: Set<string>,
  unreadable: Set<string>,
  settleAdopted: (indexName: string) => Promise<unknown>,
): Promise<void> {
  let failure: { error: unknown } | null = null
  for (const indexName of [...unreadable]) {
    try {
      if (!deps.engine.listIndexes().some(index => index.name === indexName)) {
        unreadable.delete(indexName)
        continue
      }
      const disposition = await reconcileOne({ ...deps, onError: undefined }, indexName)
      if (disposition === 'unreadable') continue
      if (disposition === 'adopted') await settleAdopted(indexName)
      if (disposition !== 'orphaned') orphaned.delete(indexName)
      unreadable.delete(indexName)
    } catch (error) {
      failure ??= { error }
    }
  }
  if (failure !== null) throw failure.error
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
  if (typeof engine.indexUuidOf(indexName) === 'string') {
    return
  }
  const metadata = await getIndexMetadata(coordinator, indexName)
  if (metadata === null) {
    return
  }
  await engine.stampIndexUuid(indexName, metadata.indexUuid)
}

export async function dropSupersededCopy(
  engine: ClusterLocalEngine,
  coordinator: ClusterCoordinator,
  indexName: string,
): Promise<void> {
  const localUuid = engine.indexUuidOf(indexName)
  if (typeof localUuid !== 'string') {
    return
  }
  const metadata = await getIndexMetadata(coordinator, indexName)
  if (metadata === null || metadata.indexUuid === localUuid || engine.indexUuidOf(indexName) !== localUuid) {
    return
  }
  try {
    await engine.dropIndex(indexName)
  } catch (error) {
    if (!localIndexIsGone(error)) throw error
  }
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
    reportUnreadable(deps, indexName, `its metadata could not be read: ${describeError(error)}`)
    return 'unreadable'
  }

  if (clusterUuid === null) {
    reportUnclaimed(deps, indexName)
    return 'orphaned'
  }

  if (localUuid === null || localUuid === undefined) {
    await deps.engine.stampIndexUuid(indexName, clusterUuid)
  } else if (localUuid !== clusterUuid) {
    await deps.engine.dropIndex(indexName)
    return 'superseded'
  }

  try {
    await applyStoredSynonyms(deps.engine, deps.coordinator, indexName, clusterUuid)
  } catch (error) {
    reportUnreadable(deps, indexName, `its synonym set could not be read: ${describeError(error)}`)
    return 'unreadable'
  }
  try {
    const stored = await readIndexMetadataSnapshot(deps.coordinator, indexName)
    if (stored?.record.indexUuid === clusterUuid) {
      await deps.engine.applyStoredBm25(indexName, () => ({ bm25: stored.settings?.bm25 }))
    }
  } catch (error) {
    reportUnreadable(deps, indexName, `its BM25 setting could not be read: ${describeError(error)}`)
    return 'unreadable'
  }
  return 'adopted'
}

function reportUnclaimed(deps: LocalIndexReconcileDeps, indexName: string): void {
  reportOrphaned(
    deps,
    indexName,
    `Node '${deps.nodeId}' holds a local copy of index '${indexName}' the cluster does not claim, because the coordinator holds no metadata for that name. The node keeps the data and serves none of it until an operator drops it.`,
  )
}

function reportUnreadable(deps: LocalIndexReconcileDeps, indexName: string, reason: string): void {
  reportOrphaned(
    deps,
    indexName,
    `Node '${deps.nodeId}' can't confirm that the cluster claims its local copy of index '${indexName}', because ${reason}. The node keeps the data and serves none of it until it settles the copy before it registers or at a later start, so keep the copy.`,
  )
}

function reportOrphaned(deps: LocalIndexReconcileDeps, indexName: string, message: string): void {
  if (deps.onError === undefined) {
    return
  }
  deps.onError(new NarsilError(ErrorCodes.INDEX_ORPHANED, message, { indexName, nodeId: deps.nodeId }))
}
