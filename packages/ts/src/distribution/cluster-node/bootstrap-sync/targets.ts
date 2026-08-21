import { encode } from '@msgpack/msgpack'
import { generateId } from '../../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { SchemaDefinition } from '../../../types/schema'
import type { SyncRequestPayload, TransportMessage } from '../../transport/types'
import { ReplicationMessageTypes } from '../../transport/types'
import { isTransientFailure, withDeadline } from '../bootstrap-fetch'
import { applyLiveIncrementalSync, applyLiveSnapshotSync } from './apply'
import { createLiveSyncFrameState, handleLiveSyncFrame } from './frames'
import type {
  AbortCheck,
  BootstrapEntry,
  BootstrapSyncState,
  LiveBootstrapSyncDeps,
  LiveSyncResult,
  LocalLogState,
} from './types'

export function readLocalLogState(indexName: string, partitionId: number, deps: LiveBootstrapSyncDeps): LocalLogState {
  const log = deps.getReplicationLog(indexName, partitionId)
  const lastSeqNo = log.localLogEnd
  const lastPrimaryTerm = log.localLogEndPrimaryTerm
  const newestEntry = log.getEntry(lastSeqNo)
  return { lastSeqNo, lastPrimaryTerm: newestEntry?.primaryTerm ?? lastPrimaryTerm }
}

const SYNCED_POSITION_REPORT_TIMEOUT_MS = 5_000

async function reportSyncedPosition(
  indexName: string,
  partitionId: number,
  target: string,
  knownSeqNo: number,
  deadline: number,
  deps: LiveBootstrapSyncDeps,
): Promise<void> {
  const logState = readLocalLogState(indexName, partitionId, deps)
  if (logState.lastSeqNo <= knownSeqNo) {
    return
  }

  const budgetMs = Math.min(SYNCED_POSITION_REPORT_TIMEOUT_MS, deadline - Date.now())
  if (budgetMs <= 0) {
    return
  }

  const payload: SyncRequestPayload = {
    indexName,
    partitionId,
    lastSeqNo: logState.lastSeqNo,
    lastPrimaryTerm: logState.lastPrimaryTerm,
  }
  const request: TransportMessage = {
    type: ReplicationMessageTypes.SYNC_REQUEST,
    sourceId: deps.sourceNodeId,
    requestId: generateId(),
    payload: encode(payload),
  }

  try {
    await withDeadline(
      deps.transport.stream(target, request, () => {}),
      budgetMs,
      indexName,
      'synced-position-report',
    )
  } catch (error) {
    if (deps.onError !== undefined) {
      deps.onError(error)
    }
  }
}

export async function syncFromAnyTarget(
  state: BootstrapSyncState,
  entry: BootstrapEntry,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  targets: string[],
  coordinatorSchema: SchemaDefinition,
  partitionCount: number,
  deadline: number,
  deps: LiveBootstrapSyncDeps,
  abortCheck: AbortCheck,
): Promise<LiveSyncResult> {
  let lastError = new NarsilError(ErrorCodes.SNAPSHOT_SYNC_TRANSPORT_FAILED, 'no live sync attempts were made', {
    indexName,
    partitionId,
    primaryNodeId,
  })

  const attempted = new Set<string>()
  for (const target of targets) {
    if (attempted.has(target)) {
      continue
    }
    attempted.add(target)
    if (abortCheck()) {
      return {
        ok: false,
        error: new NarsilError(ErrorCodes.SNAPSHOT_SYNC_ABORTED, 'bootstrap sync aborted before next live target', {
          indexName,
          partitionId,
          primaryNodeId,
          target,
        }),
      }
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: new NarsilError(
          ErrorCodes.SNAPSHOT_SYNC_TIMEOUT,
          'bootstrap sync exceeded deadline while iterating live targets',
          { indexName, partitionId, primaryNodeId, targets },
        ),
      }
    }

    const positionBeforeAttempt = readLocalLogState(indexName, partitionId, deps).lastSeqNo
    const attempt = await syncFromTarget(
      state,
      entry,
      indexName,
      partitionId,
      target,
      coordinatorSchema,
      partitionCount,
      deadline,
      deps,
      abortCheck,
    )
    if (attempt.ok) {
      await reportSyncedPosition(indexName, partitionId, target, positionBeforeAttempt, deadline, deps)
      return attempt
    }

    lastError = new NarsilError(attempt.error.code, attempt.error.message, {
      ...attempt.error.details,
      target,
    })
    if (!isTransientFailure(attempt.error.code, attempt.error.details)) {
      return { ok: false, error: lastError }
    }
  }

  return { ok: false, error: lastError }
}

export async function syncFromTarget(
  state: BootstrapSyncState,
  entry: BootstrapEntry,
  indexName: string,
  partitionId: number,
  target: string,
  coordinatorSchema: SchemaDefinition,
  partitionCount: number,
  deadline: number,
  deps: LiveBootstrapSyncDeps,
  abortCheck: AbortCheck,
): Promise<LiveSyncResult> {
  const logState = readLocalLogState(indexName, partitionId, deps)
  const requestPayload: SyncRequestPayload = {
    indexName,
    partitionId,
    lastSeqNo: logState.lastSeqNo,
    lastPrimaryTerm: logState.lastPrimaryTerm,
  }
  const request: TransportMessage = {
    type: ReplicationMessageTypes.SYNC_REQUEST,
    sourceId: deps.sourceNodeId,
    requestId: generateId(),
    payload: encode(requestPayload),
  }

  const frameState = createLiveSyncFrameState(indexName, partitionId)
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    return {
      ok: false,
      error: new NarsilError(ErrorCodes.SNAPSHOT_SYNC_TIMEOUT, 'deadline expired before live sync stream', {
        indexName,
        partitionId,
        target,
      }),
    }
  }

  try {
    const streamWork = deps.transport.stream(target, request, (chunk: Uint8Array) => {
      handleLiveSyncFrame(frameState, chunk)
    })
    await withDeadline(streamWork, remainingMs, indexName, 'live-sync')
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      error: new NarsilError(ErrorCodes.SNAPSHOT_SYNC_TRANSPORT_FAILED, `live sync transport failed: ${cause}`, {
        indexName,
        partitionId,
        target,
        cause,
      }),
    }
  }

  if (frameState.error !== null) {
    return { ok: false, error: frameState.error }
  }
  if (abortCheck()) {
    return {
      ok: false,
      error: new NarsilError(ErrorCodes.SNAPSHOT_SYNC_ABORTED, 'bootstrap sync aborted after live stream', {
        indexName,
        partitionId,
        target,
      }),
    }
  }

  if (frameState.sawSnapshotFrame) {
    return applyLiveSnapshotSync(
      state,
      entry,
      indexName,
      partitionId,
      target,
      frameState,
      coordinatorSchema,
      partitionCount,
      deadline,
      deps,
    )
  }

  if (frameState.syncEntries.length > 0) {
    return applyLiveIncrementalSync(
      indexName,
      partitionId,
      target,
      frameState.syncEntries,
      logState.lastSeqNo + 1,
      logState.lastPrimaryTerm,
      coordinatorSchema,
      partitionCount,
      deps,
    )
  }

  return {
    ok: false,
    error: new NarsilError(ErrorCodes.SNAPSHOT_SYNC_CHUNK_MISSING, 'live sync stream ended without sync frames', {
      indexName,
      partitionId,
      target,
    }),
  }
}
