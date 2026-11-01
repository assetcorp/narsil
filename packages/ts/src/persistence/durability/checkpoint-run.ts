import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import type { PartitionWriteLog } from '../../partitioning/manager/write-log'
import { writeMetadataEnvelope } from '../../serialization/envelope'
import type { IndexMetadata } from '../../types/internal'
import { createRequestId } from '../../workers/protocol'
import { reclaimWalBeyondCount, truncateCoveredSegments } from './checkpoint'
import {
  aTargetFailed,
  type CheckpointCapture,
  captureCheckpoint,
  makeEveryAppliedMutationDurable,
  openNewLogSegments,
  whileNoMutationApplies,
  wholePartitionsWhereMostChanged,
  writeCapturedVectors,
} from './checkpoint-capture'
import { checkpointWorkerIsUsable } from './checkpoint-worker-dispatch'
import { writeIndexCheckpointSegments } from './checkpoint-write'
import type { DurableDirectory } from './durable-filesystem'
import type { IndexState } from './manager-state'
import type { PartitionFailure } from './mutation-batch'
import type { PartitionCheckpoint } from './partition-checkpoint'
import { snapshotCheckpointFor } from './recovery'
import { readCurrentManifest } from './segment/load'
import type { PartitionManifestEntry, SegmentManifest } from './segment/manifest'
import { type CheckpointStore, directoryCheckpointStore } from './segment/store'
import { adoptVectorLayouts, garbageThatNoFieldStillReads, recordWrittenVectors } from './segment/vector-adoption'
import { commitCheckpointManifest, removeCheckpointGarbage } from './segment/write'
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
  holdsCheckpointFiles(): boolean
  queueMetadataWrite(indexName: string, write: () => Promise<void>): Promise<void>
  markFatal(error: Error): void
  failPartition: PartitionFailure
}

