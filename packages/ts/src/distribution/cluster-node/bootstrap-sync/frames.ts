import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { validateEntryPayload } from '../../replication/codec'
import {
  createSnapshotStreamState,
  handleIncomingSnapshotRecord,
  type SnapshotStreamFailure,
} from '../../replication/snapshot-stream-assembler'
import type { ReplicationLogEntry } from '../../replication/types'
import type { SyncEntriesPayload } from '../../transport/types'
import type { LiveSyncFrameState } from './types'

export function createLiveSyncFrameState(indexName: string, partitionId: number): LiveSyncFrameState {
  return {
    snapshotState: createSnapshotStreamState({ indexName, partitionId }),
    syncEntries: [],
    sawSnapshotFrame: false,
    error: null,
  }
}

export function handleLiveSyncFrame(state: LiveSyncFrameState, frame: Uint8Array): void {
  if (state.error !== null || state.snapshotState.failure !== null) {
    return
  }

  let decoded: unknown
  try {
    decoded = decode(frame)
  } catch (err) {
    state.error = new NarsilError(ErrorCodes.SNAPSHOT_SYNC_DECODE_FAILED, 'failed to decode live sync frame', {
      cause: err instanceof Error ? err.message : String(err),
    })
    return
  }

  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    state.error = new NarsilError(ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID, 'live sync frame is not an object')
    return
  }

  const record = decoded as Record<string, unknown>
  const entriesPayload = decodeSyncEntriesRecord(record)
  if (entriesPayload instanceof NarsilError) {
    state.error = entriesPayload
    return
  }
  if (entriesPayload !== null) {
    if (state.sawSnapshotFrame && state.snapshotState.endPayload === null) {
      state.error = new NarsilError(ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID, 'received sync_entries before snapshot_end')
      return
    }
    state.syncEntries.push(entriesPayload)
    return
  }

  if (state.syncEntries.length > 0 && !state.sawSnapshotFrame) {
    state.error = new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID,
      'received snapshot frame after incremental sync_entries',
    )
    return
  }

  state.sawSnapshotFrame = true
  handleIncomingSnapshotRecord(state.snapshotState, record)
  if (state.snapshotState.failure !== null) {
    state.error = streamFailureToError(state.snapshotState.failure)
  }
}

export function decodeSyncEntriesRecord(record: Record<string, unknown>): SyncEntriesPayload | NarsilError | null {
  if (!('entries' in record) && !('isLast' in record)) {
    return null
  }
  if (!Array.isArray(record.entries) || typeof record.isLast !== 'boolean') {
    return new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID,
      'Invalid SyncEntriesPayload: expected entries array and isLast boolean',
    )
  }

  const entries: ReplicationLogEntry[] = []
  for (const candidate of record.entries) {
    try {
      entries.push(validateEntryPayload({ entry: candidate }).entry)
    } catch (err) {
      return new NarsilError(ErrorCodes.REPLICATION_ENTRY_INVALID, err instanceof Error ? err.message : String(err))
    }
  }

  return { entries, isLast: record.isLast }
}

export function streamFailureToError(failure: SnapshotStreamFailure): NarsilError {
  return new NarsilError(failure.code, failure.message, failure.details)
}
