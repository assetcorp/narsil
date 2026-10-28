import type { PartitionManager } from '../../../partitioning/manager'
import type { PersistenceAdapter } from '../../../types/adapters'
import type { IndexMetadata } from '../../../types/internal'
import type { VectorCheckpointPlan, VectorIndex } from '../../../vector/vector-index'
import { DEFAULT_COMPACTION_THRESHOLD } from '../constants'
import { checkpointLastSeqNo, type PartitionCheckpoint } from '../partition-checkpoint'
import { partitionContentsOf } from '../segment/captured-partition'
import { readCurrentManifest } from '../segment/load'
import type { SegmentManifest } from '../segment/manifest'
import { adapterCheckpointStore, type CheckpointStore } from '../segment/store'
import { garbageThatNoFieldStillReads, recordWrittenVectors } from '../segment/vector-adoption'
import { writeLiveVectors } from '../segment/vector-write'
import { commitCheckpointManifest, removeCheckpointGarbage, writeCheckpointSegments } from '../segment/write'
import { SINGLE_NODE_PRIMARY_TERM } from '../seq-owner'

export interface SnapshotOnlyCheckpointInput {
  adapter: PersistenceAdapter
  indexName: string
  metadata: IndexMetadata
  manager: PartitionManager
  vectorIndexes: Map<string, VectorIndex>
  appliedSeqNoByPartition: ReadonlyMap<number, number>
  rewritesEveryPartition: boolean
}

interface CapturedState {
  targets: PartitionCheckpoint[]
  plans: Map<string, VectorCheckpointPlan>
  documentCount: number
  contents: ReturnType<typeof partitionContentsOf>[]
}

function capture(input: SnapshotOnlyCheckpointInput, prior: SegmentManifest | null): CapturedState {
  const listedIds = new Set((prior?.partitions ?? []).map(partition => partition.partitionId))
  const partitionCountChanged = prior !== null && listedIds.size !== input.manager.partitionCount
  const targets: PartitionCheckpoint[] = []
  const contents: ReturnType<typeof partitionContentsOf>[] = []
  for (let partitionId = 0; partitionId < input.manager.partitionCount; partitionId += 1) {
    const lastSeqNo = input.appliedSeqNoByPartition.get(partitionId) ?? 0
    const unchanged =
      !input.rewritesEveryPartition &&
      prior !== null &&
      !partitionCountChanged &&
      listedIds.has(partitionId) &&
      checkpointLastSeqNo(prior.checkpoint, partitionId) === lastSeqNo
    if (unchanged) continue
    targets.push({ partitionId, lastSeqNo, primaryTerm: SINGLE_NODE_PRIMARY_TERM })
    contents.push(partitionContentsOf(input.manager, partitionId))
  }
  const plans = new Map<string, VectorCheckpointPlan>()
  for (const [fieldPath, vectorIndex] of input.vectorIndexes) {
    const listed = prior?.vectors.find(ref => ref.fieldPath === fieldPath)
    plans.set(fieldPath, vectorIndex.planCheckpoint(listed === undefined ? null : listed.files.map(file => file.key)))
  }
  return { targets, plans, documentCount: input.manager.countDocuments(), contents }
}

async function writeCaptured(
  input: SnapshotOnlyCheckpointInput,
  store: CheckpointStore,
  prior: SegmentManifest | null,
  captured: CapturedState,
): Promise<void> {
  const partitionCount = input.manager.partitionCount
  const priorWithinCount =
    prior === null
      ? null
      : {
          checkpoint: prior.checkpoint.filter(entry => entry.partitionId < partitionCount),
          partitions: prior.partitions.filter(partition => partition.partitionId < partitionCount),
        }
  const written = await writeCheckpointSegments({
    store,
    metadata: input.metadata,
    targets: captured.targets,
    compactionThreshold: DEFAULT_COMPACTION_THRESHOLD,
    prior: priorWithinCount,
    wholePartitions: captured.contents,
  })
  const vectors = await writeLiveVectors({
    store,
    indexName: input.indexName,
    plans: captured.plans,
    priorVectors: prior?.vectors ?? [],
  })
  const committed = await commitCheckpointManifest(store, input.metadata, written, vectors.refs)
  recordWrittenVectors(input.vectorIndexes, vectors.written)
  await removeCheckpointGarbage(
    store,
    await garbageThatNoFieldStillReads(store, input.vectorIndexes, committed.garbage),
  )
}

export async function writeSnapshotOnlyCheckpoint(input: SnapshotOnlyCheckpointInput): Promise<number> {
  const store = adapterCheckpointStore(input.adapter)
  for (const vectorIndex of input.vectorIndexes.values()) await vectorIndex.completeGraph()
  const prior = await readCurrentManifest(store, input.indexName)
  const captured = capture(input, prior)
  await writeCaptured(input, store, prior, captured)
  return captured.documentCount
}
