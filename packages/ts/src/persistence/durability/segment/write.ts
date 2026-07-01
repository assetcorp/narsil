import { reconstructSchemaFromMetadata } from '../../../engine/recovery-schema'
import { ErrorCodes, NarsilError } from '../../../errors'
import { getLanguage } from '../../../languages/registry'
import { extractVectorFieldsFromSchema } from '../../../schema/validator/schema'
import type { IndexMetadata } from '../../../types/internal'
import type { LanguageModule } from '../../../types/language'
import type { IndexConfig } from '../../../types/schema'
import type { DurableDirectory } from '../durable-filesystem'
import { collectWalEntriesInRange, snapshotCheckpointFor } from '../recovery'
import type { PartitionCheckpoint } from '../snapshot-bundle'
import { buildSegmentFromEntries } from './build-segment'
import { compactPartitionSegments } from './compaction'
import { DEFAULT_COMPACTION_THRESHOLD, legacySnapshotKey, manifestKey, segmentKey, segmentPrefix } from './layout'
import { readSegmentManifest } from './load'
import {
  encodeSegmentManifest,
  MAX_SEGMENTS_PER_PARTITION,
  manifestReferencedKeys,
  type PartitionManifestEntry,
  type SegmentManifest,
  type SegmentRef,
} from './manifest'
import { persistSegmentFile } from './segment-file'
import { writePartitionVectors } from './vector'

export interface SegmentedCheckpointInput {
  directory: DurableDirectory
  metadata: IndexMetadata
  targets: PartitionCheckpoint[]
  compactionThreshold: number
}

interface PartitionWriteContext {
  directory: DurableDirectory
  indexName: string
  config: IndexConfig
  language: LanguageModule
  vectorFields: Map<string, number>
  vectorFieldPaths: Set<string>
  compactionThreshold: number
}

export async function writeSegmentedCheckpoint(input: SegmentedCheckpointInput): Promise<void> {
  const { directory, metadata } = input
  const indexName = metadata.indexName
  const config = reconstructSchemaFromMetadata(metadata)
  const language = getLanguage(config.language ?? 'english')
  const vectorFields = extractVectorFieldsFromSchema(config.schema)
  const compactionThreshold = resolveCompactionThreshold(input.compactionThreshold)

  const context: PartitionWriteContext = {
    directory,
    indexName,
    config,
    language,
    vectorFields,
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
    const entries = await collectWalEntriesInRange(
      directory,
      indexName,
      target.partitionId,
      priorSeqNo,
      target.lastSeqNo,
    )
    partitions.push(await writePartition(context, target.partitionId, priorPartition, entries))
  }

  carryForwardUncheckpointedPartitions(priorManifest, input.targets, partitions, checkpointByPartition)

  const manifest: SegmentManifest = {
    version: 3,
    schema: metadata.schema,
    language: metadata.language,
    checkpoint: [...checkpointByPartition.values()],
    partitions,
  }

  const parts = await encodeSegmentManifest(manifest)
  await directory.atomicWrite(manifestKey(indexName), [parts.header, parts.payload])
  await collectGarbage(directory, indexName, priorManifest, manifest)
}

async function writePartition(
  context: PartitionWriteContext,
  partitionId: number,
  priorPartition: PartitionManifestEntry | undefined,
  entries: Awaited<ReturnType<typeof collectWalEntriesInRange>>,
): Promise<PartitionManifestEntry> {
  let segments: SegmentRef[] = priorPartition ? [...priorPartition.segments] : []
  let nextSegmentId = priorPartition?.nextSegmentId ?? 0

  const built = buildSegmentFromEntries({
    indexName: context.indexName,
    config: context.config,
    language: context.language,
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
    language: context.language,
    segments,
    nextSegmentId,
    compactionThreshold: context.compactionThreshold,
  })
  segments = compacted.segments
  nextSegmentId = compacted.nextSegmentId

  const vectors = await writePartitionVectors({
    directory: context.directory,
    indexName: context.indexName,
    partitionId,
    config: context.config,
    language: context.language,
    vectorFields: context.vectorFields,
    vectorFieldPaths: context.vectorFieldPaths,
    entries,
    priorVectors: priorPartition?.vectors ?? [],
  })

  return { partitionId, nextSegmentId, segments, vectors }
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

async function collectGarbage(
  directory: DurableDirectory,
  indexName: string,
  priorManifest: SegmentManifest | null,
  manifest: SegmentManifest,
): Promise<void> {
  const referenced = manifestReferencedKeys(manifest)
  const partitionIds = new Set<number>()
  for (const partition of manifest.partitions) {
    partitionIds.add(partition.partitionId)
  }
  if (priorManifest !== null) {
    for (const partition of priorManifest.partitions) {
      partitionIds.add(partition.partitionId)
    }
  }

  for (const partitionId of partitionIds) {
    const prefix = segmentPrefix(indexName, partitionId)
    for (const key of await directory.list(prefix)) {
      if (!referenced.has(key)) {
        await directory.remove(key)
      }
    }
  }
  await directory.remove(legacySnapshotKey(indexName))
}
