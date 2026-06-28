import { applyDeleteEntry, applyIndexEntry } from '../../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { ErrorCodes, NarsilError } from '../../../errors'
import { createPartitionManager, type PartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import { packSnapshotEnvelopeParts } from '../../../serialization/envelope'
import type { LanguageModule } from '../../../types/language'
import type { IndexConfig } from '../../../types/schema'
import type { VectorIndex } from '../../../vector/vector-index'
import type { DurableDirectory } from '../durable-filesystem'
import { identityDirectory } from './directory'
import { bucketSegmentKey, lowBits, MAX_GLOBAL_DEPTH } from './layout'
import { type BucketSegmentRef, MAX_BUCKET_COUNT } from './manifest'

export interface ColdLoadInput {
  directory: DurableDirectory
  indexName: string
  partitionId: number
  config: IndexConfig
  language: LanguageModule
  vectorFieldPaths: Set<string>
  entries: ReplicationLogEntry[]
  initialBucketCount: number
  targetBucketBytes: number
}

export interface ColdLoadResult {
  globalDepth: number
  directory: number[]
  buckets: BucketSegmentRef[]
}

interface SizingResult {
  totalSerializedBytes: number
  liveDocIds: Set<string>
}

export async function bulkLoadPartitionBuckets(input: ColdLoadInput): Promise<ColdLoadResult> {
  const sizing = measureFullPartition(input)
  if (sizing.liveDocIds.size === 0) {
    return { globalDepth: 0, directory: [0], buckets: [] }
  }

  const byteDepth = chooseColdGlobalDepth(sizing.totalSerializedBytes, input.targetBucketBytes)
  const floorDepth = initialBucketDepth(input.initialBucketCount)
  const globalDepth = Math.max(byteDepth, floorDepth)
  const routing = identityDirectory(globalDepth)
  const buckets = await routeAndWriteBuckets(input, sizing.liveDocIds, globalDepth)
  return { globalDepth: routing.globalDepth, directory: routing.slots, buckets }
}

function initialBucketDepth(initialBucketCount: number): number {
  if (!Number.isInteger(initialBucketCount) || initialBucketCount <= 0 || initialBucketCount > MAX_BUCKET_COUNT) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Initial bucket count ${initialBucketCount} is out of the supported range (1 to ${MAX_BUCKET_COUNT})`,
      { initialBucketCount, maximum: MAX_BUCKET_COUNT },
    )
  }
  let depth = 0
  while (1 << depth < initialBucketCount && depth < MAX_GLOBAL_DEPTH) {
    depth += 1
  }
  return depth
}

function measureFullPartition(input: ColdLoadInput): SizingResult {
  const manager = newSingletonManager(input)
  for (const entry of input.entries) {
    applyEntry(entry, manager, input.vectorFieldPaths)
  }
  const totalSerializedBytes = manager.serializePartitionToBytes(0).length
  const liveDocIds = new Set<string>(manager.getPartition(0).docIds())
  return { totalSerializedBytes, liveDocIds }
}

export function chooseColdGlobalDepth(totalSerializedBytes: number, targetBucketBytes: number): number {
  if (totalSerializedBytes <= targetBucketBytes) {
    return 0
  }
  const targetBucketCount = Math.ceil(totalSerializedBytes / targetBucketBytes)
  let depth = 0
  while (1 << depth < targetBucketCount && depth < MAX_GLOBAL_DEPTH) {
    depth += 1
  }
  return depth
}

const MAX_OUTSTANDING_BUCKET_WRITES = 8

async function routeAndWriteBuckets(
  input: ColdLoadInput,
  liveDocIds: Set<string>,
  globalDepth: number,
): Promise<BucketSegmentRef[]> {
  const entriesByBucket = groupLiveEntriesByBucket(input.entries, liveDocIds, globalDepth)
  const bucketIds = [...entriesByBucket.keys()].sort((a, b) => a - b)
  const refs: BucketSegmentRef[] = []
  const inFlight = new Set<Promise<void>>()
  let firstFailure: unknown = null

  for (const bucketId of bucketIds) {
    if (firstFailure !== null) {
      break
    }
    const prepared = buildBucketPayload(input, bucketId, globalDepth, entriesByBucket.get(bucketId) ?? [])
    if (prepared === null) {
      continue
    }
    const tracked = packAndWriteBucket(input, prepared)
      .then(ref => {
        refs.push(ref)
      })
      .catch(err => {
        if (firstFailure === null) {
          firstFailure = err
        }
      })
      .finally(() => {
        inFlight.delete(tracked)
      })
    inFlight.add(tracked)
    if (inFlight.size >= MAX_OUTSTANDING_BUCKET_WRITES) {
      await Promise.race(inFlight)
    }
  }

  await Promise.all(inFlight)
  if (firstFailure !== null) {
    throw firstFailure
  }
  refs.sort((a, b) => a.bucketId - b.bucketId)
  return refs
}

interface PreparedBucketPayload {
  key: string
  payload: Uint8Array
  ref: BucketSegmentRef
}

function buildBucketPayload(
  input: ColdLoadInput,
  bucketId: number,
  globalDepth: number,
  bucketEntries: ReplicationLogEntry[],
): PreparedBucketPayload | null {
  const bucketManager = newSingletonManager(input)
  for (const entry of bucketEntries) {
    applyEntry(entry, bucketManager, input.vectorFieldPaths)
  }
  if (bucketManager.countDocuments() === 0) {
    return null
  }
  const payload = bucketManager.serializePartitionToBytes(0)
  const generation = 1
  const key = bucketSegmentKey(input.indexName, input.partitionId, bucketId, generation)
  return { key, payload, ref: { bucketId, localDepth: globalDepth, generation, key } }
}

async function packAndWriteBucket(input: ColdLoadInput, prepared: PreparedBucketPayload): Promise<BucketSegmentRef> {
  const parts = await packSnapshotEnvelopeParts(prepared.payload)
  await input.directory.atomicWrite(prepared.key, [parts.header, parts.payload])
  return prepared.ref
}

function groupLiveEntriesByBucket(
  entries: ReplicationLogEntry[],
  liveDocIds: Set<string>,
  globalDepth: number,
): Map<number, ReplicationLogEntry[]> {
  const byBucket = new Map<number, ReplicationLogEntry[]>()
  for (const entry of entries) {
    if (!liveDocIds.has(entry.documentId)) {
      continue
    }
    const bucketId = lowBits(entry.documentId, globalDepth)
    let bucketEntries = byBucket.get(bucketId)
    if (bucketEntries === undefined) {
      bucketEntries = []
      byBucket.set(bucketId, bucketEntries)
    }
    bucketEntries.push(entry)
  }
  return byBucket
}

function newSingletonManager(input: ColdLoadInput): PartitionManager {
  const router = createPartitionRouter()
  const vectorSink = new Map<string, VectorIndex>()
  return createPartitionManager(input.indexName, input.config, input.language, router, 1, vectorSink)
}

function applyEntry(entry: ReplicationLogEntry, manager: PartitionManager, vectorFieldPaths: Set<string>): void {
  const vectorSink = manager.getVectorIndexes()
  if (entry.operation === 'DELETE') {
    applyDeleteEntry(entry, manager, vectorSink)
    return
  }
  applyIndexEntry(entry, manager, vectorFieldPaths, vectorSink)
}
