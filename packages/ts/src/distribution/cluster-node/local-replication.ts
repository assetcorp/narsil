import type { RemovedSpellings } from '../../core/partition/frozen/surface-slot'
import type { EngineCore } from '../../engine/core'
import type { PartitionManager } from '../../partitioning/manager'
import type { PartitionLogPosition } from '../../persistence/durability/types'
import type { WorkerAction } from '../../workers/protocol'
import type { ClusterCoordinator, PartitionAssignment } from '../coordinator/types'
import { applyDeleteEntry, applyIndexEntry } from '../replication/replica'
import type { ReplicationConfig, ReplicationLog, ReplicationLogEntry } from '../replication/types'
import type { ClusterLocalEngine } from './local-engine'
import { seedReplicationLog } from './replication-logs'
import type { ClusterWriteRecords } from './write-records/keeper'

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

function requestIdOf(kind: WorkerAction['type'], entry: ReplicationLogEntry): string {
  return `replicate-entry-${kind}-${entry.indexName}-${entry.partitionId}-${entry.seqNo}`
}

function publishIndexEntry(core: EngineCore, manager: PartitionManager, entry: ReplicationLogEntry): void {
  const document = entry.document === null ? undefined : manager.getRef(entry.documentId)
  if (document === undefined) return
  core.orchestrator.publishToWorkers({
    type: 'update',
    indexName: entry.indexName,
    docId: entry.documentId,
    document,
    requestId: requestIdOf('update', entry),
  })
}

function publishRemoval(
  core: EngineCore,
  entry: ReplicationLogEntry,
  removedSpellings: RemovedSpellings | undefined,
): void {
  core.orchestrator.publishToWorkers({
    type: 'remove',
    indexName: entry.indexName,
    docId: entry.documentId,
    requestId: requestIdOf('remove', entry),
    removedSpellings,
  })
}

export interface AppliedReplicationEntries {
  applied: number
  error: unknown
}

/**
 * Applies one replicated write while holding the index open for the full operation.
 *
 * @param core - The local engine services.
 * @param entry - The replicated write to apply.
 * @param writeRecords - The cluster's per-document write records, updated with the write.
 */
export async function applyLocalReplicationEntry(
  core: EngineCore,
  entry: ReplicationLogEntry,
  writeRecords: ClusterWriteRecords,
): Promise<void> {
  const { applied, error } = await applyLocalReplicationEntries(core, [entry], writeRecords)
  if (applied === 0) throw error
}

/**
 * Applies a run of replicated writes in log order and makes them durable together, so a batch from the primary
 * costs one log commit. The run stops at the first write that fails, and every write before it stays applied.
 *
 * @param core - The local engine services.
 * @param entries - Replicated writes for one index, in log order.
 * @param writeRecords - The cluster's per-document write records, updated with each write as it applies.
 * @returns How many leading writes are applied and durable, and the error that stopped the run, if any.
 */
export async function applyLocalReplicationEntries(
  core: EngineCore,
  entries: readonly ReplicationLogEntry[],
  writeRecords: ClusterWriteRecords,
): Promise<AppliedReplicationEntries> {
  const first = entries[0]
  if (first === undefined) return { applied: 0, error: null }
  core.guardShutdown()
  const release = await core.indexState.acquire(first.indexName)
  try {
    const indexEntry = core.requireIndex(first.indexName)
    const manager = core.requireManager(first.indexName)
    const vecIndexes = manager.getVectorIndexes()
    let stopped: unknown = null
    const applyAt = (position: number): Promise<void> =>
      manager.publication.write(() => {
        if (stopped !== null) throw stopped
        const entry = entries[position]
        const held = manager.has(entry.documentId)
        const removedSpellings = held ? manager.removedSpellingsOf(entry.documentId) : undefined
        try {
          if (entry.operation === 'INDEX') {
            applyIndexEntry(entry, manager, indexEntry.vectorFieldPaths, vecIndexes, false)
          } else {
            applyDeleteEntry(entry, manager, vecIndexes, removedSpellings)
          }
          writeRecords.applied(entry)
          if (entry.operation === 'INDEX') publishIndexEntry(core, manager, entry)
          else if (held) publishRemoval(core, entry, removedSpellings)
        } catch (err) {
          if (held && !manager.has(entry.documentId)) publishRemoval(core, entry, removedSpellings)
          stopped = err
          throw err
        }
      })

    let applied = 0
    let error: unknown = null
    const durable = core.durability?.manager
    if (durable === undefined) {
      try {
        for (; applied < entries.length; applied++) await applyAt(applied)
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

    if (applied > 0) {
      for (const vector of vecIndexes.values()) vector.scheduleBuild()
    }
    await core.orchestrator.settlePublications(first.indexName)
    return { applied, error }
  } finally {
    release()
  }
}
