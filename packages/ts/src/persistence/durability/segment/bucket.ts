import { applyDeleteEntry, applyIndexEntry } from '../../../distribution/replication/replica'
import type { ReplicationLogEntry } from '../../../distribution/replication/types'
import { ErrorCodes, NarsilError } from '../../../errors'
import { createPartitionManager, type PartitionManager } from '../../../partitioning/manager'
import { createPartitionRouter } from '../../../partitioning/router'
import { packSnapshotEnvelopeParts, unpackEnvelopeBytes } from '../../../serialization/envelope'
import { deserializePayloadV2 } from '../../../serialization/payload-v2'
import type { LanguageModule } from '../../../types/language'
import type { IndexConfig } from '../../../types/schema'
import type { VectorIndex } from '../../../vector/vector-index'
import type { DurableDirectory } from '../durable-filesystem'
import { bulkLoadPartitionBuckets } from './bulk-load'
import { type BucketDirectory, splitBucket } from './directory'
import { bucketIdForDocument, bucketSegmentKey, MAX_GLOBAL_DEPTH } from './layout'
import type { BucketSegmentRef } from './manifest'
import { MAX_BUCKET_COUNT } from './manifest'

export interface BucketWriteInput {
  directory: DurableDirectory
  indexName: string
  partitionId: number
  config: IndexConfig
  language: LanguageModule
  vectorFieldPaths: Set<string>
  entries: ReplicationLogEntry[]
  initialBucketCount: number
  targetBucketBytes: number
  priorGlobalDepth: number | null
  priorDirectory: number[] | null
  priorBuckets: BucketSegmentRef[]
}

export interface BucketWriteResult {
  globalDepth: number
  directory: number[]
  buckets: BucketSegmentRef[]
}

export async function writePartitionBuckets(input: BucketWriteInput): Promise<BucketWriteResult> {
  if (input.priorDirectory === null || input.priorGlobalDepth === null) {
    return bulkLoadPartitionBuckets({
      directory: input.directory,
      indexName: input.indexName,
      partitionId: input.partitionId,
      config: input.config,
      language: input.language,
      vectorFieldPaths: input.vectorFieldPaths,
      entries: input.entries,
      initialBucketCount: input.initialBucketCount,
      targetBucketBytes: input.targetBucketBytes,
    })
  }

  const routing = initializeRouting(input)
  const localDepthByBucket = buildLocalDepthMap(routing, input.priorBuckets)
  const priorByBucket = new Map<number, BucketSegmentRef>()
  for (const ref of input.priorBuckets) {
    priorByBucket.set(ref.bucketId, ref)
  }

  const entriesByDirtyBucket = new Map<number, ReplicationLogEntry[]>()
  for (const entry of input.entries) {
    const bucketId = routeBucketId(entry.documentId, routing)
    let bucketEntries = entriesByDirtyBucket.get(bucketId)
    if (bucketEntries === undefined) {
      bucketEntries = []
      entriesByDirtyBucket.set(bucketId, bucketEntries)
    }
    bucketEntries.push(entry)
  }

  const survivingRefs = new Map<number, BucketSegmentRef>()
  for (const ref of input.priorBuckets) {
    if (!entriesByDirtyBucket.has(ref.bucketId)) {
      survivingRefs.set(ref.bucketId, ref)
    }
  }

  for (const bucketId of [...entriesByDirtyBucket.keys()].sort((a, b) => a - b)) {
    await rewriteBucket({
      input,
      routing,
      localDepthByBucket,
      bucketId,
      bucketEntries: entriesByDirtyBucket.get(bucketId) ?? [],
      prior: priorByBucket.get(bucketId),
      survivingRefs,
    })
  }

  const buckets = [...survivingRefs.values()].sort((a, b) => a.bucketId - b.bucketId)
  return { globalDepth: routing.globalDepth, directory: routing.slots, buckets }
}

function initializeRouting(input: BucketWriteInput): BucketDirectory {
  if (input.priorDirectory === null || input.priorGlobalDepth === null) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      'Incremental bucket routing requires a prior directory',
      {},
    )
  }
  if (input.priorDirectory.length !== 1 << input.priorGlobalDepth) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `Prior directory size ${input.priorDirectory.length} does not match 2^${input.priorGlobalDepth}`,
      { directorySize: input.priorDirectory.length, globalDepth: input.priorGlobalDepth },
    )
  }
  return { globalDepth: input.priorGlobalDepth, slots: [...input.priorDirectory] }
}

function buildLocalDepthMap(routing: BucketDirectory, priorBuckets: BucketSegmentRef[]): Map<number, number> {
  const localDepthByBucket = new Map<number, number>()
  for (const ref of priorBuckets) {
    localDepthByBucket.set(ref.bucketId, ref.localDepth)
  }
  for (const bucketId of routing.slots) {
    if (!localDepthByBucket.has(bucketId)) {
      localDepthByBucket.set(bucketId, routing.globalDepth)
    }
  }
  return localDepthByBucket
}

