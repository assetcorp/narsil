import { ErrorCodes, isCompositePartition, NarsilError } from '#platform/worker-copies-host'
import { type SharedFrozenSegment, shareFrozenSegment } from '../core/partition/frozen/share'
import type { PartitionIndex } from '../core/partition/partition-index'
import type { SegmentPayload } from '../core/partition/segment-payload'
import type { PartitionManager } from '../partitioning/manager'
import type { SerializablePartition } from '../types/internal'
import type { AnyDocument, IndexConfig } from '../types/schema'
import type { CopyPublication } from '../workers/copy-publication'
import { holdCopyPublication } from '../workers/copy-publication'
import { type Executor, executeUntilAnswered } from '../workers/executor'
import type { WorkerPool } from '../workers/pool'

export interface CopySource {
  config: IndexConfig
  synonyms: Uint8Array | null
  onPublication?: (publication: CopyPublication) => void
}

let copyLoadSequence = 0

interface CapturedLiveTail {
  payload: SegmentPayload
  documents: AnyDocument[]
}

interface CapturedPartition {
  partitionId: number
  empty: SerializablePartition
  live: CapturedLiveTail | null
  frozen: SharedFrozenSegment[]
}

export function emptySerializablePartition(manager: PartitionManager, partitionId: number): SerializablePartition {
  return {
    indexName: manager.indexName,
    partitionId,
    totalPartitions: manager.partitionCount,
    language: manager.language.name,
    schema: {},
    docCount: 0,
    avgDocLength: 0,
    documents: {},
    invertedIndex: {},
    fieldIndexes: { numeric: {}, boolean: {}, enum: {}, geopoint: {} },
    statistics: { totalDocuments: 0, totalFieldLengths: {}, averageFieldLengths: {}, docFrequencies: {} },
  }
}

function captureLiveTail(partition: PartitionIndex): CapturedLiveTail | null {
  if (partition.count() === 0) return null
  const payload = partition.encodeSegment()
  const documents = payload.docIds.map(docId => {
    const document = partition.getRef(docId)
    if (document === undefined) {
      throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, `Document "${docId}" vanished while copying a partition`, {
        docId,
      })
    }
    return document
  })
  return { payload, documents }
}

function captureComposite(manager: PartitionManager, partitionId: number): CapturedPartition | null {
  const partition = manager.getPartition(partitionId)
  if (!isCompositePartition(partition)) return null
  const segmentIds = partition.frozenSegmentSizes().map(size => size.segmentId)
  const frozen: SharedFrozenSegment[] = []
  for (const segment of partition.frozenSegmentsById(segmentIds)) {
    const shared = shareFrozenSegment(segment, manager.partialWordAnalysis)
    if (shared === null) return null
    frozen.push(shared)
  }
  return {
    partitionId,
    empty: emptySerializablePartition(manager, partitionId),
    live: captureLiveTail(partition.live),
    frozen,
  }
}

function capturePartitions(manager: PartitionManager): CapturedPartition[] {
  const captured: CapturedPartition[] = []
  for (let partitionId = 0; partitionId < manager.partitionCount; partitionId++) {
    captured.push(
      captureComposite(manager, partitionId) ?? {
        partitionId,
        empty: emptySerializablePartition(manager, partitionId),
        live: captureLiveTail(manager.getPartition(partitionId)),
        frozen: [],
      },
    )
  }
  return captured
}

async function captureCopy(manager: PartitionManager) {
  for (;;) {
    const vectors = [...manager.getVectorIndexes()]
    await Promise.all(vectors.map(([, vector]) => vector.prepareCopyPublication()))
    const captured = await manager.publication.write(() => {
      const current = manager.getVectorIndexes()
      if (current.size !== vectors.length || vectors.some(([name, vector]) => current.get(name) !== vector)) return null
      if (vectors.some(([, vector]) => vector.maintenanceStatus().loadingFromFiles)) return null
      const partitions = capturePartitions(manager)
      const { embedding, ...settings } = manager.config
      const config: IndexConfig = structuredClone({
        ...settings,
        ...(embedding === undefined
          ? {}
          : {
              embedding: {
                fields: embedding.fields,
                ...(typeof embedding.adapter === 'string' ? { adapter: embedding.adapter } : {}),
              },
            }),
      })
      const synonyms = manager.synonyms?.encodedRules.slice() ?? null
      return { captured: partitions, config, synonyms, held: holdCopyPublication(manager, false) }
    })
    if (captured !== null) return captured
  }
}

