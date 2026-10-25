import { resolveIndexAnalysis } from '../../../analysis/registry'
import type { PartitionInsertOptions } from '../../../core/partition'
import type { PartialWordAnalysis } from '../../../core/partition/partial-words/spellings'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { reconstructSchemaFromMetadata } from '../../../engine/recovery-schema'
import { ErrorCodes, NarsilError } from '../../../errors'
import { getLanguage } from '../../../languages/registry'
import { resolvePartitionInsertOptions } from '../../../partitioning/insert-options'
import { extractVectorFieldsFromSchema, partialFieldsOf } from '../../../schema/validator/schema'
import type { IndexMetadata } from '../../../types/internal'
import type { LanguageModule } from '../../../types/language'
import type { IndexConfig } from '../../../types/schema'
import { DEFAULT_COMPACTION_THRESHOLD } from '../constants'
import type { DurableDirectory } from '../durable-filesystem'
import { checkpointLastSeqNo, type PartitionCheckpoint } from '../partition-checkpoint'
import { walEntriesInRange } from '../wal-segments'
import { buildSegmentFromEntries } from './build-segment'
import { type CapturedWholePartition, contentsOfCaptured, type PartitionContents } from './captured-partition'
import { compactPartitionSegments } from './compaction'
import { manifestKey, segmentsPrefix, snapshotBundleKey } from './layout'
import {
  encodeSegmentManifest,
  MAX_SEGMENTS_PER_PARTITION,
  manifestReferencedKeys,
  type PartitionManifestEntry,
  SEGMENT_MANIFEST_VERSION,
  type SegmentManifest,
  type VectorFieldRef,
} from './manifest'
import { writeSegmentsOf } from './segment-write'
import type { CheckpointStore } from './store'

export interface PriorCheckpoint {
  checkpoint: PartitionCheckpoint[]
  partitions: PartitionManifestEntry[]
}

export interface CheckpointSegmentsInput {
  store: CheckpointStore
  directory?: DurableDirectory
  metadata: IndexMetadata
  targets: PartitionCheckpoint[]
  compactionThreshold: number
  prior: PriorCheckpoint | null
  wholePartitions?: readonly PartitionContents[]
  capturedPartitions?: readonly CapturedWholePartition[]
}

export interface CheckpointSegmentsWritten {
  checkpoint: PartitionCheckpoint[]
  partitions: PartitionManifestEntry[]
}

export interface SegmentedCheckpointOutcome {
  garbage: string[]
}

interface PartitionWriteContext {
  input: CheckpointSegmentsInput
  indexName: string
  config: IndexConfig
  partialWordAnalysis: PartialWordAnalysis | null
  vectorFieldPaths: Set<string>
  compactionThreshold: number
}

interface ResolvedTextAnalysis {
  language: LanguageModule
  options: PartitionInsertOptions | undefined
}

function partialWordAnalysisOf(config: IndexConfig): PartialWordAnalysis | null {
  const fields = partialFieldsOf(config.schema)
  if (fields.length === 0) return null
  let resolved: ResolvedTextAnalysis | null = null
  const resolve = (): ResolvedTextAnalysis => {
    resolved ??= {
      language: getLanguage(config.language ?? 'english'),
      options: resolvePartitionInsertOptions(config, resolveIndexAnalysis(config)),
    }
    return resolved
  }
  return {
    fields,
    get language() {
      return resolve().language
    },
    get options() {
      return resolve().options
    },
  }
}

function resolveCompactionThreshold(configured: number): number {
  if (!Number.isInteger(configured) || configured <= 0 || configured > MAX_SEGMENTS_PER_PARTITION) {
    return DEFAULT_COMPACTION_THRESHOLD
  }
  return configured
}

function wholeContentsOf(input: CheckpointSegmentsInput, partitionId: number): PartitionContents | undefined {
  const whole = input.wholePartitions?.find(candidate => candidate.partitionId === partitionId)
  if (whole !== undefined) return whole
  const captured = input.capturedPartitions?.find(candidate => candidate.partitionId === partitionId)
  return captured === undefined ? undefined : contentsOfCaptured(captured)
}

async function writeWholePartition(
  context: PartitionWriteContext,
  partitionId: number,
  priorPartition: PartitionManifestEntry | undefined,
  whole: PartitionContents,
): Promise<PartitionManifestEntry> {
  const written = await writeSegmentsOf({
    store: context.input.store,
    indexName: context.indexName,
    partitionId,
    nextSegmentId: priorPartition?.nextSegmentId ?? 0,
    schema: context.input.metadata.schema,
    partialWordAnalysis: context.partialWordAnalysis,
    selections: whole.selections,
    tombstones: [],
  })
  return { partitionId, nextSegmentId: written.nextSegmentId, segments: written.segments }
}

