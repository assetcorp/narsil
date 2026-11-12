import { chunkByBudget } from '../../chunking'
import { WIRE_BATCH_BUDGET } from '../../constants'
import { REPLICATION_ENTRY_FIXED_OVERHEAD_BYTES } from '../../replication/constants'
import { previousTermOf, replicateBatchToReplicas } from '../../replication/primary'
import type { ReplicationLogEntry } from '../../replication/types'
import { MAX_CATCH_UP_IN_FLIGHT_BYTES } from '../constants'
import type { WriteRoutingDeps } from '../write-routing/types'
import { type CatchUpFeed, untilCancelled } from './feed'
import type { CatchUpState, ReplicaCursor } from './state'

function entryBytes(entry: ReplicationLogEntry): number {
  return (
    REPLICATION_ENTRY_FIXED_OVERHEAD_BYTES +
    entry.indexName.length +
    entry.documentId.length +
    (entry.document?.byteLength ?? 0)
  )
}

function batchBytes(entries: ReplicationLogEntry[]): number {
  let total = 0
  for (const entry of entries) {
    total += entryBytes(entry)
  }
  return total
}

export function nextWireBatch(state: CatchUpState, pending: ReplicationLogEntry[]): ReplicationLogEntry[] {
  const chunks = chunkByBudget(pending, {
    ...WIRE_BATCH_BUDGET,
    payloadBytesOf: entry => entry.document?.byteLength ?? 0,
    breaksRun: (entry, previous) => entry.seqNo !== previous.seqNo + 1,
  })
  const batch = chunks[0] ?? []
  if (batch.length === 0) {
    return []
  }

  const available = MAX_CATCH_UP_IN_FLIGHT_BYTES - state.inFlightBytes
  return batchBytes(batch) > available ? [] : batch
}

export async function sendBatch(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  batch: ReplicationLogEntry[],
  replicaNodeId: string,
  cursor: ReplicaCursor,
  feed: CatchUpFeed,
): Promise<boolean> {
  const reservedBytes = batchBytes(batch)
  const sendingEpoch = cursor.syncEpoch
  state.inFlightBytes += reservedBytes
  const delivery = (async () => {
    const first = batch[0]
    const indexName = first?.indexName
    const table = indexName === undefined ? null : await deps.coordinator.getAllocation(indexName)
    if (feed.cancelled) {
      return false
    }
    const result = await replicateBatchToReplicas(
      batch,
      [replicaNodeId],
      deps.transport,
      deps.nodeId,
      deps.resolveNodeTargets,
      table?.indexUuid,
      first === undefined
        ? undefined
        : previousTermOf(deps.getReplicationLog(first.indexName, first.partitionId), first.seqNo),
    )
    return result.acknowledged.includes(replicaNodeId)
  })().finally(() => {
    state.inFlightBytes -= reservedBytes
  })
  const acknowledged = await untilCancelled(feed, delivery, false)
  if (!acknowledged || feed.cancelled || cursor.syncEpoch !== sendingEpoch) {
    return false
  }
  cursor.appliedSeqNo = Math.max(cursor.appliedSeqNo, batch[batch.length - 1].seqNo)
  cursor.confirmed = true
  return true
}
