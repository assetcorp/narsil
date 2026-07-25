import { ErrorCodes, NarsilError } from '../../../errors'
import type { Narsil } from '../../../narsil'
import { crc32 } from '../../../serialization/crc32'
import type { SchemaDefinition } from '../../../types/schema'
import { finalizeSnapshotStream } from '../../replication/snapshot-stream-assembler'
import type { SyncEntriesPayload } from '../../transport/types'
import { withDeadline } from '../bootstrap-fetch'
import { validateRestoredSchema } from '../bootstrap-restore'
import { applySyncEntries } from './entries'
import { streamFailureToError } from './frames'
import { entryKey } from './state'
import type {
  BootstrapEntry,
  BootstrapSyncState,
  LiveBootstrapSyncDeps,
  LiveSyncFrameState,
  LiveSyncResult,
} from './types'

export async function applyLiveIncrementalSync(
  indexName: string,
  partitionId: number,
  target: string,
  entriesPayloads: SyncEntriesPayload[],
  expectedFirstSeqNo: number,
  localPrimaryTerm: number,
  coordinatorSchema: SchemaDefinition,
  partitionCount: number,
  deps: LiveBootstrapSyncDeps,
): Promise<LiveSyncResult> {
  const ensureResult = await ensureLocalIndexForIncremental(indexName, target, coordinatorSchema, partitionCount, deps)
  if (ensureResult instanceof NarsilError) {
    return { ok: false, error: ensureResult }
  }

  const applyResult = await applySyncEntries(
    indexName,
    partitionId,
    entriesPayloads,
    expectedFirstSeqNo,
    localPrimaryTerm,
    deps,
  )
  if (!applyResult.ok) {
    return applyResult
  }

  return {
    ok: true,
    tier: 'incremental',
    entriesApplied: applyResult.entriesApplied,
    newSeqNo: applyResult.newSeqNo,
    snapshotHeader: null,
  }
}

export async function applyLiveSnapshotSync(
  state: BootstrapSyncState,
  entry: BootstrapEntry,
  indexName: string,
  partitionId: number,
  target: string,
  frameState: LiveSyncFrameState,
  coordinatorSchema: SchemaDefinition,
  partitionCount: number,
  deadline: number,
  deps: LiveBootstrapSyncDeps,
): Promise<LiveSyncResult> {
  const finalized = finalizeSnapshotStream(frameState.snapshotState)
  if (!finalized.ok) {
    return { ok: false, error: streamFailureToError(finalized) }
  }

  const computedChecksum = crc32(finalized.bytes)
  if (computedChecksum !== finalized.header.checksum) {
    return {
      ok: false,
      error: new NarsilError(
        ErrorCodes.SNAPSHOT_SYNC_CHECKSUM_MISMATCH,
        'computed checksum does not match header checksum',
        {
          computed: computedChecksum,
          header: finalized.header.checksum,
          target,
        },
      ),
    }
  }

  const restoreError = await restoreLiveSnapshotPartition(
    state,
    entry,
    indexName,
    partitionId,
    target,
    finalized.bytes,
    coordinatorSchema,
    partitionCount,
    deadline,
    deps,
  )
  if (restoreError !== null) {
    return { ok: false, error: restoreError }
  }

  deps.resetReplicationLog(indexName, partitionId, finalized.header.lastSeqNo + 1, finalized.header.primaryTerm)
  const applyResult = await applySyncEntries(
    indexName,
    partitionId,
    frameState.syncEntries,
    finalized.header.lastSeqNo + 1,
    finalized.header.primaryTerm,
    deps,
  )
  if (!applyResult.ok) {
    return applyResult
  }

  return {
    ok: true,
    tier: 'snapshot',
    entriesApplied: applyResult.entriesApplied,
    newSeqNo: applyResult.newSeqNo,
    snapshotHeader: finalized.header,
  }
}

