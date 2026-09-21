import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { reconstructSchemaFromMetadata } from '../../../engine/recovery-schema'
import { ErrorCodes, NarsilError } from '../../../errors'
import { getLanguage } from '../../../languages/registry'
import { extractVectorFieldsFromSchema } from '../../../schema/validator/schema'
import type { IndexMetadata } from '../../../types/internal'
import type { IndexConfig } from '../../../types/schema'
import { DEFAULT_COMPACTION_THRESHOLD } from '../constants'
import type { DurableDirectory } from '../durable-filesystem'
import { snapshotCheckpointFor } from '../recovery'
import type { PartitionCheckpoint } from '../snapshot-bundle'
import { walEntriesInRange } from '../wal-segments'
import { buildSegmentFromEntries } from './build-segment'
import { type CapturedWholePartition, serializeCapturedPartition } from './captured-partition'
import { compactPartitionSegments } from './compaction'
import { manifestKey, segmentKey, segmentsPrefix, snapshotBundleKey } from './layout'
import { readSegmentManifest } from './load'
import {
  encodeSegmentManifest,
  MAX_SEGMENTS_PER_PARTITION,
  manifestReferencedKeys,
  type PartitionManifestEntry,
  SEGMENT_MANIFEST_VERSION,
  type SegmentManifest,
  type SegmentRef,
  type VectorSegmentRef,
} from './manifest'
import { persistSegmentFile } from './segment-file'

export interface SegmentedCheckpointInput {
  directory: DurableDirectory
  metadata: IndexMetadata
  targets: PartitionCheckpoint[]
  compactionThreshold: number
  wholePartitions?: ReadonlyMap<number, WholePartitionSegment>
  capturedPartitions?: readonly CapturedWholePartition[]
  vectors?: VectorSegmentRef[]
}

export interface WholePartitionSegment {
  payload: Uint8Array
  docCount: number
}

export interface SegmentedCheckpointOutcome {
  documentCount: number | null
  garbage: string[]
}

export type CheckpointSegmentsInput = Omit<SegmentedCheckpointInput, 'vectors'>

export interface CheckpointSegmentsWritten {
  checkpoint: PartitionCheckpoint[]
  partitions: PartitionManifestEntry[]
}

interface PartitionWriteContext {
  directory: DurableDirectory
  indexName: string
  config: IndexConfig
  languageName: string
  vectorFieldPaths: Set<string>
  compactionThreshold: number
}

export async function writeSegmentedCheckpoint(input: SegmentedCheckpointInput): Promise<SegmentedCheckpointOutcome> {
  const written = await writeCheckpointSegments(input)
  return commitCheckpointManifest(input.directory, input.metadata, written, input.vectors)
}

export async function commitCheckpointManifest(
  directory: DurableDirectory,
  metadata: IndexMetadata,
  written: CheckpointSegmentsWritten,
  vectors?: VectorSegmentRef[],
): Promise<SegmentedCheckpointOutcome> {
  const indexName = metadata.indexName
  const manifest: SegmentManifest = {
    version: SEGMENT_MANIFEST_VERSION,
    schema: metadata.schema,
    language: metadata.language,
    checkpoint: written.checkpoint,
    partitions: written.partitions,
    vectors: vectors ?? (await readSegmentManifest(directory, indexName))?.vectors ?? [],
  }

  const parts = await encodeSegmentManifest(manifest)
  await directory.atomicWrite(manifestKey(indexName), [parts.header, parts.payload])
  const garbage = await unreferencedKeys(directory, indexName, manifest)
  return { documentCount: null, garbage }
}

export async function writeCheckpointSegments(input: CheckpointSegmentsInput): Promise<CheckpointSegmentsWritten> {
  const { directory, metadata } = input
  const indexName = metadata.indexName
  const config = reconstructSchemaFromMetadata(metadata)
  const vectorFields = extractVectorFieldsFromSchema(config.schema)
  const compactionThreshold = resolveCompactionThreshold(input.compactionThreshold)

  const context: PartitionWriteContext = {
    directory,
    indexName,
    config,
    languageName: config.language ?? 'english',
    vectorFieldPaths: new Set(vectorFields.keys()),
    compactionThreshold,
  }

  const priorManifest = await readSegmentManifest(directory, indexName)
  const checkpointByPartition = new Map<number, PartitionCheckpoint>()
  for (const target of input.targets) {
    checkpointByPartition.set(target.partitionId, {
      partitionId: target.partitionId,
      lastSeqNo: target.lastSeqNo,
      primaryTerm: target.primaryTerm,
    })
  }

  const partitions: PartitionManifestEntry[] = []
  for (const target of input.targets) {
    const priorPartition = priorManifest?.partitions.find(p => p.partitionId === target.partitionId)
    const priorSeqNo = snapshotCheckpointFor(priorManifest?.checkpoint ?? [], target.partitionId)
    const whole =
      input.wholePartitions?.get(target.partitionId) ??
      serializedFromCapture(context, input.capturedPartitions, target.partitionId)
    if (whole === undefined) {
      const entries = walEntriesInRange(directory, indexName, target.partitionId, priorSeqNo, target.lastSeqNo)
      partitions.push(await writePartition(context, target.partitionId, priorPartition, entries))
    } else {
      partitions.push(await writeWholePartition(context, target.partitionId, priorPartition, whole))
    }
  }

  carryForwardUncheckpointedPartitions(priorManifest, input.targets, partitions, checkpointByPartition)
  return { checkpoint: [...checkpointByPartition.values()], partitions }
}

