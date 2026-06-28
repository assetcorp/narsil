import { reconstructSchemaFromMetadata } from '../../../engine/recovery-schema'
import { ErrorCodes, NarsilError } from '../../../errors'
import { getLanguage } from '../../../languages/registry'
import { extractVectorFieldsFromSchema } from '../../../schema/validator/schema'
import type { IndexMetadata } from '../../../types/internal'
import type { DurableDirectory } from '../durable-filesystem'
import { collectWalEntriesInRange, snapshotCheckpointFor } from '../recovery'
import type { PartitionCheckpoint } from '../snapshot-bundle'
import { writePartitionBuckets } from './bucket'
import { legacySnapshotKey, manifestKey, segmentPrefix } from './layout'
import { readSegmentManifest } from './load'
import {
  encodeSegmentManifest,
  MAX_BUCKET_COUNT,
  manifestReferencedKeys,
  type PartitionManifestEntry,
  type SegmentManifest,
} from './manifest'
import { writePartitionVectors } from './vector'

export interface SegmentedCheckpointInput {
  directory: DurableDirectory
  metadata: IndexMetadata
  targets: PartitionCheckpoint[]
  initialBucketCount: number
  targetBucketBytes: number
}

export async function writeSegmentedCheckpoint(input: SegmentedCheckpointInput): Promise<void> {
  const { directory, metadata } = input
  const indexName = metadata.indexName
  const config = reconstructSchemaFromMetadata(metadata)
  const language = getLanguage(config.language ?? 'english')
  const vectorFields = extractVectorFieldsFromSchema(config.schema)
  const vectorFieldPaths = new Set(vectorFields.keys())

  const priorManifest = await readSegmentManifest(directory, indexName)
  const initialBucketCount = resolveInitialBucketCount(priorManifest, input.initialBucketCount)
  const targetBucketBytes = resolveTargetBucketBytes(input.targetBucketBytes)

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

    const result = await writePartitionBuckets({
      directory,
      indexName,
      partitionId: target.partitionId,
      config,
      language,
      vectorFieldPaths,
      entries,
      initialBucketCount,
      targetBucketBytes,
      priorGlobalDepth: priorPartition?.globalDepth ?? null,
      priorDirectory: priorPartition?.directory ?? null,
      priorBuckets: priorPartition?.buckets ?? [],
    })

    const vectors = await writePartitionVectors({
      directory,
      indexName,
      partitionId: target.partitionId,
      config,
      language,
      vectorFields,
      vectorFieldPaths,
      entries,
      priorVectors: priorPartition?.vectors ?? [],
    })

    partitions.push({
      partitionId: target.partitionId,
      globalDepth: result.globalDepth,
      directory: result.directory,
      buckets: result.buckets,
      vectors,
    })
  }

  const coveredPartitions = new Set(input.targets.map(t => t.partitionId))
  if (priorManifest !== null) {
    for (const priorPartition of priorManifest.partitions) {
      if (coveredPartitions.has(priorPartition.partitionId)) {
        continue
      }
      partitions.push(priorPartition)
      const priorCheckpoint = priorManifest.checkpoint.find(c => c.partitionId === priorPartition.partitionId)
      if (priorCheckpoint !== undefined && !checkpointByPartition.has(priorPartition.partitionId)) {
        checkpointByPartition.set(priorPartition.partitionId, priorCheckpoint)
      }
    }
  }

  const manifest: SegmentManifest = {
    version: 2,
    initialBucketCount,
    schema: metadata.schema,
    language: metadata.language,
    checkpoint: [...checkpointByPartition.values()],
    partitions,
  }

  const parts = await encodeSegmentManifest(manifest)
  await directory.atomicWrite(manifestKey(indexName), [parts.header, parts.payload])
  await collectGarbage(directory, indexName, priorManifest, manifest)
}

function resolveInitialBucketCount(priorManifest: SegmentManifest | null, configured: number): number {
  const value = priorManifest?.initialBucketCount ?? configured
  if (!Number.isInteger(value) || value <= 0 || value > MAX_BUCKET_COUNT) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Checkpoint initial bucket count ${value} is out of the supported range (1 to ${MAX_BUCKET_COUNT})`,
      { initialBucketCount: value, maximum: MAX_BUCKET_COUNT },
    )
  }
  return value
}

function resolveTargetBucketBytes(configured: number): number {
  if (!Number.isInteger(configured) || configured <= 0) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Checkpoint target bucket size ${configured} must be a positive integer byte count`,
      { targetBucketBytes: configured },
    )
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
