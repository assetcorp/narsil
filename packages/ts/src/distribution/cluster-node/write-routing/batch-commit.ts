import { ErrorCodes, NarsilError, type NarsilErrorCode } from '../../../errors'
import type { BatchResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { ReplicationLogEntry } from '../../replication/types'
import type { PrimaryWriteScope } from './numbered-write'
import { chunkReplicationEntries, replicateEntryBatch } from './replication'
import type { WriteRoutingDeps } from './types'

export interface AppendedWrite {
  docId: string
  entry: ReplicationLogEntry
  previousDocument?: AnyDocument
}

export function asWriteError(err: unknown, fallbackCode: NarsilErrorCode, docId: string): NarsilError {
  return err instanceof NarsilError ? err : new NarsilError(fallbackCode, String(err), { docId })
}

export interface GroupCommit {
  afterGroup(): Promise<void>
  refuse(docId: string): boolean
}

export function createGroupCommit(
  scope: PrimaryWriteScope,
  appended: AppendedWrite[],
  failed: BatchResult['failed'],
): GroupCommit {
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
        for (const write of appended.splice(committed)) {
          failed.push({ docId: write.docId, error: asWriteError(err, ErrorCodes.PERSISTENCE_SAVE_FAILED, write.docId) })
        }
      }
    },
    refuse(docId) {
      if (commitError === undefined) return false
      failed.push({ docId, error: asWriteError(commitError, ErrorCodes.PERSISTENCE_SAVE_FAILED, docId) })
      return true
    },
  }
}

export async function replicateAppendedWrites(
  scope: PrimaryWriteScope,
  appended: AppendedWrite[],
  failed: BatchResult['failed'],
  rollback: (write: AppendedWrite, error: unknown) => Promise<never>,
  deps: WriteRoutingDeps,
): Promise<string[]> {
  const succeeded: string[] = []
  const chunks = chunkReplicationEntries(appended)
  const abandoned: AppendedWrite[] = []
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
        succeeded.push(...chunk.map(item => item.docId))
        continue
      } catch (error) {
        abortError = error
      }
    }

    abandoned.push(...chunk)
  }

  for (let index = abandoned.length - 1; index >= 0; index--) {
    const item = abandoned[index]
    try {
      await rollback(item, abortError)
    } catch (err) {
      failed.push({ docId: item.docId, error: asWriteError(err, ErrorCodes.DOC_VALIDATION_FAILED, item.docId) })
    }
  }

  return succeeded
}
