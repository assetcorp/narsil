import { ErrorCodes, NarsilError } from '../../../errors'
import { validateReplicationEntry } from '../../replication/replica'
import type { ReplicationLog, ReplicationLogEntry } from '../../replication/types'
import type { SyncEntriesPayload } from '../../transport/types'
import { enqueuePartitionWrite } from '../write-routing/partition-queue'
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
    const run: ReplicationLogEntry[] = []
    let entryError: NarsilError | null = null
    for (const entry of payload.entries) {
      entryError = validateSyncEntryForApply(entry, indexName, partitionId, expectedSeqNo, localPrimaryTerm, log)
      if (entryError !== null) break
      run.push(entry)
      expectedSeqNo = entry.seqNo + 1
    }
    const outcome = await enqueuePartitionWrite(deps.partitionWriteQueues, indexName, partitionId, () =>
      applySyncRunOnce(run, log, deps),
    )
    entriesApplied += outcome.processed
    const error = outcome.error ?? entryError
    if (error !== null) {
      return { ok: false, error }
    }
  }

  return {
    ok: true,
    entriesApplied,
    newSeqNo: expectedSeqNo - 1,
  }
}

interface SyncRunOutcome {
  processed: number
  error: NarsilError | null
}

async function applySyncRunOnce(
  run: readonly ReplicationLogEntry[],
  log: ReplicationLog,
  deps: LiveBootstrapSyncDeps,
): Promise<SyncRunOutcome> {
  let processed = 0
  let error: NarsilError | null = null
  const pending: ReplicationLogEntry[] = []
  let tailSeqNo = log.localLogEnd
  for (const entry of run) {
    const where = { indexName: entry.indexName, partitionId: entry.partitionId, seqNo: entry.seqNo }
    const present = log.getEntry(entry.seqNo)
    if (present !== undefined) {
      if (present.checksum !== entry.checksum) {
        error = new NarsilError(
          ErrorCodes.REPLICATION_ENTRY_INVALID,
          `Conflicting sync entry at sequence number ${entry.seqNo}`,
          where,
        )
        break
      }
      processed += 1
      continue
    }
    if (entry.seqNo !== tailSeqNo + 1) {
      error = new NarsilError(
        ErrorCodes.REPLICATION_ENTRY_INVALID,
        `Out-of-order sync entry ${entry.seqNo}; the local log ends at ${tailSeqNo}`,
        where,
      )
      break
    }
    pending.push(entry)
    tailSeqNo = entry.seqNo
  }
  if (pending.length === 0) return { processed, error }

  let applied: number
  let applyError: unknown = null
  try {
    const outcome = await deps.applyReplicationEntries(pending)
    applied = outcome.applied
    applyError = outcome.error
  } catch (err) {
    applied = 0
    applyError = err
  }
  for (let position = 0; position < applied; position++) log.appendCommitted(pending[position])
  processed += applied
  if (applied < pending.length) {
    const failed = pending[applied]
    const cause = applyError instanceof Error ? applyError.message : String(applyError)
    return {
      processed,
      error: new NarsilError(ErrorCodes.REPLICATION_ENTRY_INVALID, `failed to apply sync entry: ${cause}`, {
        indexName: failed.indexName,
        partitionId: failed.partitionId,
        seqNo: failed.seqNo,
        cause,
      }),
    }
  }
  return { processed, error }
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
