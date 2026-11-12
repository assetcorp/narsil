import type { PartitionManager } from '../../../partitioning/manager'
import { captureAppliedPrefix } from '../../../partitioning/manager/checkpoint-prefix'
import { writeMetadataEnvelope } from '../../../serialization/envelope'
import type { PersistenceAdapter } from '../../../types/adapters'
import type { IndexMetadata } from '../../../types/internal'
import type { VectorCheckpointPlan, VectorIndex } from '../../../vector/vector-index'
import { whileGraphsStayComplete } from '../complete-graphs'
import { DEFAULT_COMPACTION_THRESHOLD } from '../constants'
import { checkpointLastSeqNo, type PartitionCheckpoint } from '../partition-checkpoint'
import { partitionContentsOf } from '../segment/captured-partition'
import { readCurrentManifest } from '../segment/load'
import { manifestWithinPartitionCount, type SegmentManifest } from '../segment/manifest'
import { adapterCheckpointStore, type CheckpointStore } from '../segment/store'
import { garbageThatNoFieldStillReads, recordWrittenVectors } from '../segment/vector-adoption'
import { writeLiveVectors } from '../segment/vector-write'
import {
  checkpointGarbage,
  commitCheckpointManifest,
  removeCheckpointGarbage,
  writeCheckpointSegments,
} from '../segment/write'
import { SINGLE_NODE_PRIMARY_TERM } from '../seq-owner'
import type { StoredBytes } from '../stored-bytes'
import type { IndexDurabilityHooks } from '../types'
import { metadataKey } from './index-state'

export interface SnapshotOnlyCheckpointCommitted {
  saved: StoredBytes
  documentCount: number
  partitionCount: number
}

export interface SnapshotOnlyCheckpointInput {
  adapter: PersistenceAdapter
  indexName: string
  metadata: IndexMetadata
  manager: PartitionManager
  vectorIndexes: Map<string, VectorIndex>
  appliedSeqNoByPartition: ReadonlyMap<number, number>
  rewritesEveryPartition: boolean
  onCommitted(committed: SnapshotOnlyCheckpointCommitted): Promise<void>
}

interface CapturedState {
  targets: PartitionCheckpoint[]
  plans: Map<string, VectorCheckpointPlan>
  documentCount: number
  contents: ReturnType<typeof partitionContentsOf>[]
  positions: Map<number, number>
  partitionCount: number
}

function capture(
  input: SnapshotOnlyCheckpointInput,
  prior: SegmentManifest | null,
  cutoffs: ReadonlyMap<number, number>,
): CapturedState {
  const listedIds = new Set((prior?.partitions ?? []).map(partition => partition.partitionId))
  const partitionCountChanged = prior !== null && listedIds.size !== input.manager.partitionCount
  const targets: PartitionCheckpoint[] = []
  const contents: ReturnType<typeof partitionContentsOf>[] = []
  const positions = new Map<number, number>()
  for (let partitionId = 0; partitionId < input.manager.partitionCount; partitionId += 1) {
    const lastSeqNo = Math.min(
      input.appliedSeqNoByPartition.get(partitionId) ?? 0,
      cutoffs.get(partitionId) ?? Infinity,
    )
    positions.set(partitionId, lastSeqNo)
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
  try {
    for (const [fieldPath, vectorIndex] of input.vectorIndexes) {
      const listed = prior?.vectors.find(ref => ref.fieldPath === fieldPath)
      plans.set(
        fieldPath,
        vectorIndex.planCheckpoint(listed === undefined ? null : listed.files.map(file => file.key), false, true),
      )
    }
    return {
      targets,
      plans,
      documentCount: input.manager.countDocuments(),
      contents,
      positions,
      partitionCount: input.manager.partitionCount,
    }
  } catch (error) {
    for (const plan of plans.values()) plan.release()
    throw error
  }
}

async function writeCaptured(
  input: SnapshotOnlyCheckpointInput,
  store: CheckpointStore,
  prior: SegmentManifest | null,
  captured: CapturedState,
): Promise<void> {
  const priorWithinCount = prior === null ? null : manifestWithinPartitionCount(prior, captured.partitionCount)
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
  await input.onCommitted({
    saved: committed.saved,
    documentCount: captured.documentCount,
    partitionCount: captured.partitionCount,
  })
  const garbage = await checkpointGarbage(store, input.indexName, committed.manifest)
  await removeCheckpointGarbage(store, await garbageThatNoFieldStillReads(store, input.vectorIndexes, garbage))
}

export async function saveCheckpointMetadata(
  adapter: PersistenceAdapter,
  hooks: IndexDurabilityHooks,
  indexName: string,
  committed: SnapshotOnlyCheckpointCommitted,
): Promise<void> {
  const { saved, documentCount, partitionCount } = committed
  const checkpointMetadata = hooks.buildMetadata(indexName, documentCount, saved.bytes)
  if (checkpointMetadata === undefined) return
  checkpointMetadata.partitionCount = partitionCount
  await adapter.save(metadataKey(indexName), await writeMetadataEnvelope(checkpointMetadata, { checksum: true }))
  hooks.recordCheckpoint?.(indexName, documentCount, partitionCount, saved.bytes)
}

export async function writeSnapshotOnlyCheckpoint(input: SnapshotOnlyCheckpointInput): Promise<{
  positions: ReadonlyMap<number, number>
  partitionCount: number
}> {
  const store = adapterCheckpointStore(input.adapter)
  const { prior, captured } = await whileGraphsStayComplete(input.vectorIndexes, async () => {
    const prior = await readCurrentManifest(store, input.indexName)
    const captured = await captureAppliedPrefix(input.manager, cutoffs => capture(input, prior, cutoffs))
    return { prior, captured }
  })
  try {
    await writeCaptured(input, store, prior, captured)
    return { positions: captured.positions, partitionCount: captured.partitionCount }
  } finally {
    for (const plan of captured.plans.values()) plan.release()
  }
}
