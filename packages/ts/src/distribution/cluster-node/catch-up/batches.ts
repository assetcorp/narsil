import { LOG_ENTRY_BATCH_BUDGET } from '../../replication/entry-batches'
import { entryByteEstimate } from '../../replication/entry-checksum'
import { previousTermOf, replicateBatchToReplicas } from '../../replication/primary'
import type { ReplicationLog, ReplicationLogEntry } from '../../replication/types'
import { MAX_CATCH_UP_IN_FLIGHT_BYTES } from '../constants'
import type { WriteRoutingDeps } from '../write-routing/types'
import { type CatchUpFeed, untilCancelled } from './feed'
import { releaseInFlightBytes } from './in-flight-bytes'
import type { CatchUpState, ReplicaCursor } from './state'

export interface ReservedBatch {
  entries: ReplicationLogEntry[]
  reservedBytes: number
}

export function reserveNextBatch(state: CatchUpState, log: ReplicationLog, fromSeqNo: number): ReservedBatch | null {
  const throughSeqNo = log.localLogEnd
  const plannedBytes = log.getEntryBatchBytes(fromSeqNo, throughSeqNo, LOG_ENTRY_BATCH_BUDGET)
  if (plannedBytes === 0 || plannedBytes > MAX_CATCH_UP_IN_FLIGHT_BYTES - state.inFlightBytes) {
    return null
  }
  state.inFlightBytes += plannedBytes
  const entries = log.getEntryBatch(fromSeqNo, throughSeqNo, LOG_ENTRY_BATCH_BUDGET)
  if (entries.length === 0) {
    releaseInFlightBytes(state, plannedBytes)
    return null
  }
  return { entries, reservedBytes: plannedBytes }
}

export async function sendBatch(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  { entries: batch, reservedBytes }: ReservedBatch,
  replicaNodeId: string,
  cursor: ReplicaCursor,
  feed: CatchUpFeed,
): Promise<boolean> {
  const sendingEpoch = cursor.syncEpoch
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
    releaseInFlightBytes(state, reservedBytes)
  })
  const acknowledged = await untilCancelled(feed, delivery, false)
  if (!acknowledged || feed.cancelled || cursor.syncEpoch !== sendingEpoch) {
    return false
  }
  cursor.appliedSeqNo = Math.max(cursor.appliedSeqNo, batch[batch.length - 1].seqNo)
  cursor.confirmed = true
  return true
}

export type HeldEntryAnswer = 'acknowledged' | 'refused-as-invalid' | 'unconfirmed'

export async function sendHeldEntryAgain(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  entry: ReplicationLogEntry,
  replicaNodeId: string,
): Promise<HeldEntryAnswer> {
  const reservedBytes = entryByteEstimate(entry)
  if (reservedBytes > MAX_CATCH_UP_IN_FLIGHT_BYTES - state.inFlightBytes) return 'unconfirmed'
  state.inFlightBytes += reservedBytes
  try {
    const table = await deps.coordinator.getAllocation(entry.indexName)
    const result = await replicateBatchToReplicas(
      [entry],
      [replicaNodeId],
      deps.transport,
      deps.nodeId,
      deps.resolveNodeTargets,
      table?.indexUuid,
      previousTermOf(deps.getReplicationLog(entry.indexName, entry.partitionId), entry.seqNo),
    )
    if (result.acknowledged.includes(replicaNodeId)) return 'acknowledged'
    return result.refusedAsInvalid.includes(replicaNodeId) ? 'refused-as-invalid' : 'unconfirmed'
  } finally {
    releaseInFlightBytes(state, reservedBytes)
  }
}
