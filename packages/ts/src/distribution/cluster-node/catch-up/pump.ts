import { chunkByBudget, WIRE_BATCH_BUDGET } from '../../chunking'
import type { PartitionAssignment } from '../../coordinator/types'
import { replicateBatchToReplicas } from '../../replication/primary'
import type { ReplicationLog, ReplicationLogEntry } from '../../replication/types'
import type { WriteRoutingDeps } from '../write-routing/types'
import { proposeAdmission } from './admission'
import {
  CATCH_UP_IN_FLIGHT_BYTE_CEILING,
  CATCH_UP_TICK_MS,
  type CatchUpState,
  forgetReplica,
  type ReplicaCursor,
} from './state'

const ENTRY_FIXED_OVERHEAD_BYTES = 40

function entryBytes(entry: ReplicationLogEntry): number {
  return (
    ENTRY_FIXED_OVERHEAD_BYTES + entry.indexName.length + entry.documentId.length + (entry.document?.byteLength ?? 0)
  )
}

function batchBytes(entries: ReplicationLogEntry[]): number {
  let total = 0
  for (const entry of entries) {
    total += entryBytes(entry)
  }
  return total
}

function replicaHasFallenOutOfRetention(log: ReplicationLog, cursor: ReplicaCursor): boolean {
  const oldest = log.oldestSeqNo
  if (oldest === undefined) {
    return false
  }
  return cursor.appliedSeqNo + 1 < oldest
}

function nextWireBatch(state: CatchUpState, pending: ReplicationLogEntry[]): ReplicationLogEntry[] {
  const chunks = chunkByBudget(pending, {
    ...WIRE_BATCH_BUDGET,
    payloadBytesOf: entry => entry.document?.byteLength ?? 0,
    breaksRun: (entry, previous) => entry.seqNo !== previous.seqNo + 1,
  })
  const batch = chunks[0] ?? []
  if (batch.length === 0) {
    return []
  }

  const available = CATCH_UP_IN_FLIGHT_BYTE_CEILING - state.inFlightBytes
  return batchBytes(batch) > available ? [] : batch
}

async function pumpReplica(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  replicaNodeId: string,
  cursor: ReplicaCursor,
): Promise<void> {
  if (cursor.sending) {
    return
  }

  const log = deps.getReplicationLog(indexName, partitionId)

  if (replicaHasFallenOutOfRetention(log, cursor)) {
    forgetReplica(state, indexName, partitionId, replicaNodeId)
    return
  }

  if (cursor.appliedSeqNo >= log.localLogEnd) {
    await proposeAdmission(state, deps, indexName, partitionId, assignment, replicaNodeId, cursor)
    return
  }

  const batch = nextWireBatch(state, log.getEntriesFrom(cursor.appliedSeqNo + 1))
  if (batch.length === 0) {
    return
  }

  const reservedBytes = batchBytes(batch)
  cursor.sending = true
  state.inFlightBytes += reservedBytes
  try {
    const result = await replicateBatchToReplicas(
      batch,
      [replicaNodeId],
      deps.transport,
      deps.nodeId,
      deps.resolveNodeTargets,
    )
    if (result.acknowledged.includes(replicaNodeId)) {
      cursor.appliedSeqNo = batch[batch.length - 1].seqNo
    }
  } finally {
    state.inFlightBytes -= reservedBytes
    cursor.sending = false
  }
}

async function pumpPartition(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  key: string,
  replicas: Map<string, ReplicaCursor>,
): Promise<void> {
  const separator = key.lastIndexOf(':')
  const indexName = key.slice(0, separator)
  const partitionId = Number(key.slice(separator + 1))

  const table = await deps.coordinator.getAllocation(indexName)
  const assignment = table?.assignments.get(partitionId)
  if (assignment === undefined || assignment.primary !== deps.nodeId) {
    state.cursors.delete(key)
    state.pendingAdmissions.delete(key)
    return
  }

  for (const [replicaNodeId, cursor] of [...replicas]) {
    if (state.stopped) {
      return
    }
    if (!assignment.replicas.includes(replicaNodeId) || assignment.inSyncSet.includes(replicaNodeId)) {
      forgetReplica(state, indexName, partitionId, replicaNodeId)
      continue
    }
    try {
      await pumpReplica(state, deps, indexName, partitionId, assignment, replicaNodeId, cursor)
    } catch (_) {
      /* One replica's failure leaves the others in this tick untouched. */
    }
  }
}

export function runCatchUpTick(state: CatchUpState, deps: WriteRoutingDeps): Promise<void> {
  if (state.stopped || state.activeTick !== null || state.cursors.size === 0) {
    return state.activeTick ?? Promise.resolve()
  }

  const tick = (async () => {
    for (const [key, replicas] of [...state.cursors]) {
      if (state.stopped) {
        return
      }
      try {
        await pumpPartition(state, deps, key, replicas)
      } catch (_) {
        /* One partition's failure leaves the others in this tick untouched. */
      }
    }
  })().finally(() => {
    state.activeTick = null
  })

  state.activeTick = tick
  return tick
}

export function startCatchUpPump(state: CatchUpState, deps: WriteRoutingDeps): void {
  void stopCatchUpPump(state)
  state.stopped = false
  state.timer = setInterval(() => {
    void runCatchUpTick(state, deps)
  }, CATCH_UP_TICK_MS)
  state.timer.unref?.()
}

export async function stopCatchUpPump(state: CatchUpState): Promise<void> {
  state.stopped = true
  if (state.timer !== null) {
    clearInterval(state.timer)
    state.timer = null
  }
  if (state.activeTick !== null) {
    await state.activeTick
  }
}
