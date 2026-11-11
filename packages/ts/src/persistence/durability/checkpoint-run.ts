import { createRequestId, ErrorCodes, NarsilError } from '#platform/storage-host'
import type { PartitionManager } from '../../partitioning/manager'
import type { PartitionWriteLog } from '../../partitioning/manager/write-log'
import { writeMetadataEnvelope } from '../../serialization/envelope'
import type { IndexMetadata } from '../../types/internal'
import {
  actionPartitionsOf,
  closeUnusedSegments,
  keysThatSegmentsStillRead,
  prepareDiskAdoption,
  swapPreparedPartitions,
} from '../paged/adopt'
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
import { priorForLayout } from './checkpoint-prior'
import { checkpointWorkerIsUsable } from './checkpoint-worker-dispatch'
import { writeIndexCheckpointSegments } from './checkpoint-write'
import type { DurableDirectory } from './durable-filesystem'
import { transitionKey } from './layout-transition/codec'
import type { IndexState } from './manager-state'
import type { PartitionFailure } from './mutation-batch'
import type { PartitionCheckpoint } from './partition-checkpoint'
import { snapshotCheckpointFor } from './recovery'
import { readCurrentManifest } from './segment/load'
import { manifestWithinPartitionCount, type PartitionManifestEntry, type SegmentManifest } from './segment/manifest'
import { type CheckpointStore, directoryCheckpointStore } from './segment/store'
import { adoptVectorLayouts, garbageThatNoFieldStillReads, recordWrittenVectors } from './segment/vector-adoption'
import { checkpointGarbage, commitCheckpointManifest, removeCheckpointGarbage } from './segment/write'
import type { StoredBytes } from './stored-bytes'
import type { IndexDurabilityHooks } from './types'
import { noteCheckpointCommitted } from './write-stall'

