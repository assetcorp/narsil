import { chunkByBudget } from '../../chunking'
import { WIRE_BATCH_BUDGET } from '../../constants'
import type { PartitionAssignment } from '../../coordinator/types'
import { REPLICATION_ENTRY_FIXED_OVERHEAD_BYTES } from '../../replication/constants'
import { replicateBatchToReplicas } from '../../replication/primary'
import type { ReplicationLog, ReplicationLogEntry } from '../../replication/types'
import { CATCH_UP_FEED_WINDOW_MS, CATCH_UP_TICK_MS, MAX_CATCH_UP_IN_FLIGHT_BYTES } from '../constants'
import { enqueuePartitionWrite } from '../write-routing/partition-queue'
import type { WriteRoutingDeps } from '../write-routing/types'
import { claimAdmission, proposeAdmission, requestClaimedAdmission } from './admission'
import { type CatchUpFeed, createCatchUpFeed, feedIsStale, type RegisteredNodes, untilCancelled } from './feed'
import {
  admittedBeyondTable,
  type CatchUpState,
  clearPendingAdmission,
  forgetReplica,
  type ReplicaCursor,
} from './state'

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
  replicaStartedAt: string | undefined,
): Promise<void> {
  if (cursor.busy) {
    return
  }
  cursor.busy = true
  const feed = createCatchUpFeed(assignment, replicaStartedAt)
  cursor.feed = feed
  try {
    await feedReplica(state, deps, indexName, partitionId, assignment, replicaNodeId, cursor, feed)
  } finally {
    if (cursor.feed === feed) {
      cursor.feed = null
    }
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
  feed: CatchUpFeed,
): Promise<void> {
  const log = deps.getReplicationLog(indexName, partitionId)
  const deadline = Date.now() + CATCH_UP_FEED_WINDOW_MS
  let answeredThisFeed = false

  while (!state.stopped && !feed.cancelled) {
    if (replicaHasFallenOutOfRetention(log, cursor)) {
      forgetReplica(state, indexName, partitionId, replicaNodeId)
      return
    }

    if (cursor.appliedSeqNo >= log.localLogEnd) {
      const proposal = proposeAdmission(state, deps, indexName, partitionId, assignment, replicaNodeId, cursor)
      await untilCancelled(feed, proposal, undefined)
      return
    }

    if (Date.now() >= deadline) {
      return
    }

    const missing = log.getEntriesFrom(cursor.appliedSeqNo + 1)
    const batch = nextWireBatch(state, missing)
    if (batch.length === 0) {
      return
    }
    if (answeredThisFeed && batch.length === missing.length) {
      await closeGapInPartitionQueue(state, deps, indexName, partitionId, assignment, replicaNodeId, cursor, feed)
      return
    }
    if (!(await sendBatch(state, deps, batch, replicaNodeId, cursor, feed))) {
      return
    }
    answeredThisFeed = true
  }
}

async function closeGapInPartitionQueue(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  indexName: string,
  partitionId: number,
  assignment: PartitionAssignment,
  replicaNodeId: string,
  cursor: ReplicaCursor,
  feed: CatchUpFeed,
): Promise<void> {
  const queued = enqueuePartitionWrite(deps.partitionWriteQueues, indexName, partitionId, async () => {
    const log = deps.getReplicationLog(indexName, partitionId)
    while (cursor.appliedSeqNo < log.localLogEnd) {
      const batch = nextWireBatch(state, log.getEntriesFrom(cursor.appliedSeqNo + 1))
      if (state.stopped || feed.cancelled || batch.length === 0) {
        return false
      }
      if (!(await sendBatch(state, deps, batch, replicaNodeId, cursor, feed))) {
        return false
      }
    }
    return !feed.cancelled && claimAdmission(state, deps, indexName, partitionId, replicaNodeId, cursor)
  })
  const claimed = await untilCancelled(feed, queued, false)
  if (claimed) {
    const request = requestClaimedAdmission(state, deps, indexName, partitionId, assignment, replicaNodeId, cursor)
    await untilCancelled(feed, request, undefined)
  } else if (feed.cancelled) {
    queued.then(
      claimedLate => {
        if (claimedLate) clearPendingAdmission(state, indexName, partitionId, replicaNodeId)
      },
      () => {},
    )
  }
}

async function sendBatch(
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
    const indexName = batch[0]?.indexName
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
    )
    return result.acknowledged.includes(replicaNodeId)
  })().finally(() => {
    state.inFlightBytes -= reservedBytes
  })
  const acknowledged = await untilCancelled(feed, delivery, false)
  if (!acknowledged || feed.cancelled || cursor.syncEpoch !== sendingEpoch) {
    return false
  }
  cursor.appliedSeqNo = batch[batch.length - 1].seqNo
  return true
}

