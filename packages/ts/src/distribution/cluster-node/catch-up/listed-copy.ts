import { generateId } from '../../../core/id-generator'
import { decode } from '../../../serialization/msgpack'
import { createPartitionStoresMessage, validatePartitionStoresResultPayload } from '../../cluster/partition-stores'
import type { PartitionStoresResultPayload } from '../../transport/types'
import { resolveNodeTargets } from '../write-routing/assignment'
import type { WriteRoutingDeps } from '../write-routing/types'

function answerOf(payload: Uint8Array): PartitionStoresResultPayload | null {
  try {
    return validatePartitionStoresResultPayload(decode(payload))
  } catch (_) {
    return null
  }
}

export async function replicaListsPartition(
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
  replicaNodeId: string,
): Promise<boolean> {
  const table = await deps.coordinator.getAllocation(indexName)
  const message = createPartitionStoresMessage({ indexName }, deps.nodeId, generateId())
  for (const target of await resolveNodeTargets(replicaNodeId, deps)) {
    let payload: Uint8Array
    try {
      payload = (await deps.transport.send(target, message)).payload
    } catch (_) {
      continue
    }
    const answer = answerOf(payload)
    if (answer === null || answer.indexName !== indexName || answer.indexUuid === null) return false
    if (table?.indexUuid !== undefined && answer.indexUuid !== table.indexUuid) return false
    return answer.partitionIds.includes(partitionId)
  }
  return false
}