function routeBucketId(documentId: string, routing: BucketDirectory): number {
  return bucketIdForDocument(documentId, routing.globalDepth, routing.slots)
}

interface RewriteBucketArgs {
  input: BucketWriteInput
  routing: BucketDirectory
  localDepthByBucket: Map<number, number>
  bucketId: number
  bucketEntries: ReplicationLogEntry[]
  prior: BucketSegmentRef | undefined
  survivingRefs: Map<number, BucketSegmentRef>
}

interface PendingBucket {
  bucketId: number
  entries: ReplicationLogEntry[]
}

async function rewriteBucket(args: RewriteBucketArgs): Promise<void> {
  const { input, routing, localDepthByBucket, prior, survivingRefs } = args
  const priorBytes = prior === undefined ? null : await input.directory.read(prior.key)

  const queue: PendingBucket[] = [{ bucketId: args.bucketId, entries: args.bucketEntries }]
  let guard = 0
  const guardLimit = MAX_BUCKET_COUNT * 2

  while (queue.length > 0) {
    guard += 1
    if (guard > guardLimit) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_SAVE_FAILED,
        'Bucket splitting exceeded the allowed iteration bound',
        { bucketId: args.bucketId, guardLimit },
      )
    }
    const pending = queue.shift()
    if (pending === undefined) {
      break
    }
    const currentBucketId = pending.bucketId

    const localDepth = localDepthByBucket.get(currentBucketId)
    if (localDepth === undefined) {
      throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `Bucket ${currentBucketId} has no recorded depth`, {
        bucketId: currentBucketId,
      })
    }

    const manager = await materializeBucket(input, priorBytes, currentBucketId, routing, pending.entries)
    if (manager.countDocuments() === 0) {
      survivingRefs.delete(currentBucketId)
      continue
    }

    const payload = manager.serializePartitionToBytes(0)
    const canSplit = payload.length > input.targetBucketBytes && localDepth < MAX_GLOBAL_DEPTH

    if (!canSplit) {
      const generation = nextGeneration(input.priorBuckets, currentBucketId)
      const ref = await writeBucketSegment(input, currentBucketId, localDepth, generation, payload)
      survivingRefs.set(currentBucketId, ref)
      continue
    }

    const { highBucketId } = splitBucket(routing, localDepthByBucket, currentBucketId)
    survivingRefs.delete(currentBucketId)
    survivingRefs.delete(highBucketId)
    queue.push(
      { bucketId: currentBucketId, entries: filterEntriesForBucket(pending.entries, currentBucketId, routing) },
      { bucketId: highBucketId, entries: filterEntriesForBucket(pending.entries, highBucketId, routing) },
    )
  }
}

function filterEntriesForBucket(
  entries: ReplicationLogEntry[],
  bucketId: number,
  routing: BucketDirectory,
): ReplicationLogEntry[] {
  return entries.filter(entry => routeBucketId(entry.documentId, routing) === bucketId)
}

async function materializeBucket(
  input: BucketWriteInput,
  priorBytes: Uint8Array | null,
  bucketId: number,
  routing: BucketDirectory,
  bucketEntries: ReplicationLogEntry[],
): Promise<PartitionManager> {
  const router = createPartitionRouter()
  const vectorSink = new Map<string, VectorIndex>()
  const manager = createPartitionManager(input.indexName, input.config, input.language, router, 1, vectorSink)

  if (priorBytes !== null) {
    const { payloadBytes } = await unpackEnvelopeBytes(priorBytes)
    manager.deserializePartition(0, deserializePayloadV2(payloadBytes))
    pruneForeignDocuments(manager, bucketId, routing)
  }

  for (const entry of bucketEntries) {
    if (entry.operation === 'DELETE') {
      applyDeleteEntry(entry, manager, vectorSink)
    } else {
      applyIndexEntry(entry, manager, input.vectorFieldPaths, vectorSink)
    }
  }

  return manager
}

function pruneForeignDocuments(manager: PartitionManager, bucketId: number, routing: BucketDirectory): void {
  const partition = manager.getPartition(0)
  const foreign: string[] = []
  for (const docId of partition.docIds()) {
    if (routeBucketId(docId, routing) !== bucketId) {
      foreign.push(docId)
    }
  }
  for (const docId of foreign) {
    manager.remove(docId)
  }
}

function nextGeneration(priorBuckets: BucketSegmentRef[], bucketId: number): number {
  let highest = 0
  for (const ref of priorBuckets) {
    if (ref.bucketId === bucketId && ref.generation > highest) {
      highest = ref.generation
    }
  }
  return highest + 1
}

async function writeBucketSegment(
  input: BucketWriteInput,
  bucketId: number,
  localDepth: number,
  generation: number,
  payload: Uint8Array,
): Promise<BucketSegmentRef> {
  const key = bucketSegmentKey(input.indexName, input.partitionId, bucketId, generation)
  const parts = await packSnapshotEnvelopeParts(payload)
  await input.directory.atomicWrite(key, [parts.header, parts.payload])
  return { bucketId, localDepth, generation, key }
}