function cancelFeeds(replicas: Map<string, ReplicaCursor>): void {
  for (const cursor of replicas.values()) {
    cursor.feed?.cancel()
  }
}

async function registeredNodes(deps: WriteRoutingDeps): Promise<RegisteredNodes> {
  try {
    const nodes = await deps.coordinator.listNodes()
    return new Map(nodes.map(node => [node.nodeId, node.startedAt]))
  } catch (_) {
    return null
  }
}

async function pumpPartition(
  state: CatchUpState,
  deps: WriteRoutingDeps,
  key: string,
  replicas: Map<string, ReplicaCursor>,
  started: Promise<void>[],
  registered: RegisteredNodes,
): Promise<void> {
  const separator = key.lastIndexOf(':')
  const indexName = key.slice(0, separator)
  const partitionId = Number(key.slice(separator + 1))

  const table = await (deps.readLiveAllocation?.(indexName) ?? deps.coordinator.getAllocation(indexName))
  const assignment = table?.assignments.get(partitionId)
  if (assignment === undefined || assignment.primary !== deps.nodeId) {
    cancelFeeds(replicas)
    state.cursors.delete(key)
    state.pendingAdmissions.delete(key)
    return
  }

  for (const [replicaNodeId, cursor] of [...replicas]) {
    if (state.stopped) {
      return
    }
    const admitted = admittedBeyondTable(state, indexName, partitionId, assignment, table?.version).includes(
      replicaNodeId,
    )
    if (!assignment.replicas.includes(replicaNodeId) || assignment.inSyncSet.includes(replicaNodeId) || admitted) {
      forgetReplica(state, indexName, partitionId, replicaNodeId)
      continue
    }
    if (cursor.busy) {
      if (cursor.feed !== null && feedIsStale(cursor.feed, assignment, registered, replicaNodeId)) {
        cursor.feed.cancel()
      }
      continue
    }
    const replicaStartedAt = registered?.get(replicaNodeId)
    const work: Promise<void> = pumpReplica(
      state,
      deps,
      indexName,
      partitionId,
      assignment,
      replicaNodeId,
      cursor,
      replicaStartedAt,
    )
      .catch(() => {})
      .finally(() => {
        state.replicaWork.delete(work)
      })
    state.replicaWork.add(work)
    started.push(work)
  }
}

/**
 * Feeds each replica outside the in-sync set the entries it lacks, and proposes the ones that have caught up.
 *
 * For every partition this node leads, the primary sends each such replica one batch after another for up to
 * `CATCH_UP_FEED_WINDOW_MS`. Once a replica has acknowledged a batch in that window and the entries it still lacks
 * fit in one batch, the primary sends them from inside the partition's write queue and marks the admission pending before the queue lets the next write in, so every
 * later write reaches the replica in order and a steady stream of writes cannot keep it out of the in-sync set. It
 * forgets a replica once that replica has fallen behind the retained log and needs a fresh snapshot instead. The pump feeds every replica on its own, so a replica that fails or is slow to answer
 * holds up only its own feed, and the next tick skips a replica whose last batch or proposal is still in flight. Each
 * batch waits no longer than the transport's `replicationTimeout`. A tick cancels a feed in flight once its replica has
 * left the cluster or restarted, or once the partition's primary term or in-sync set has changed since the feed began,
 * so the tick after that feeds or proposes the replica afresh. Each tick reads the allocation table from the cluster
 * coordinator rather than from the watched copy, because a watched copy that lags behind a sync request would let
 * the tick forget a replica that has just left the in-sync set, and nothing would feed that replica again. A tick
 * that is already reading the allocation returns that same tick in place of starting a second one.
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
    const registered = await registeredNodes(deps)
    for (const [key, replicas] of [...state.cursors]) {
      if (state.stopped) {
        return
      }
      try {
        await pumpPartition(state, deps, key, replicas, started, registered)
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
 * Stops the pump, cancels every feed still in flight, and waits for the tick already running and for each feed to
 * return.
 *
 * A cancelled feed returns without waiting for the reply it was awaiting, so a replica that has stopped answering
 * cannot hold up shutdown.
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
  for (const replicas of state.cursors.values()) {
    cancelFeeds(replicas)
  }
  if (state.activeTick !== null) {
    await state.activeTick
  }
  await Promise.all([...state.replicaWork])
}
