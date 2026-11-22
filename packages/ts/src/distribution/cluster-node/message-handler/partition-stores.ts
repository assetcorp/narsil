import { ErrorCodes, NarsilError } from '../../../errors'
import { createPartitionStoresResultMessage, validatePartitionStoresPayload } from '../../cluster/partition-stores'
import { decodeRequestPayload } from '../../request-decode'
import type { PartitionStoresResultPayload, RespondFn, TransportMessage } from '../../transport/types'
import type { ClusterLocalEngine } from '../local-engine'
import type { DataNodeHandlerDeps } from './types'

export function heldPartitionIdsOf(engine: ClusterLocalEngine, indexName: string): number[] {
  const held = new Set<number>(engine.heldPartitionsOf(indexName) ?? [])
  for (const partition of engine.getPartitionStats(indexName)) {
    if (partition.documentCount > 0) {
      held.add(partition.partitionId)
    }
  }
  return [...held].sort((left, right) => left - right)
}

async function loadUnrecordedPartitions(deps: DataNodeHandlerDeps, indexName: string): Promise<void> {
  if (deps.isOrphaned?.(indexName) === true) return
  const copy = deps.engine.listIndexes().find(index => index.name === indexName)
  if (copy === undefined || copy.state !== 'closed') return
  if ((deps.engine.heldPartitionsOf(indexName)?.length ?? 0) >= copy.partitionCount) return
  try {
    await deps.engine.open(indexName)
  } catch (error) {
    if (!(error instanceof NarsilError) || error.code !== ErrorCodes.INDEX_NOT_FOUND) throw error
  }
}

function describeLocalCopy(deps: DataNodeHandlerDeps, indexName: string): PartitionStoresResultPayload {
  const absent: PartitionStoresResultPayload = { indexName, indexUuid: null, partitionIds: [] }
  if (deps.isOrphaned?.(indexName) === true || !deps.engine.listIndexes().some(index => index.name === indexName)) {
    return absent
  }
  const indexUuid = deps.engine.indexUuidOf(indexName)
  if (indexUuid === null || indexUuid === undefined) {
    return absent
  }
  const partitionIds = heldPartitionIdsOf(deps.engine, indexName).filter(
    partitionId => deps.writeDeps.copyUnlisted?.(indexName, partitionId) !== true,
  )
  return { indexName, indexUuid, partitionIds }
}

/**
 * Answers the controller with the identity of this node's copy of an index and the partitions that copy holds.
 *
 * The controller asks this so that it can give a partition no node currently serves back to a node that still holds
 * the data. A node that adopted no copy of the index answers with a null identity and an empty list. A node names both
 * the partitions its copy recorded when it took them on and the partitions its copy holds a document for, so an
 * empty partition it was given counts as held and a copy written before that record existed stays recoverable. It
 * leaves out a partition whose copy failed until that copy reloads cleanly from this node's checkpoint and log. It
 * opens a closed index whose record leaves out a partition, because only an open index counts its documents.
 *
 * @param message - The request the controller sent.
 * @param respond - The function that returns the answer to the controller.
 * @param deps - This node's id and the local engine it answers from.
 * @returns A promise that settles once the answer has been sent.
 */
export async function handlePartitionStores(
  message: TransportMessage,
  respond: RespondFn,
  deps: DataNodeHandlerDeps,
): Promise<void> {
  const payload = validatePartitionStoresPayload(decodeRequestPayload(message.payload, message.type))
  if (payload === null) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      'Invalid PartitionStoresPayload: it needs an indexName that is a non-empty string',
    )
  }
  await loadUnrecordedPartitions(deps, payload.indexName)
  const result = describeLocalCopy(deps, payload.indexName)

  await respond(createPartitionStoresResultMessage(result, deps.nodeId, message.requestId))
}