async function sendPartition(
  manager: PartitionManager,
  executors: Executor[],
  captured: CapturedPartition,
): Promise<void> {
  const { indexName } = manager
  await Promise.all(
    executors.map(workerExecutor =>
      workerExecutor.execute({
        type: 'deserialize',
        indexName,
        partitionId: captured.partitionId,
        data: captured.empty,
        requestId: `resync-${indexName}-${captured.partitionId}`,
      }),
    ),
  )
  const live = captured.live
  if (live !== null) {
    await Promise.all(
      executors.map(workerExecutor =>
        workerExecutor.execute({
          type: 'mergeSegments',
          indexName,
          segments: [{ partitionId: captured.partitionId, payload: live.payload, documents: live.documents }],
          requestId: `resync-live-${indexName}-${captured.partitionId}`,
        }),
      ),
    )
  }
  if (captured.frozen.length === 0) return
  const segments = captured.frozen.map(shared => ({
    partitionId: captured.partitionId,
    snapshot: shared.snapshot,
    tombstonedDocIds: shared.tombstonedDocIds,
    survivingSurfaceForms: shared.survivingSurfaceForms,
  }))
  await Promise.all(
    executors.map(workerExecutor =>
      workerExecutor.execute({
        type: 'attachSegments',
        indexName,
        segments,
        requestId: `resync-attach-${indexName}-${captured.partitionId}`,
      }),
    ),
  )
}

/**
 * Loads a copy of one index onto every worker of the pool from what the main
 * copy holds at the moment of the call.
 *
 * This reads the main copy in one synchronous span before any message reaches
 * a worker, so a write that arrives while the workers load reaches them
 * through the replication queue alone. A
 * frozen segment travels as shared memory where the runtime offers it, and
 * the live tail of each partition travels serialised.
 *
 * @param indexName - The index to copy.
 * @param pool - The worker pool that receives the copies.
 * @param source - The index configuration each worker creates the index from, and the encoded synonym set it applies.
 * @param manager - The main copy to read.
 * @param analysisStale - Whether the main copy's stored analysis is stale, so
 * that each copy reports the same on its results.
 */
export function transferIndexToPool(
  indexName: string,
  pool: WorkerPool,
  source: CopySource,
  manager: PartitionManager,
  analysisStale = false,
): Promise<string> {
  return loadIndexOntoWorkers(
    indexName,
    pool.getAllExecutors(),
    source,
    manager,
    () => pool.addIndexToAll(indexName),
    analysisStale,
  )
}

/**
 * Loads a copy of one index onto the given workers from what the main copy
 * holds at the moment of the call, reading the main copy in one synchronous
 * span before any message reaches a worker.
 *
 * @param indexName - The index to copy.
 * @param executors - The workers that receive the copy.
 * @param source - The index configuration each worker creates the index from, and the encoded synonym set it applies.
 * @param manager - The main copy to read.
 * @param onDropped - Runs once every worker has dropped its old copy, before the new one loads.
 * @param analysisStale - Whether the main copy's stored analysis is stale, so
 * that each copy reports the same on its results.
 */
export async function loadIndexOntoWorkers(
  indexName: string,
  executors: Executor[],
  source: CopySource,
  manager: PartitionManager,
  onDropped?: () => void,
  analysisStale = false,
): Promise<string> {
  copyLoadSequence += 1
  const copyLoad = `${indexName}#${copyLoadSequence}`
  const { captured, held, config, synonyms } = await captureCopy(manager)
  try {
    source.onPublication?.(held.publication)
    await Promise.allSettled(
      executors.map(workerExecutor =>
        workerExecutor.execute({ type: 'dropIndex', indexName, requestId: `resync-drop-${indexName}` }),
      ),
    )
    onDropped?.()
    const created = await Promise.allSettled(
      executors.map(workerExecutor =>
        executeUntilAnswered(
          workerExecutor,
          {
            type: 'createIndex',
            indexName,
            config,
            requestId: `resync-create-${indexName}`,
            analysisStale,
            copyLoad,
            publication: held.publication,
            partitionCount: captured.length,
            ...(synonyms !== null ? { synonyms } : {}),
          },
          held.retain(),
        ),
      ),
    )
    const failure = created.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    for (const partition of captured) {
      await sendPartition(manager, executors, partition)
    }
    return copyLoad
  } catch (error) {
    await Promise.allSettled(
      executors.map(executor =>
        executor.execute({
          type: 'dropIndex',
          indexName,
          requestId: `failed-load-${copyLoad}`,
        }),
      ),
    )
    throw error
  } finally {
    held.release()
  }
}
