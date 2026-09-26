import { ErrorCodes, NarsilError } from '../../errors'
import { writeMetadataEnvelope } from '../../serialization/envelope'
import type { VectorIndex } from '../../vector/vector-index'
import { reclaimWalBeyondCount, truncateCoveredSegments } from './checkpoint'
import {
  captureCheckpoint,
  makeEveryAppliedMutationDurable,
  wholePartitionsWhereMostChanged,
  writeCapturedVectors,
} from './checkpoint-capture'
import { checkpointWorkerIsUsable } from './checkpoint-worker-dispatch'
import { writeIndexCheckpointSegments } from './checkpoint-write'
import type { DurableDirectory } from './durable-filesystem'
import type { IndexState } from './manager-state'
import { snapshotCheckpointFor } from './recovery'
import {
  commitCheckpointManifest,
  readSegmentManifest,
  removeCheckpointGarbage,
  type VectorCheckpointLayout,
} from './segment'
import type { PartitionCheckpoint } from './snapshot-bundle'
import type { IndexDurabilityHooks } from './types'
import { noteCheckpointCommitted } from './write-stall'

interface DurableCheckpointInput {
  directory: DurableDirectory
  hooks: IndexDurabilityHooks
  indexName: string
  indexState: IndexState
  compactionThreshold: number
  canOffload: boolean
  fromMemory: boolean
  mutationThreshold: number
  mayContinue(): boolean
  queueMetadataWrite(indexName: string, write: () => Promise<void>): Promise<void>
  markFatal(error: Error): void
}

async function bothOrTheFirstFailure<A, B>(first: Promise<A>, second: Promise<B>): Promise<[A, B]> {
  const [firstSettled, secondSettled] = await Promise.allSettled([first, second])
  if (firstSettled.status === 'rejected') throw firstSettled.reason
  if (secondSettled.status === 'rejected') throw secondSettled.reason
  return [firstSettled.value, secondSettled.value]
}

async function adoptVectorLayouts(
  directory: DurableDirectory,
  vectorIndexes: Map<string, VectorIndex>,
  layouts: readonly VectorCheckpointLayout[],
): Promise<void> {
  for (const layout of layouts) {
    const vecIndex = vectorIndexes.get(layout.fieldPath)
    if (vecIndex === undefined || vecIndex.storage !== 'disk') continue
    const path = await directory.pathOf(layout.key)
    await vecIndex.adoptDiskLayout({ path, docIds: layout.docIds, vectorsOffset: layout.vectorsOffset })
  }
}

async function garbageThatNoFieldStillReads(
  directory: DurableDirectory,
  vectorIndexes: Map<string, VectorIndex>,
  keys: readonly string[],
): Promise<string[]> {
  const read = new Set<string>()
  for (const vectorIndex of vectorIndexes.values()) {
    for (const path of vectorIndex.vectorFilesInUse()) read.add(path)
  }
  if (read.size === 0) return [...keys]
  const unread: string[] = []
  for (const key of keys) {
    if (!read.has(await directory.pathOf(key))) unread.push(key)
  }
  return unread
}

/**
 * Writes a durable checkpoint and reclaims the WAL data it covers.
 *
 * One checkpoint covers a bounded number of log records, so that the memory it needs stays
 * the same however far the log has run ahead. When records remain, the next checkpoint
 * starts at once, until the log is covered or `mayContinue` answers false.
 *
 * @param input - The index state, durability hooks, and storage settings for the checkpoint.
 * @returns A promise that settles after metadata and WAL cleanup finish.
 */