export async function restoreLiveSnapshotPartition(
  state: BootstrapSyncState,
  entry: BootstrapEntry,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  bytes: Uint8Array,
  coordinatorSchema: SchemaDefinition,
  partitionCount: number,
  deadline: number,
  deps: LiveBootstrapSyncDeps,
): Promise<NarsilError | null> {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    return new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_TIMEOUT,
      'bootstrap sync exceeded deadline before partition restore',
      {
        indexName,
        partitionId,
        primaryNodeId,
      },
    )
  }

  const key = entryKey(indexName, partitionId)
  const generationBeforeRestore = state.generations.get(key) ?? 0
  if (generationBeforeRestore !== entry.generation || entry.aborted) {
    return new NarsilError(ErrorCodes.SNAPSHOT_SYNC_ABORTED, 'bootstrap sync aborted before partition restore', {
      indexName,
      partitionId,
      primaryNodeId,
    })
  }

  try {
    await withDeadline(
      deps.restoreReplicationPartition(indexName, partitionId, bytes, coordinatorSchema, partitionCount),
      remainingMs,
      indexName,
      'partition-restore',
    )
  } catch (err) {
    if (err instanceof NarsilError && err.code === ErrorCodes.SNAPSHOT_SYNC_TIMEOUT) {
      return err
    }
    const cause = err instanceof Error ? err.message : String(err)
    return new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, `partition restore failed: ${cause}`, {
      indexName,
      partitionId,
      primaryNodeId,
      cause,
    })
  }

  const generationAfterRestore = state.generations.get(key) ?? 0
  if (generationAfterRestore !== entry.generation || entry.aborted) {
    return new NarsilError(ErrorCodes.SNAPSHOT_SYNC_ABORTED, 'bootstrap sync aborted after partition restore', {
      indexName,
      partitionId,
      primaryNodeId,
    })
  }

  const schemaError = validateRestoredSchema(deps.engine, indexName, primaryNodeId, coordinatorSchema)
  if (schemaError !== null) {
    return schemaError
  }
  return null
}

export async function ensureLocalIndexForIncremental(
  indexName: string,
  primaryNodeId: string,
  coordinatorSchema: SchemaDefinition,
  partitionCount: number,
  deps: LiveBootstrapSyncDeps,
): Promise<{ created: boolean } | NarsilError> {
  const existing = deps.engine.listIndexes().find(idx => idx.name === indexName)
  if (existing !== undefined) {
    const validation = validateLocalSchema(deps.engine, indexName, primaryNodeId, coordinatorSchema)
    if (validation instanceof NarsilError) {
      return validation
    }
    return validateLocalPartitionCount(deps.engine, indexName, primaryNodeId, partitionCount)
  }

  try {
    await deps.engine.createIndex(indexName, {
      schema: coordinatorSchema,
      partitions: { maxPartitions: partitionCount },
    })
  } catch (err) {
    if (err instanceof NarsilError && err.code === ErrorCodes.INDEX_ALREADY_EXISTS) {
      const validation = validateLocalSchema(deps.engine, indexName, primaryNodeId, coordinatorSchema)
      if (validation instanceof NarsilError) {
        return validation
      }
      return validateLocalPartitionCount(deps.engine, indexName, primaryNodeId, partitionCount)
    }
    const cause = err instanceof Error ? err.message : String(err)
    return new NarsilError(ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED, `engine.createIndex failed: ${cause}`, {
      indexName,
      primaryNodeId,
      cause,
    })
  }

  return { created: true }
}

function validateLocalSchema(
  engine: Narsil,
  indexName: string,
  primaryNodeId: string,
  coordinatorSchema: SchemaDefinition,
): { created: false } | NarsilError {
  const schemaError = validateRestoredSchema(engine, indexName, primaryNodeId, coordinatorSchema)
  if (schemaError !== null) {
    return schemaError
  }
  return { created: false }
}

function validateLocalPartitionCount(
  engine: Narsil,
  indexName: string,
  primaryNodeId: string,
  partitionCount: number,
): { created: false } | NarsilError {
  let localPartitionCount: number
  try {
    localPartitionCount = engine.getStats(indexName).partitionCount
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    return new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED,
      `failed to read local partition count for '${indexName}': ${cause}`,
      { indexName, primaryNodeId, cause },
    )
  }
  if (localPartitionCount !== partitionCount) {
    return new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_RESTORE_FAILED,
      `local partition count ${localPartitionCount} disagrees with coordinator partition count ${partitionCount}`,
      { indexName, primaryNodeId, localPartitionCount, partitionCount },
    )
  }
  return { created: false }
}
