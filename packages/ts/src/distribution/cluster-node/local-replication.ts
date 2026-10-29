import type { EngineCore } from '../../engine/core'
import type { PartitionManager } from '../../partitioning/manager'
import type { PartitionLogPosition } from '../../persistence/durability/types'
import type { ClusterCoordinator, PartitionAssignment } from '../coordinator/types'
import { applyDeleteEntry, applyIndexEntry } from '../replication/replica'
import type { ReplicationConfig, ReplicationLog, ReplicationLogEntry } from '../replication/types'
import type { ClusterLocalEngine } from './local-engine'
import { seedReplicationLog } from './replication-logs'

interface ReopenReplicationInput {
  indexName: string
  nodeId: string
  engine: Pick<ClusterLocalEngine, 'heldPartitionsOf' | 'persistedPositionOf'>
  coordinator: Pick<ClusterCoordinator, 'getAllocation'>
  replicationLogs: Map<string, ReplicationLog>
  replicationConfig?: Partial<ReplicationConfig>
}

export function numberingFloor(persisted: PartitionLogPosition, assignment: PartitionAssignment): PartitionLogPosition {
  if (persisted.seqNo >= assignment.commitPoint) return persisted
  return { seqNo: assignment.commitPoint, primaryTerm: assignment.primaryTerm }
}

/**
 * Restores primary replication sequence floors after a local index reopens.
 *
 * @param input - The reopened index, allocation source, and local log registry.
 * @returns A promise that settles after every local primary log has its durable floor.
 */
export async function seedReopenedPrimaryLogs(input: ReopenReplicationInput): Promise<void> {
  const allocation = await input.coordinator.getAllocation(input.indexName)
  if (allocation === null) return
  for (const partitionId of input.engine.heldPartitionsOf(input.indexName) ?? []) {
    const assignment = allocation.assignments.get(partitionId)
    if (assignment?.primary !== input.nodeId) continue
    const floor = numberingFloor(input.engine.persistedPositionOf(input.indexName, partitionId), assignment)
    seedReplicationLog(
      input.replicationLogs,
      input.indexName,
      partitionId,
      floor.seqNo + 1,
      floor.primaryTerm,
      input.replicationConfig,
    )
  }
}

type RemovedSpellings = ReturnType<PartitionManager['removedSpellingsOf']>

export interface AppliedReplicationEntries {
  applied: number
  error: unknown
}

/**
 * Applies one replicated write while holding the index open for the full operation.
 *
 * @param core - The local engine services.
 * @param entry - The replicated write to apply.
 */
export async function applyLocalReplicationEntry(core: EngineCore, entry: ReplicationLogEntry): Promise<void> {
  const { applied, error } = await applyLocalReplicationEntries(core, [entry])
  if (applied === 0) throw error
}

/**
 * Applies a run of replicated writes in log order and makes them durable together, so a batch from the primary
 * costs one log commit. The run stops at the first write that fails, and every write before it stays applied.
 *
 * @param core - The local engine services.
 * @param entries - Replicated writes for one index, in log order.
 * @returns How many leading writes are applied and durable, and the error that stopped the run, if any.
 */
export async function applyLocalReplicationEntries(
  core: EngineCore,
  entries: readonly ReplicationLogEntry[],
): Promise<AppliedReplicationEntries> {
  const first = entries[0]
  if (first === undefined) return { applied: 0, error: null }
  core.guardShutdown()
  const release = await core.indexState.acquire(first.indexName)
  try {
    const indexEntry = core.requireIndex(first.indexName)
    const manager = core.requireManager(first.indexName)
    const vecIndexes = manager.getVectorIndexes()
    const removedSpellings: RemovedSpellings[] = []
    let stopped: unknown = null
    const applyAt = (position: number): void => {
      if (stopped !== null) throw stopped
      const entry = entries[position]
      try {
        if (entry.operation === 'INDEX') {
          applyIndexEntry(entry, manager, indexEntry.vectorFieldPaths, vecIndexes)
        } else {
          removedSpellings[position] = manager.removedSpellingsOf(entry.documentId)
          applyDeleteEntry(entry, manager, vecIndexes, removedSpellings[position])
        }
      } catch (err) {
        stopped = err
        throw err
      }
    }

    let applied = 0
    let error: unknown = null
    const durable = core.durability?.manager
    if (durable === undefined) {
      try {
        for (; applied < entries.length; applied++) applyAt(applied)
      } catch (err) {
        error = err
      }
    } else {
      const outcomes = await durable.recordMutations(
        entries.map((entry, position) => ({
          indexName: entry.indexName,
          partitionId: entry.partitionId,
          operation: entry.operation,
          documentId: entry.documentId,
          document: entry.document,
          apply: () => applyAt(position),
          replicated: entry,
        })),
      )
      for (const outcome of outcomes) {
        if (!outcome.ok) {
          error = outcome.error
          break
        }
        applied++
      }
    }

    for (let position = 0; position < applied; position++) {
      await replicateEntryToWorkers(core, manager, entries[position], removedSpellings[position])
    }
    return { applied, error }
  } finally {
    release()
  }
}

async function replicateEntryToWorkers(
  core: EngineCore,
  manager: PartitionManager,
  entry: ReplicationLogEntry,
  removedSpellings: RemovedSpellings,
): Promise<void> {
  if (entry.operation === 'INDEX') {
    const appliedDocument = manager.getRef(entry.documentId)
    if (appliedDocument === undefined) return
    await core.orchestrator.replicateToWorkers({
      type: 'insert',
      indexName: entry.indexName,
      docId: entry.documentId,
      document: appliedDocument,
      requestId: `replicate-entry-insert-${entry.indexName}-${entry.partitionId}-${entry.seqNo}`,
    })
    return
  }
  await core.orchestrator.replicateToWorkers({
    type: 'remove',
    indexName: entry.indexName,
    docId: entry.documentId,
    requestId: `replicate-entry-remove-${entry.indexName}-${entry.partitionId}-${entry.seqNo}`,
    removedSpellings,
  })
}