export async function runDurableCheckpoint(input: DurableCheckpointInput): Promise<void> {
  try {
    let recordsLeftInLog = await writeOneBoundedCheckpoint(input)
    while (recordsLeftInLog > 0 && input.mayContinue()) {
      recordsLeftInLog = await writeOneBoundedCheckpoint(input)
    }
  } catch (err) {
    if (err instanceof NarsilError) throw err
    const error = new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The engine cannot write the checkpoint of index "${input.indexName}" to the durability directory "${input.directory.root}"`,
      {
        indexName: input.indexName,
        directory: input.directory.root,
        cause: err instanceof Error ? err.message : String(err),
      },
    )
    input.markFatal(error)
    throw error
  }
}

async function writeOneBoundedCheckpoint(input: DurableCheckpointInput): Promise<number> {
  const manager = input.hooks.getManager(input.indexName)
  if (manager === undefined) {
    return 0
  }
  const metadata = input.hooks.buildMetadata(input.indexName)
  if (metadata === undefined) {
    return 0
  }

  const vectorIndexes = input.hooks.getVectorIndexes(input.indexName)
  const priorManifest = await readSegmentManifest(input.directory, input.indexName)
  const capture = await captureCheckpoint(
    input.indexState,
    manager,
    vectorIndexes,
    wholePartitionsWhereMostChanged(manager, {
      priorCheckpoint: priorManifest?.checkpoint ?? [],
      priorPartitionIds: (priorManifest?.partitions ?? []).map(partition => partition.partitionId),
      everyPartition: input.fromMemory,
      aWorkerCanSerialise: input.canOffload && checkpointWorkerIsUsable(),
    }),
    input.fromMemory ? undefined : (priorManifest?.checkpoint ?? []),
    priorManifest?.vectors ?? [],
  )
  const { targets, documentCount } = capture
  await makeEveryAppliedMutationDurable(input.indexState, input.markFatal)
  const [liveVectors, segments] = await bothOrTheFirstFailure(
    writeCapturedVectors(input.directory, input.indexName, capture, priorManifest, input.fromMemory),
    writeIndexCheckpointSegments({
      directory: input.directory,
      metadata,
      targets,
      compactionThreshold: input.compactionThreshold,
      canOffload: input.canOffload,
      wholePartitions: capture.wholePartitions.serialized,
      capturedPartitions: capture.wholePartitions.captured,
    }),
  )
  await makeEveryAppliedMutationDurable(input.indexState, input.markFatal)

  const written = await commitCheckpointManifest(input.directory, metadata, segments, liveVectors.vectors)
  for (const field of liveVectors.written) {
    vectorIndexes.get(field.fieldPath)?.recordCheckpoint(field.plan, field.files)
  }
  await adoptVectorLayouts(input.directory, vectorIndexes, liveVectors.layouts)
  await removeCheckpointGarbage(
    input.directory,
    await garbageThatNoFieldStillReads(input.directory, vectorIndexes, written.garbage),
  )
  const checkpointDocumentCount = written.documentCount ?? documentCount
  await input.queueMetadataWrite(input.indexName, async () => {
    const checkpointMetadata = input.hooks.buildMetadata(input.indexName, checkpointDocumentCount)
    if (checkpointMetadata === undefined) {
      return
    }
    const bytes = await writeMetadataEnvelope(checkpointMetadata, { checksum: true })
    await input.directory.atomicWrite(`${input.indexName}/meta`, bytes)
    input.hooks.recordCheckpoint?.(input.indexName, checkpointDocumentCount, manager.partitionCount)
  })
  await truncateCoveredSegments(input.directory, input.indexName, targets)
  await reclaimWalBeyondCount(
    input.directory,
    input.indexName,
    manager.partitionCount,
    input.indexState.partitions,
    input.markFatal,
  )
  const beyondTheCheckpoint = recordsBeyond(input.indexState, targets)
  noteCheckpointCommitted(input.indexState, beyondTheCheckpoint)
  const anotherIsDue = input.mutationThreshold > 0 && beyondTheCheckpoint >= input.mutationThreshold
  return anotherIsDue ? beyondTheCheckpoint : capture.recordsLeftInLog
}

function recordsBeyond(indexState: IndexState, targets: PartitionCheckpoint[]): number {
  let records = 0
  for (const [partitionId, partition] of indexState.partitions) {
    records += Math.max(0, partition.appliedSeqNo - snapshotCheckpointFor(targets, partitionId))
  }
  return records
}