function serializedFromCapture(
  context: PartitionWriteContext,
  capturedPartitions: readonly CapturedWholePartition[] | undefined,
  partitionId: number,
): WholePartitionSegment | undefined {
  const captured = capturedPartitions?.find(candidate => candidate.partitionId === partitionId)
  if (captured === undefined) return undefined
  return {
    payload: serializeCapturedPartition(context.indexName, context.config, context.languageName, captured),
    docCount: captured.docCount,
  }
}

async function writePartition(
  context: PartitionWriteContext,
  partitionId: number,
  priorPartition: PartitionManifestEntry | undefined,
  entries: AsyncIterable<ReplicationLogEntry>,
): Promise<PartitionManifestEntry> {
  let segments: SegmentRef[] = priorPartition ? [...priorPartition.segments] : []
  let nextSegmentId = priorPartition?.nextSegmentId ?? 0
  const language = getLanguage(context.languageName)

  const built = await buildSegmentFromEntries({
    indexName: context.indexName,
    config: context.config,
    language,
    vectorFieldPaths: context.vectorFieldPaths,
    entries,
  })

  if (built !== null) {
    const id = nextSegmentId
    const key = segmentKey(context.indexName, partitionId, id)
    await persistSegmentFile(context.directory, key, built.payload, built.tombstones)
    segments.push({ id, key, docCount: built.docCount, tombstoneCount: built.tombstones.length })
    nextSegmentId = id + 1
  }

  if (segments.length > MAX_SEGMENTS_PER_PARTITION) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Partition ${partitionId} would exceed the maximum of ${MAX_SEGMENTS_PER_PARTITION} segments`,
      { partitionId, segmentCount: segments.length, maximum: MAX_SEGMENTS_PER_PARTITION },
    )
  }

  const compacted = await compactPartitionSegments({
    directory: context.directory,
    indexName: context.indexName,
    partitionId,
    config: context.config,
    language,
    segments,
    nextSegmentId,
    compactionThreshold: context.compactionThreshold,
  })
  segments = compacted.segments
  nextSegmentId = compacted.nextSegmentId

  return { partitionId, nextSegmentId, segments }
}

async function writeWholePartition(
  context: PartitionWriteContext,
  partitionId: number,
  priorPartition: PartitionManifestEntry | undefined,
  whole: WholePartitionSegment,
): Promise<PartitionManifestEntry> {
  const id = priorPartition?.nextSegmentId ?? 0
  const key = segmentKey(context.indexName, partitionId, id)
  await persistSegmentFile(context.directory, key, whole.payload, [])
  return {
    partitionId,
    nextSegmentId: id + 1,
    segments: [{ id, key, docCount: whole.docCount, tombstoneCount: 0 }],
  }
}

function carryForwardUncheckpointedPartitions(
  priorManifest: SegmentManifest | null,
  targets: PartitionCheckpoint[],
  partitions: PartitionManifestEntry[],
  checkpointByPartition: Map<number, PartitionCheckpoint>,
): void {
  if (priorManifest === null) {
    return
  }
  const covered = new Set(targets.map(t => t.partitionId))
  for (const priorPartition of priorManifest.partitions) {
    if (covered.has(priorPartition.partitionId)) {
      continue
    }
    partitions.push(priorPartition)
    const priorCheckpoint = priorManifest.checkpoint.find(c => c.partitionId === priorPartition.partitionId)
    if (priorCheckpoint !== undefined && !checkpointByPartition.has(priorPartition.partitionId)) {
      checkpointByPartition.set(priorPartition.partitionId, priorCheckpoint)
    }
  }
}

function resolveCompactionThreshold(configured: number): number {
  if (!Number.isInteger(configured) || configured <= 0 || configured > MAX_SEGMENTS_PER_PARTITION) {
    return DEFAULT_COMPACTION_THRESHOLD
  }
  return configured
}

async function unreferencedKeys(
  directory: DurableDirectory,
  indexName: string,
  manifest: SegmentManifest,
): Promise<string[]> {
  const referenced = manifestReferencedKeys(manifest)
  const stored = await directory.list(segmentsPrefix(indexName))
  return [...stored.filter(key => !referenced.has(key)), snapshotBundleKey(indexName)]
}

export async function removeCheckpointGarbage(directory: DurableDirectory, garbage: readonly string[]): Promise<void> {
  for (const key of garbage) {
    await directory.remove(key)
  }
}