async function bothOrTheFirstFailure<A, B>(first: Promise<A>, second: Promise<B>): Promise<[A, B]> {
  const [firstSettled, secondSettled] = await Promise.allSettled([first, second])
  if (firstSettled.status === 'rejected') throw firstSettled.reason
  if (secondSettled.status === 'rejected') throw secondSettled.reason
  return [firstSettled.value, secondSettled.value]
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
    if (!isSystemError(err)) throw err
    const error = new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The engine cannot write the checkpoint of index "${input.indexName}" to the durability directory "${input.directory.root}"`,
      {
        indexName: input.indexName,
        directory: input.directory.root,
        cause: err.message,
      },
    )
    input.markFatal(error)
    throw error
  }
}

function isSystemError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error && !(err instanceof NarsilError) && typeof (err as NodeJS.ErrnoException).code === 'string'
  )
}

async function writeOneBoundedCheckpoint(input: DurableCheckpointInput): Promise<number> {
  const manager = input.hooks.getManager(input.indexName)
  if (manager === undefined) {
    return 0
  }
  const metadata = input.hooks.buildTermsMetadata(input.indexName)
  if (metadata === undefined) {
    return 0
  }
  const fromMemory = input.fromMemory || input.hooks.mustRewriteTerms(input.indexName)

  const vectorIndexes = input.hooks.getVectorIndexes(input.indexName)
  const store = directoryCheckpointStore(input.directory)
  const writeRecords = input.hooks.writeRecords ?? null
  const { indexName } = input
  const priorManifest = await readCurrentManifest(store, input.indexName)
  const textOnDisk = metadata.textStorage === 'disk'
  const wholePartitionsOf = wholePartitionsWhereMostChanged(manager, {
    priorCheckpoint: priorManifest?.checkpoint ?? [],
    priorPartitionIds: (priorManifest?.partitions ?? []).map(partition => partition.partitionId),
    everyPartition: fromMemory,
    aWorkerCanSerialise: input.canOffload && !textOnDisk && checkpointWorkerIsUsable(),
    ...(writeRecords === null
      ? {}
      : {
          captureRecords: partitionId => segments => writeRecords.captureSegments(indexName, partitionId, segments),
        }),
  })
  let changesSinceCapture: PartitionWriteLog | null = null
  const capture = await captureCheckpoint(
    input.indexState,
    manager,
    vectorIndexes,
    textOnDisk && !fromMemory ? undefined : wholePartitionsOf,
    fromMemory ? undefined : (priorManifest?.checkpoint ?? []),
    priorManifest?.vectors ?? [],
    writeRecords === null
      ? undefined
      : (partitionId, lastSeqNo) => writeRecords.termHistoryOf(indexName, partitionId, lastSeqNo),
    textOnDisk
      ? () => {
          changesSinceCapture = manager.openCheckpointChangeLog()
        }
      : undefined,
  )
  try {
    await openNewLogSegments(input.indexState, input.failPartition)
    return await finishBoundedCheckpoint(input, manager, store, metadata, priorManifest, capture, fromMemory, () => {
      return changesSinceCapture
    })
  } finally {
    ;(changesSinceCapture as PartitionWriteLog | null)?.close()
  }
}

async function adoptWrittenSegments(
  input: DurableCheckpointInput,
  manager: PartitionManager,
  partitions: readonly PartitionManifestEntry[],
  changes: PartitionWriteLog,
): Promise<readonly string[]> {
  const { indexName, indexState, hooks } = input
  const { actionPartitionsOf, closeUnusedSegments, prepareDiskAdoption, swapPreparedPartitions } = await import(
    '../paged/module'
  )
  const adoption = await prepareDiskAdoption(input.directory, manager, partitions)
  if (adoption === null) return []
  const adopted = await whileNoMutationApplies([...indexState.partitions.values()], () => {
    if (changes.partitionsReplaced) return false
    const changed = changes.takeWrittenDocIds()
    swapPreparedPartitions(manager, adoption.partitions, changed, (partitionId, segments) => {
      hooks.writeRecords?.adoptPagedSegments(indexName, partitionId, segments, changed)
    })
    hooks.queueDiskAdoption?.({
      type: 'adoptDiskSegments',
      indexName,
      partitions: actionPartitionsOf(adoption),
      changed: [...changed],
      requestId: createRequestId(),
    })
    return true
  })
  if (!adopted) {
    closeUnusedSegments(adoption)
    return []
  }
  await hooks.awaitCopiesOfIndex?.(indexName)
  return adoption.droppedKeys
}

async function finishBoundedCheckpoint(
  input: DurableCheckpointInput,
  manager: PartitionManager,
  store: CheckpointStore,
  metadata: IndexMetadata,
  priorManifest: SegmentManifest | null,
  capture: CheckpointCapture,
  fromMemory: boolean,
  changesSinceCapture: () => PartitionWriteLog | null,
): Promise<number> {
  const vectorIndexes = input.hooks.getVectorIndexes(input.indexName)
  const writeRecords = input.hooks.writeRecords ?? null
  const { targets, documentCount } = capture
  await makeEveryAppliedMutationDurable(input.indexState, input.failPartition)
  if (aTargetFailed(input.indexState, targets)) return 0
  const [liveVectors, segments] = await bothOrTheFirstFailure(
    writeCapturedVectors(store, input.indexName, capture, priorManifest, fromMemory),
    writeIndexCheckpointSegments({
      directory: input.directory,
      metadata,
      targets,
      compactionThreshold: input.compactionThreshold,
      canOffload: input.canOffload,
      prior: priorManifest,
      wholePartitions: capture.wholePartitions.contents,
      capturedPartitions: capture.wholePartitions.captured,
      keepsWriteRecords: writeRecords !== null,
    }),
  )
  await makeEveryAppliedMutationDurable(input.indexState, input.failPartition)
  if (aTargetFailed(input.indexState, targets)) return 0

  const written = await commitCheckpointManifest(store, metadata, segments, liveVectors.vectors)
  input.hooks.onManifestCommitted(input.indexName, metadata.analysisGeneration ?? 0)
  recordWrittenVectors(vectorIndexes, liveVectors.written)
  await adoptVectorLayouts(store, vectorIndexes, liveVectors.layouts)
  const changes = changesSinceCapture()
  const droppedThisCheckpoint =
    changes !== null && capture.recordsLeftInLog === 0
      ? new Set(await adoptWrittenSegments(input, manager, segments.partitions, changes))
      : new Set<string>()
  if (!input.holdsCheckpointFiles()) {
    const removable = await garbageThatNoFieldStillReads(store, vectorIndexes, written.garbage)
    await removeCheckpointGarbage(
      store,
      removable.filter(key => !droppedThisCheckpoint.has(key)),
    )
  }
  const checkpointDocumentCount = documentCount
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
    if (partition.failed !== null) continue
    records += Math.max(0, partition.appliedSeqNo - snapshotCheckpointFor(targets, partitionId))
  }
  return records
}
