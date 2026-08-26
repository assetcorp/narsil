import { decode } from '@msgpack/msgpack'
import { createPartitionStoresResultMessage, validatePartitionStoresPayload } from '../../cluster/partition-stores'
import type { PartitionStoresResultPayload, RespondFn, TransportMessage } from '../../transport/types'
import type { DataNodeHandlerDeps } from './types'

function describeLocalCopy(deps: DataNodeHandlerDeps, indexName: string): PartitionStoresResultPayload {
  const absent: PartitionStoresResultPayload = { indexName, indexUuid: null, partitionIds: [] }
  if (!deps.engine.listIndexes().some(index => index.name === indexName)) {
    return absent
  }
  const indexUuid = deps.engine.indexUuidOf(indexName)
  if (indexUuid === null || indexUuid === undefined) {
    return absent
  }
  const partitionIds: number[] = []
  for (const partition of deps.engine.getPartitionStats(indexName)) {
    if (partition.documentCount > 0) {
      partitionIds.push(partition.partitionId)
    }
  }
  return { indexName, indexUuid, partitionIds }
}

/**
 * Answers the controller with the identity of this node's copy of an index and the partitions that copy holds.
 *
 * The controller asks this so that it can give a partition no node currently serves back to a node that still holds
 * the data. A node that keeps no copy of the index answers with a null identity and an empty list, and a node whose
 * copy holds no document of a partition leaves that partition out, because the controller may promote only a node
 * that can serve the partition it names.
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
  const payload = validatePartitionStoresPayload(decode(message.payload))
  const result: PartitionStoresResultPayload =
    payload === null ? { indexName: '', indexUuid: null, partitionIds: [] } : describeLocalCopy(deps, payload.indexName)

  await respond(createPartitionStoresResultMessage(result, deps.nodeId, message.requestId))
}
