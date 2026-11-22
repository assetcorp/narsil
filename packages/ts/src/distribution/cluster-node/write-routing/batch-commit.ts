import { ErrorCodes, NarsilError, type NarsilErrorCode } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { ReplicationLogEntry } from '../../replication/types'
import type { WriteRecord } from '../write-records/table'
import { markAbandoned } from './abandoned-write'
import type { BatchWrite, WriteFailure } from './batch-write'
import { copyFailedIn, type PrimaryWriteScope } from './numbered-write'
import { chunkReplicationEntries, replicateEntryBatch } from './replication'
import { failedCopyOutcome, settleRollback } from './rollback'
import type { WriteRoutingDeps } from './types'

export interface AppendedWrite<V> {
  write: BatchWrite<V>
  entry: ReplicationLogEntry
  previousDocument?: AnyDocument
  previousRecord?: WriteRecord | null
}

export function asWriteError(err: unknown, fallbackCode: NarsilErrorCode, docId: string): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(fallbackCode, String(err), { docId })
}

export interface GroupCommit<V> {
  afterGroup(): Promise<void>
  refuse(write: BatchWrite<V>): boolean
}

export function createGroupCommit<V>(
  scope: PrimaryWriteScope,
  appended: AppendedWrite<V>[],
  failed: WriteFailure<V>[],
): GroupCommit<V> {
  let committed = 0
  let commitError: unknown
  return {
    async afterGroup() {
      const commit = scope.deps.commitPartitionLog
      if (commit === undefined || commitError !== undefined || appended.length === committed) return
      try {
        await commit(scope.indexName, scope.partitionId)
        committed = appended.length
      } catch (err) {
        commitError = err
        const logged = copyFailedIn(scope) ? failedCopyOutcome(scope, err) : null
        for (const { write } of appended.splice(committed)) {
          failed.push({ write, error: logged ?? asWriteError(err, ErrorCodes.PERSISTENCE_SAVE_FAILED, write.docId) })
        }
      }
    },
    refuse(write) {
      if (commitError === undefined) return false
      failed.push({ write, error: asWriteError(commitError, ErrorCodes.PERSISTENCE_SAVE_FAILED, write.docId) })
      return true
    },
  }
}

export async function replicateAppendedWrites<V>(
  scope: PrimaryWriteScope,
  appended: AppendedWrite<V>[],
  failed: WriteFailure<V>[],
  compensate: (write: AppendedWrite<V>, error: unknown) => Promise<ReplicationLogEntry | undefined>,
  deps: WriteRoutingDeps,
): Promise<BatchWrite<V>[]> {
  const succeeded: BatchWrite<V>[] = []
  const chunks = chunkReplicationEntries(appended)
  const abandoned: AppendedWrite<V>[] = []
  let abortError: unknown

  for (const chunk of chunks) {
    if (abortError === undefined) {
      try {
        await replicateEntryBatch(
          chunk.map(item => item.entry),
          scope.assignment,
          deps,
          scope.indexUuid,
        )
        succeeded.push(...chunk.map(item => item.write))
        continue
      } catch (error) {
        abortError = error
      }
    }

    abandoned.push(...chunk)
  }

  const first = abandoned[0]
  if (first === undefined) return succeeded
  const failedAt = Date.now()
  const compensated: Array<{ item: AppendedWrite<V>; compensation: ReplicationLogEntry | null }> = []
  for (let index = abandoned.length - 1; index >= 0; index--) {
    const item = abandoned[index]
    try {
      const compensation = await compensate(item, abortError)
      compensated.push({ item, compensation: compensation ?? null })
    } catch (err) {
      const { write } = item
      failed.push({ write, error: asWriteError(err, ErrorCodes.DOC_VALIDATION_FAILED, write.docId) })
    }
  }
  const answer = copyFailedIn(scope)
    ? failedCopyOutcome(scope, abortError)
    : await settleRollback(scope, first.entry.seqNo, abortError, failedAt)
  for (const { item, compensation } of compensated) {
    const { write } = item
    const marked = markAbandoned(answer, item.entry, compensation, item.previousRecord)
    failed.push({ write, error: asWriteError(marked, ErrorCodes.DOC_VALIDATION_FAILED, write.docId) })
  }

  return succeeded
}
