import { ErrorCodes, NarsilError } from '../../../errors'
import { validateReplicationEntry } from '../../replication/replica'
import type { ReplicationLog, ReplicationLogEntry } from '../../replication/types'
import type { SyncEntriesPayload } from '../../transport/types'
import type { ApplyEntriesResult, LiveBootstrapSyncDeps } from './types'

export async function applySyncEntries(
  indexName: string,
  partitionId: number,
  entriesPayloads: SyncEntriesPayload[],
  expectedFirstSeqNo: number,
  localPrimaryTerm: number,
  deps: LiveBootstrapSyncDeps,
): Promise<ApplyEntriesResult> {
  const terminalError = validateSyncEntryBatchTermination(entriesPayloads)
  if (terminalError !== null) {
    return { ok: false, error: terminalError }
  }

  const log = deps.getReplicationLog(indexName, partitionId)
  let expectedSeqNo = expectedFirstSeqNo
  let entriesApplied = 0

  for (const payload of entriesPayloads) {
    for (const entry of payload.entries) {
      const entryError = validateSyncEntryForApply(entry, indexName, partitionId, expectedSeqNo, localPrimaryTerm, log)
      if (entryError !== null) {
        return { ok: false, error: entryError }
      }
      try {
        await deps.applyReplicationEntry(entry)
        log.appendCommitted(entry)
      } catch (err) {
        const cause = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          error: new NarsilError(ErrorCodes.REPLICATION_ENTRY_INVALID, `failed to apply sync entry: ${cause}`, {
            indexName,
            partitionId,
            seqNo: entry.seqNo,
            cause,
          }),
        }
      }
      expectedSeqNo = entry.seqNo + 1
      entriesApplied += 1
    }
  }

  return {
    ok: true,
    entriesApplied,
    newSeqNo: expectedSeqNo - 1,
  }
}

export function validateSyncEntryBatchTermination(entriesPayloads: SyncEntriesPayload[]): NarsilError | null {
  if (entriesPayloads.length === 0) {
    return null
  }
  for (let i = 0; i < entriesPayloads.length - 1; i += 1) {
    if (entriesPayloads[i].isLast) {
      return new NarsilError(ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID, 'sync_entries marked isLast before final batch')
    }
  }
  if (!entriesPayloads[entriesPayloads.length - 1].isLast) {
    return new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID,
      'live sync stream ended before final sync_entries batch',
    )
  }
  return null
}

export function validateSyncEntryForApply(
  entry: ReplicationLogEntry,
  indexName: string,
  partitionId: number,
  expectedSeqNo: number,
  localPrimaryTerm: number,
  log: ReplicationLog,
): NarsilError | null {
  if (entry.indexName !== indexName || entry.partitionId !== partitionId) {
    return new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      'replication entry scope does not match bootstrap target',
      {
        expectedIndexName: indexName,
        expectedPartitionId: partitionId,
        entryIndexName: entry.indexName,
        entryPartitionId: entry.partitionId,
      },
    )
  }
  if (entry.seqNo !== expectedSeqNo) {
    return new NarsilError(
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Out-of-order sync entry ${entry.seqNo}; expected ${expectedSeqNo}`,
      { indexName, partitionId, seqNo: entry.seqNo, expectedSeqNo },
    )
  }
  const validation = validateReplicationEntry(entry, localPrimaryTerm, log)
  if (!validation.valid) {
    return new NarsilError(
      validation.error ?? ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Invalid sync entry ${entry.seqNo}`,
      { indexName, partitionId, seqNo: entry.seqNo },
    )
  }
  return null
}
