import type { RemovedSpellings } from '../core/partition/frozen/surface-slot'
import type { PreparedTextChange } from '../core/partition/prepared-text'
import { ErrorCodes, NarsilError } from '../errors'
import type { AnyDocument } from '../types/schema'
import { RebalanceCheckpointHeld } from './checkpoint-hold'
import { DEFAULT_WRITE_AHEAD_QUEUE_MAX_SIZE } from './constants'

export interface BufferedMutation {
  action: 'insert' | 'remove' | 'update'
  docId: string
  document?: AnyDocument
  indexName: string
}

export interface PreparedQueuedMutation extends BufferedMutation {
  readonly partitionDoc?: AnyDocument
  readonly previousDocument?: AnyDocument
  readonly previousPartitionDoc?: AnyDocument
  readonly text: PreparedTextChange
  readonly vectors: Map<string, Float32Array | null>
  readonly removedSpellings: RemovedSpellings
  readonly afterSpellings: RemovedSpellings
}

export interface WAQEntry extends PreparedQueuedMutation {
  readonly sequenceNumber: number
  readonly ready: Promise<boolean>
  durability?: { partitionId: number; partitionCount: number; seqNo: number }
}

export interface QueuedWrite {
  commit(partitionId: number, partitionCount: number, seqNo: number): void
  fail(error: unknown): void
}

export type BufferedDocState = 'present' | 'absent'

export interface WriteAheadQueue {
  assertWritable(): void
  push(entry: PreparedQueuedMutation, awaitsDurability: boolean): QueuedWrite
  first(): WAQEntry | undefined
  complete(entry: WAQEntry): void
  awaitReady(entry: WAQEntry): Promise<boolean>
  requireReplayable(): void
  requireSuccess(): void
  settleAdmissions(): Promise<void>
  checkpointCutoffs(partitionCount: number): Map<number, number>
  readonly provisional: number
  latest(docId: string): WAQEntry | undefined
  bufferedDocState(docId: string): BufferedDocState | undefined
  whenReplayed(): Promise<void>
  markReplayed(): void
  fail(error: unknown): void
  readonly failed: boolean
  readonly size: number
  readonly isFull: boolean
}

export function createWriteAheadQueue(maxSize = DEFAULT_WRITE_AHEAD_QUEUE_MAX_SIZE): WriteAheadQueue {
  const entries = new Map<number, WAQEntry>()
  const byDocument = new Map<string, WAQEntry>()
  let nextSequence = 1
  let failed = false
  let failure: unknown
  let replayFailed = false
  let provisional = 0
  let rejectReplay: (error: unknown) => void = () => undefined
  const replayFailure = new Promise<never>((_resolve, reject) => {
    rejectReplay = reject
  })
  void replayFailure.catch(() => undefined)
  let resolveReplayed: () => void = () => undefined
  let rejectReplayed: (error: unknown) => void = () => undefined
  const replayed = new Promise<void>((resolve, reject) => {
    resolveReplayed = resolve
    rejectReplayed = reject
  })
  void replayed.catch(() => undefined)

  function assertWritable(): void {
    if (failed) throw failure
    if (entries.size >= maxSize) {
      throw new NarsilError(
        ErrorCodes.PARTITION_REBALANCING_BACKPRESSURE,
        `Write-ahead queue is full (${maxSize} entries). Retry after rebalancing completes.`,
        { maxSize, currentSize: entries.size },
      )
    }
  }

  function refuseWrites(error: unknown): void {
    if (failed) return
    failed = true
    failure = error
    rejectReplayed(error)
  }

  function requireReplayable(): void {
    if (replayFailed) throw failure
  }

  function discard(entry: WAQEntry): void {
    entries.delete(entry.sequenceNumber)
    if (byDocument.get(entry.docId) !== entry) return
    byDocument.delete(entry.docId)
    for (const remaining of entries.values()) {
      if (remaining.docId === entry.docId) byDocument.set(entry.docId, remaining)
    }
  }

  return {
    assertWritable,
    push(entry, awaitsDurability): QueuedWrite {
      assertWritable()
      const sequenceNumber = nextSequence++
      let settle: (accepted: boolean) => void = () => undefined
      let settled = !awaitsDurability
      if (awaitsDurability) provisional++
      const ready = awaitsDurability
        ? new Promise<boolean>(resolve => {
            settle = resolve
          })
        : Promise.resolve(true)
      const prepared: WAQEntry = { ...entry, sequenceNumber, ready }
      entries.set(sequenceNumber, prepared)
      byDocument.set(entry.docId, prepared)
      return {
        commit(partitionId, partitionCount, seqNo) {
          if (settled) return
          settled = true
          provisional--
          prepared.durability = { partitionId, partitionCount, seqNo }
          settle(true)
        },
        fail(error) {
          if (settled) return
          settled = true
          provisional--
          discard(prepared)
          refuseWrites(error)
          settle(false)
        },
      }
    },
    first: () => entries.values().next().value,
    complete(entry): void {
      requireReplayable()
      if (entries.values().next().value !== entry) {
        throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'Queued writes must complete in sequence order')
      }
      entries.delete(entry.sequenceNumber)
      if (byDocument.get(entry.docId) === entry) byDocument.delete(entry.docId)
    },
    latest: docId => byDocument.get(docId),
    awaitReady: entry => Promise.race([entry.ready, replayFailure]),
    requireReplayable,
    requireSuccess() {
      if (failed) throw failure
    },
    async settleAdmissions() {
      if (failed) throw failure
      await Promise.race([Promise.all([...entries.values()].map(entry => entry.ready)), replayed])
      if (failed) throw failure
    },
    checkpointCutoffs(partitionCount) {
      if (failed) throw failure
      const cutoffs = new Map<number, number>()
      for (const entry of entries.values()) {
        const position = entry.durability
        if (position === undefined) continue
        if (position.partitionCount !== partitionCount) {
          throw new RebalanceCheckpointHeld()
        }
        const previous = cutoffs.get(position.partitionId)
        cutoffs.set(position.partitionId, Math.min(previous ?? position.seqNo - 1, position.seqNo - 1))
      }
      return cutoffs
    },
    get provisional() {
      return provisional
    },
    bufferedDocState(docId: string): BufferedDocState | undefined {
      const entry = byDocument.get(docId)
      return entry === undefined ? undefined : entry.action === 'remove' ? 'absent' : 'present'
    },

    whenReplayed(): Promise<void> {
      return replayed
    },

    markReplayed(): void {
      if (failed) throw failure
      if (entries.size > 0) {
        throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'Queued writes remain unapplied')
      }
      resolveReplayed()
    },
    fail(error) {
      refuseWrites(error)
      replayFailed = true
      rejectReplay(error)
    },
    get failed() {
      return failed
    },
    get size() {
      return entries.size
    },

    get isFull() {
      return entries.size >= maxSize
    },
  }
}
