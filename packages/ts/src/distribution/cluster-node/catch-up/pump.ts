import { chunkByBudget } from '../../chunking'
import { WIRE_BATCH_BUDGET } from '../../constants'
import type { PartitionAssignment } from '../../coordinator/types'
import { REPLICATION_ENTRY_FIXED_OVERHEAD_BYTES } from '../../replication/constants'
import { replicateBatchToReplicas } from '../../replication/primary'
import type { ReplicationLog, ReplicationLogEntry } from '../../replication/types'
import { CATCH_UP_TICK_MS, MAX_CATCH_UP_IN_FLIGHT_BYTES } from '../constants'
import type { WriteRoutingDeps } from '../write-routing/types'
import { proposeAdmission } from './admission'
import { admittedBeyondTable, type CatchUpState, forgetReplica, type ReplicaCursor } from './state'

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

function replicaHasFallenOutOfRetention(log: ReplicationLog, cursor: ReplicaCursor): boolean {
  const oldest = log.oldestSeqNo
  if (oldest === undefined) {
    return cursor.appliedSeqNo < log.localLogEnd
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

  const available = MAX_CATCH_UP_IN_FLIGHT_BYTES - state.inFlightBytes
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
  if (cursor.busy) {
    return
  }
  cursor.busy = true
  try {
    await feedReplica(state, deps, indexName, partitionId, assignment, replicaNodeId, cursor)
  } finally {
    cursor.busy = false
  }
}

async function feedReplica(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  replicaNodeId: string,
  cursor: ReplicaCursor,
): Promise<void> {
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
  const sendingEpoch = cursor.syncEpoch
  state.inFlightBytes += reservedBytes
  try {
    const result = await replicateBatchToReplicas(
      batch,
      [replicaNodeId],
      deps.transport,
      deps.nodeId,
      deps.resolveNodeTargets,
    )
    if (result.acknowledged.includes(replicaNodeId) && cursor.syncEpoch === sendingEpoch) {
      cursor.appliedSeqNo = batch[batch.length - 1].seqNo
    }
  } finally {
    state.inFlightBytes -= reservedBytes
  }
}

async function pumpPartition(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  key: string,
  replicas: Map<string, ReplicaCursor>,
  started: Promise<void>[],
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
    const admitted = admittedBeyondTable(state, indexName, partitionId, assignment).includes(replicaNodeId)
    if (!assignment.replicas.includes(replicaNodeId) || assignment.inSyncSet.includes(replicaNodeId) || admitted) {
      forgetReplica(state, indexName, partitionId, replicaNodeId)
      continue
    }
    if (cursor.busy) {
      continue
    }
    const work: Promise<void> = pumpReplica(state, deps, indexName, partitionId, assignment, replicaNodeId, cursor)
      .catch(() => {})
      .finally(() => {
        state.replicaWork.delete(work)
      })
    state.replicaWork.add(work)
    started.push(work)
  }
}

/**
 * Feeds each replica outside the in-sync set one batch of the entries it lacks, and proposes the ones that have
 * caught up.
 *
 * For every partition this node leads, the primary sends each such replica its next batch, proposes its admission
 * once it holds everything the local log holds, or forgets it once it has fallen behind the retained log and needs
 * a fresh snapshot instead. The pump feeds every replica on its own, so a replica that fails or is slow to answer
 * holds up only its own feed, and the next tick skips a replica whose last batch or proposal is still in flight. A
 * tick that is already reading the allocation returns that same tick in place of starting a second one.
 *
 * @param state - The catch-up state that holds the cursors and the in-flight byte total.
 * @param deps - The write routing dependencies, which give the pump the log, the transport, and the coordinator.
 * @returns A promise that settles once every feed that this tick started has finished.
 */
export function runCatchUpTick(state: CatchUpState, deps: WriteRoutingDeps): Promise<void> {
  if (state.stopped || state.activeTick !== null || state.cursors.size === 0) {
    return state.activeTick ?? Promise.resolve()
  }

  const started: Promise<void>[] = []
  const tick = (async () => {
    for (const [key, replicas] of [...state.cursors]) {
      if (state.stopped) {
        return
      }
      try {
        await pumpPartition(state, deps, key, replicas, started)
      } catch (_) {}
    }
  })().finally(() => {
    state.activeTick = null
  })

  state.activeTick = tick
  return tick.then(async () => {
    await Promise.all(started)
  })
}

/**
 * Starts the timer that runs {@link runCatchUpTick}, so that a lagging replica keeps receiving entries between
 * writes.
 *
 * The timer is unreferenced, so it never holds a process open on its own, and starting the pump twice replaces the
 * previous timer rather than adding a second one.
 *
 * @param state - The catch-up state the pump advances.
 * @param deps - The write routing dependencies each tick passes on.
 */
export function startCatchUpPump(state: CatchUpState, deps: WriteRoutingDeps): void {
  void stopCatchUpPump(state)
  state.stopped = false
  state.timer = setInterval(() => {
    void runCatchUpTick(state, deps)
  }, CATCH_UP_TICK_MS)
  state.timer.unref?.()
}

/**
 * Stops the pump and waits for the tick already running and for every feed still in flight, so that no send
 * outlives the node that started it.
 *
 * @param state - The catch-up state to stop.
 * @returns A promise that settles once no tick and no feed is running.
 */
export async function stopCatchUpPump(state: CatchUpState): Promise<void> {
  state.stopped = true
  if (state.timer !== null) {
    clearInterval(state.timer)
    state.timer = null
  }
  if (state.activeTick !== null) {
    await state.activeTick
  }
  await Promise.all([...state.replicaWork])
}
