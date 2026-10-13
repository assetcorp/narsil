import type { PartitionManager } from '../../../partitioning/manager'
import type { IndexMetadata } from '../../../types/internal'
import type { VectorIndex } from '../../../vector/vector-index'
import type { VectorCheckpointPlan } from '../../../vector/vector-index/checkpoint-plan'
import type { PartitionCheckpoint } from '../partition-checkpoint'
import { partitionContentsOf } from '../segment/captured-partition'
import { reclaimUnlistedKeys } from '../segment/load'
import type { FileRef, PartitionManifestEntry, VectorFieldRef } from '../segment/manifest'
import type { CheckpointStore } from '../segment/store'
import { adoptVectorLayouts, garbageThatNoFieldStillReads, recordWrittenVectors } from '../segment/vector-adoption'
import { writeLiveVectors } from '../segment/vector-write'
import { commitCheckpointManifest, removeCheckpointGarbage, writeCheckpointSegments } from '../segment/write'
import { loadSnapshotBundle } from './bundle'
import { loadEarlierLayout } from './load'
import { type EarlierManifest, earlierReferencedKeys } from './manifest'

export type EarlierLayout = { kind: 'manifest'; manifest: EarlierManifest } | { kind: 'bundle'; bytes: Uint8Array }

export type LayoutUpgradeStatus = 'started' | 'completed' | 'failed'

export interface LayoutUpgradeEvent {
  indexName: string
  status: LayoutUpgradeStatus
  layout: EarlierLayout['kind']
  error?: Error
}

export interface LayoutUpgradeDeps {
  store: CheckpointStore
  indexName: string
  metadata: IndexMetadata
  manager: PartitionManager
  vectorIndexes: Map<string, VectorIndex>
  storedTermsAreCurrent: boolean
  compactionThreshold: number
  replay(checkpoint: PartitionCheckpoint[]): Promise<PartitionCheckpoint[]>
  onLayoutUpgrade?(event: LayoutUpgradeEvent): void
}

export interface LayoutUpgraded {
  checkpoint: PartitionCheckpoint[]
  documentCount: number
}

async function loadEarlier(
  deps: LayoutUpgradeDeps,
  earlier: EarlierLayout,
): Promise<{ checkpoint: PartitionCheckpoint[]; fileRefs: Map<string, FileRef> }> {
  const loadDeps = {
    manager: deps.manager,
    vectorIndexes: deps.vectorIndexes,
    storedTermsAreCurrent: deps.storedTermsAreCurrent,
  }
  if (earlier.kind === 'bundle') {
    await reclaimUnlistedKeys(deps.store, deps.indexName, new Set())
    return { checkpoint: await loadSnapshotBundle(earlier.bytes, loadDeps), fileRefs: new Map() }
  }
  await reclaimUnlistedKeys(deps.store, deps.indexName, earlierReferencedKeys(earlier.manifest))
  const loaded = await loadEarlierLayout(deps.store, deps.indexName, earlier.manifest, loadDeps)
  return { checkpoint: loaded.checkpoint, fileRefs: loaded.vectorFileRefs }
}

function priorVectorsOf(earlier: EarlierLayout, fileRefs: ReadonlyMap<string, FileRef>): VectorFieldRef[] {
  if (earlier.kind === 'bundle') return []
  return earlier.manifest.vectors.map(field => ({
    fieldPath: field.fieldPath,
    nextFileId: field.nextFileId,
    graphGeneration: field.graphGeneration,
    graphParts: [],
    files: field.files.flatMap(file => {
      const ref = fileRefs.get(file.key)
      return ref === undefined ? [] : [{ ...file, bytes: ref.bytes, checksum: ref.checksum }]
    }),
  }))
}

function priorPartitionsOf(earlier: EarlierLayout, partitionCount: number): PartitionManifestEntry[] {
  if (earlier.kind === 'bundle') return []
  return earlier.manifest.partitions
    .filter(partition => partition.partitionId < partitionCount)
    .map(partition => ({ partitionId: partition.partitionId, nextSegmentId: partition.nextSegmentId, segments: [] }))
}

async function writeCurrentLayout(
  deps: LayoutUpgradeDeps,
  earlier: EarlierLayout,
  targets: PartitionCheckpoint[],
  fileRefs: ReadonlyMap<string, FileRef>,
): Promise<void> {
  const priorVectors = priorVectorsOf(earlier, fileRefs)
  const plans = new Map<string, VectorCheckpointPlan>()
  for (const [fieldPath, vectorIndex] of deps.vectorIndexes) {
    await vectorIndex.completeGraph()
    const listed = priorVectors.find(ref => ref.fieldPath === fieldPath)
    plans.set(
      fieldPath,
      vectorIndex.planCheckpoint(listed === undefined ? null : listed.files.map(file => file.key), true),
    )
  }
  const written = await writeCheckpointSegments({
    store: deps.store,
    metadata: deps.metadata,
    targets,
    compactionThreshold: deps.compactionThreshold,
    prior: { checkpoint: [], partitions: priorPartitionsOf(earlier, deps.manager.partitionCount) },
    wholePartitions: targets.map(target => partitionContentsOf(deps.manager, target.partitionId)),
  })
  const vectors = await writeLiveVectors({
    store: deps.store,
    indexName: deps.indexName,
    plans,
    priorVectors,
    priorFileRefs: fileRefs,
  })
  const committed = await commitCheckpointManifest(deps.store, deps.metadata, written, vectors.refs)
  recordWrittenVectors(deps.vectorIndexes, vectors.written)
  await adoptVectorLayouts(deps.store, deps.vectorIndexes, vectors.layouts)
  await removeCheckpointGarbage(
    deps.store,
    await garbageThatNoFieldStillReads(deps.store, deps.vectorIndexes, committed.garbage),
  )
}

export async function upgradeEarlierLayout(deps: LayoutUpgradeDeps, earlier: EarlierLayout): Promise<LayoutUpgraded> {
  deps.onLayoutUpgrade?.({ indexName: deps.indexName, status: 'started', layout: earlier.kind })
  try {
    const loaded = await loadEarlier(deps, earlier)
    const targets = await deps.replay(loaded.checkpoint)
    await writeCurrentLayout(deps, earlier, targets, loaded.fileRefs)
    deps.onLayoutUpgrade?.({ indexName: deps.indexName, status: 'completed', layout: earlier.kind })
    return { checkpoint: targets, documentCount: deps.manager.countDocuments() }
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    deps.onLayoutUpgrade?.({ indexName: deps.indexName, status: 'failed', layout: earlier.kind, error: failure })
    throw failure
  }
}