interface DurableCheckpointInput {
  directory: DurableDirectory
  hooks: IndexDurabilityHooks
  indexName: string
  indexState: IndexState
  compactionThreshold: number
  rewriteBytesPerCheckpoint: number
  canOffload: boolean
  fromMemory: boolean
  mutationThreshold: number
  mayContinue(): boolean
  holdsCheckpointFiles(): boolean
  keepsCheckpointKey(): Promise<(key: string) => boolean>
  recordSavedBytes(saved: StoredBytes): void
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
  const storedManifest = await readCurrentManifest(store, input.indexName)
  const priorManifest =
    storedManifest === null ? null : manifestWithinPartitionCount(storedManifest, manager.partitionCount)
  const textOnDisk = metadata.textStorage === 'disk'
  const wholePartitionsOf = wholePartitionsWhereMostChanged(manager, {
    priorCheckpoint: priorManifest?.checkpoint ?? [],
    priorPartitionIds: (priorManifest?.partitions ?? []).map(partition => partition.partitionId),
    everyPartition: fromMemory,
    aWorkerCanSerialise: input.canOffload && !textOnDisk && checkpointWorkerIsUsable(),
    usesLogForUnchangedLayout: textOnDisk,
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
    wholePartitionsOf,
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
    return await finishBoundedCheckpoint(
      input,
      manager,
      store,
      { ...metadata, partitionCount: capture.partitionCount },
      priorManifest,
      capture,
      fromMemory,
      () => {
        return changesSinceCapture
      },
    )
  } finally {
    for (const plan of capture.vectorPlans.values()) plan.release()
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
  const adoption = await prepareDiskAdoption(input.directory, manager, partitions)
  if (adoption === null) return []
  const adopted = await whileNoMutationApplies([...indexState.partitions.values()], () =>
    manager.publication.write(() => {
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
    }),
  )
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
      rewriteBytesPerCheckpoint: input.rewriteBytesPerCheckpoint,
      canOffload: input.canOffload,
      prior: priorForLayout(priorManifest, capture.partitionCount),
      wholePartitions: capture.wholePartitions.contents,
      capturedPartitions: capture.wholePartitions.captured,
      keepsWriteRecords: writeRecords !== null,
      liveDocuments: capture.liveDocuments,
    }),
  )
  await makeEveryAppliedMutationDurable(input.indexState, input.failPartition)
  if (aTargetFailed(input.indexState, targets)) return 0

  const written = await commitCheckpointManifest(store, metadata, segments, liveVectors.vectors)
  input.recordSavedBytes(written.saved)
  input.hooks.onManifestCommitted(input.indexName, metadata.analysisGeneration ?? 0)
  recordWrittenVectors(vectorIndexes, liveVectors.written)
  await adoptVectorLayouts(store, vectorIndexes, liveVectors.layouts)
  const changes = changesSinceCapture()
  const droppedThisCheckpoint =
    changes !== null && capture.recordsLeftInLog === 0
      ? new Set(await adoptWrittenSegments(input, manager, segments.partitions, changes))
      : new Set<string>()
  await writeCheckpointMetadata(input, documentCount, capture.partitionCount, written.saved.bytes)
  if (!input.holdsCheckpointFiles()) {
    const garbage = await checkpointGarbage(store, input.indexName, written.manifest)
    const removable = await garbageThatNoFieldStillReads(store, vectorIndexes, garbage)
    const stillRead = metadata.textStorage === 'disk' ? keysThatSegmentsStillRead(manager) : new Set<string>()
    const keptForSync = await input.keepsCheckpointKey()
    await removeCheckpointGarbage(
      store,
      removable.filter(key => !droppedThisCheckpoint.has(key) && !stillRead.has(key) && !keptForSync(key)),
    )
  }
  const movedIntoHistoryAtMs = input.hooks.keepsSyncHistory?.(input.indexName) === true ? Date.now() : null
  await truncateCoveredSegments(input.directory, input.indexName, targets, movedIntoHistoryAtMs)
  if (movedIntoHistoryAtMs !== null) input.hooks.onHistoryMoved?.(input.indexName)
  await reclaimWalBeyondCount(
    input.directory,
    input.indexName,
    capture.partitionCount,
    input.indexState.partitions,
    input.markFatal,
  )
  await input.directory.remove(transitionKey(input.indexName))
  const beyondTheCheckpoint = recordsBeyond(input.indexState, targets)
  noteCheckpointCommitted(input.indexState, beyondTheCheckpoint)
  const eligibleBeyond = recordsBeyond(input.indexState, targets, capture.unreplayedCutoffs)
  const anotherIsDue = input.mutationThreshold > 0 && eligibleBeyond >= input.mutationThreshold
  return anotherIsDue ? eligibleBeyond : capture.recordsLeftInLog
}

async function writeCheckpointMetadata(
  input: DurableCheckpointInput,
  documentCount: number,
  partitionCount: number,
  savedBytes: number,
): Promise<void> {
  const { indexName, hooks } = input
  await input.queueMetadataWrite(indexName, async () => {
    const checkpointMetadata = hooks.buildMetadata(indexName, documentCount, savedBytes)
    if (checkpointMetadata === undefined) {
      return
    }
    const bytes = await writeMetadataEnvelope({ ...checkpointMetadata, partitionCount }, { checksum: true })
    await input.directory.atomicWrite(`${indexName}/meta`, bytes)
    hooks.recordCheckpoint?.(indexName, documentCount, partitionCount, savedBytes)
  })
}

function recordsBeyond(
  indexState: IndexState,
  targets: PartitionCheckpoint[],
  cutoffs?: ReadonlyMap<number, number>,
): number {
  let records = 0
  for (const [partitionId, partition] of indexState.partitions) {
    if (partition.failed !== null) continue
    records += Math.max(
      0,
      Math.min(partition.appliedSeqNo, cutoffs?.get(partitionId) ?? Infinity) -
        snapshotCheckpointFor(targets, partitionId),
    )
  }
  return records
}