async function writeLoggedChanges(
  context: PartitionWriteContext,
  partitionId: number,
  priorPartition: PartitionManifestEntry | undefined,
  entries: AsyncIterable<ReplicationLogEntry>,
): Promise<PartitionManifestEntry> {
  const built = await buildSegmentFromEntries({
    indexName: context.indexName,
    config: context.config,
    language: getLanguage(context.config.language ?? 'english'),
    vectorFieldPaths: context.vectorFieldPaths,
    entries,
  })
  let segments = priorPartition ? [...priorPartition.segments] : []
  let nextSegmentId = priorPartition?.nextSegmentId ?? 0
  if (built !== null) {
    const written = await writeSegmentsOf({
      store: context.input.store,
      indexName: context.indexName,
      partitionId,
      nextSegmentId,
      schema: context.input.metadata.schema,
      partialWordAnalysis: context.partialWordAnalysis,
      selections: built.selections,
      tombstones: built.tombstones,
    })
    segments.push(...written.segments)
    nextSegmentId = written.nextSegmentId
  }
  if (segments.length > MAX_SEGMENTS_PER_PARTITION) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Partition ${partitionId} would exceed the maximum of ${MAX_SEGMENTS_PER_PARTITION} segments`,
      { partitionId, segmentCount: segments.length, maximum: MAX_SEGMENTS_PER_PARTITION },
    )
  }
  const compacted = await compactPartitionSegments({
    store: context.input.store,
    indexName: context.indexName,
    partitionId,
    schema: context.input.metadata.schema,
    partialWordAnalysis: context.partialWordAnalysis,
    segments,
    nextSegmentId,
    compactionThreshold: context.compactionThreshold,
  })
  segments = compacted.segments
  nextSegmentId = compacted.nextSegmentId
  return { partitionId, nextSegmentId, segments }
}

function carryForwardUncheckpointedPartitions(
  prior: PriorCheckpoint | null,
  targets: readonly PartitionCheckpoint[],
  partitions: PartitionManifestEntry[],
  checkpointByPartition: Map<number, PartitionCheckpoint>,
): void {
  if (prior === null) return
  const covered = new Set(targets.map(target => target.partitionId))
  for (const priorPartition of prior.partitions) {
    if (covered.has(priorPartition.partitionId)) continue
    partitions.push(priorPartition)
    const priorCheckpoint = prior.checkpoint.find(c => c.partitionId === priorPartition.partitionId)
    if (priorCheckpoint !== undefined && !checkpointByPartition.has(priorPartition.partitionId)) {
      checkpointByPartition.set(priorPartition.partitionId, priorCheckpoint)
    }
  }
}

export async function writeCheckpointSegments(input: CheckpointSegmentsInput): Promise<CheckpointSegmentsWritten> {
  const config = reconstructSchemaFromMetadata(input.metadata)
  const context: PartitionWriteContext = {
    input,
    indexName: input.metadata.indexName,
    config,
    partialWordAnalysis: partialWordAnalysisOf(config),
    vectorFieldPaths: new Set(extractVectorFieldsFromSchema(config.schema).keys()),
    compactionThreshold: resolveCompactionThreshold(input.compactionThreshold),
  }
  const checkpointByPartition = new Map<number, PartitionCheckpoint>()
  for (const target of input.targets) checkpointByPartition.set(target.partitionId, { ...target })

  const partitions: PartitionManifestEntry[] = []
  for (const target of input.targets) {
    const priorPartition = input.prior?.partitions.find(p => p.partitionId === target.partitionId)
    const whole = wholeContentsOf(input, target.partitionId)
    if (whole !== undefined) {
      partitions.push(await writeWholePartition(context, target.partitionId, priorPartition, whole))
      continue
    }
    if (input.directory === undefined) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_SAVE_FAILED,
        `The checkpoint of partition ${target.partitionId} holds neither the partition's content nor a log to read it from`,
        { partitionId: target.partitionId },
      )
    }
    const priorSeqNo = checkpointLastSeqNo(input.prior?.checkpoint ?? [], target.partitionId)
    const entries = walEntriesInRange(
      input.directory,
      context.indexName,
      target.partitionId,
      priorSeqNo,
      target.lastSeqNo,
    )
    partitions.push(await writeLoggedChanges(context, target.partitionId, priorPartition, entries))
  }
  carryForwardUncheckpointedPartitions(input.prior, input.targets, partitions, checkpointByPartition)
  return { checkpoint: [...checkpointByPartition.values()], partitions }
}

export async function commitCheckpointManifest(
  store: CheckpointStore,
  metadata: IndexMetadata,
  written: CheckpointSegmentsWritten,
  vectors: VectorFieldRef[],
): Promise<SegmentedCheckpointOutcome> {
  const indexName = metadata.indexName
  const manifest: SegmentManifest = {
    version: SEGMENT_MANIFEST_VERSION,
    schema: metadata.schema,
    language: metadata.language,
    checkpoint: written.checkpoint,
    partitions: written.partitions,
    vectors,
  }
  const packed = await encodeSegmentManifest(manifest)
  await store.write(manifestKey(indexName), packed.chunks)
  return { garbage: await unreferencedKeys(store, indexName, manifest) }
}

async function unreferencedKeys(
  store: CheckpointStore,
  indexName: string,
  manifest: SegmentManifest,
): Promise<string[]> {
  const referenced = manifestReferencedKeys(manifest)
  const stored = await store.list(segmentsPrefix(indexName))
  return [...stored.filter(key => !referenced.has(key)), snapshotBundleKey(indexName)]
}

export async function removeCheckpointGarbage(store: CheckpointStore, garbage: readonly string[]): Promise<void> {
  for (const key of garbage) {
    await store.remove(key)
  }
}
