import { decode, encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import { ErrorCodes, NarsilError } from '../../errors'
import type { Narsil } from '../../narsil'
import { crc32 } from '../../serialization/crc32'
import type { SchemaDefinition } from '../../types/schema'
import type { ClusterCoordinator } from '../coordinator/types'
import { validateEntryPayload } from '../replication/codec'
import { validateReplicationEntry } from '../replication/replica'
import {
  createSnapshotStreamState,
  finalizeSnapshotStream,
  handleIncomingSnapshotRecord,
  type SnapshotStreamFailure,
} from '../replication/snapshot-stream-assembler'
import type { ReplicationLog, ReplicationLogEntry } from '../replication/types'
import type {
  NodeTransport,
  ReplicationSnapshotHeader,
  SyncEntriesPayload,
  SyncRequestPayload,
  TransportMessage,
} from '../transport/types'
import { ReplicationMessageTypes } from '../transport/types'
import { fetchSnapshotFromAnyTarget, isTransientFailure, withDeadline } from './bootstrap-fetch'
import {
  ABORT_SENTINEL,
  dropExistingIndex,
  dropRestoredIndexQuietly,
  executeEngineRestore,
  loadCoordinatorSchema,
  resolveTransportTargets,
  surfaceAborted,
  surfaceError,
  validateArguments,
  validateRestoredSchema,
} from './bootstrap-restore'

export const DEFAULT_BOOTSTRAP_SYNC_DEADLINE_MS = 600_000

interface BootstrapEntry {
  indexName: string
  partitionId: number
  generation: number
  promise: Promise<boolean>
  aborted: boolean
  abortResolve: () => void
  abortPromise: Promise<typeof ABORT_SENTINEL>
}

export interface BootstrapSyncState {
  inFlight: Map<string, BootstrapEntry>
  completed: Set<string>
  generations: Map<string, number>
}

export function createBootstrapSyncState(): BootstrapSyncState {
  return {
    inFlight: new Map(),
    completed: new Set(),
    generations: new Map(),
  }
}

function entryKey(indexName: string, partitionId: number): string {
  return `${indexName}:${partitionId}`
}

function hasLiveBootstrapSyncDeps(deps: BootstrapSyncDeps): deps is LiveBootstrapSyncDeps {
  return (
    deps.getReplicationLog !== undefined &&
    deps.resetReplicationLog !== undefined &&
    deps.applyReplicationEntry !== undefined &&
    deps.restoreReplicationPartition !== undefined
  )
}

export function clearBootstrapSyncIndex(state: BootstrapSyncState, indexName: string, partitionId: number): void {
  const key = entryKey(indexName, partitionId)
  state.completed.delete(key)
  const inFlight = state.inFlight.get(key)
  if (inFlight === undefined) {
    // Generations are only meaningful while an in-flight worker watches
    // its own generation to detect eviction. With no worker to invalidate,
    // the slot is free; clear any lingering counter so a future bootstrap
    // starts clean.
    state.generations.delete(key)
    return
  }
  // Bump the generation and eagerly evict the in-flight entry. Eviction
  // allows a fresh runBootstrapSync for the same key to start immediately
  // rather than absorbing the aborted entry and returning false. The
  // draining worker observes the generation mismatch at its next check
  // (see executeBootstrapSync / applyRestore) and its .finally is a no-op
  // because state.inFlight no longer maps the key to it.
  const previous = state.generations.get(key) ?? 0
  state.generations.set(key, previous + 1)
  inFlight.aborted = true
  inFlight.abortResolve()
  state.inFlight.delete(key)
}

export function hasCompletedBootstrapSync(state: BootstrapSyncState, indexName: string, partitionId: number): boolean {
  return state.completed.has(entryKey(indexName, partitionId))
}

export interface BootstrapSyncDeps {
  engine: Narsil
  coordinator: ClusterCoordinator
  transport: NodeTransport
  sourceNodeId: string
  resolveNodeTargets: (nodeId: string) => Promise<string[]>
  onError?: (error: unknown) => void
  onSnapshotApplied?: (indexName: string, partitionId: number, header: ReplicationSnapshotHeader) => void
  getReplicationLog?: (indexName: string, partitionId: number) => ReplicationLog
  resetReplicationLog?: (indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm?: number) => void
  applyReplicationEntry?: (entry: ReplicationLogEntry) => Promise<void>
  restoreReplicationPartition?: (
    indexName: string,
    partitionId: number,
    bytes: Uint8Array,
    schema: SchemaDefinition,
    partitionCount: number,
  ) => Promise<void>
  deadlineMs?: number
}

interface LiveBootstrapSyncDeps extends BootstrapSyncDeps {
  getReplicationLog: (indexName: string, partitionId: number) => ReplicationLog
  resetReplicationLog: (indexName: string, partitionId: number, startSeqNo: number, lastPrimaryTerm?: number) => void
  applyReplicationEntry: (entry: ReplicationLogEntry) => Promise<void>
  restoreReplicationPartition: (
    indexName: string,
    partitionId: number,
    bytes: Uint8Array,
    schema: SchemaDefinition,
    partitionCount: number,
  ) => Promise<void>
}

export async function runBootstrapSync(
  state: BootstrapSyncState,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  deps: BootstrapSyncDeps,
): Promise<boolean> {
  const validationError = validateArguments(indexName, partitionId, primaryNodeId)
  if (validationError !== null) {
    surfaceError(deps, indexName, primaryNodeId, validationError)
    return false
  }

  const key = entryKey(indexName, partitionId)

  if (state.completed.has(key)) {
    return true
  }

  const existing = state.inFlight.get(key)
  if (existing !== undefined) {
    const result = await Promise.race([existing.promise, existing.abortPromise])
    if (result === ABORT_SENTINEL) {
      return false
    }
    return result
  }

  const entry = createEntry(state, indexName, partitionId, key)
  entry.promise = executeBootstrapSync(state, entry, indexName, partitionId, primaryNodeId, deps).finally(() => {
    const current = state.inFlight.get(key)
    if (current === entry) {
      state.inFlight.delete(key)
    }
    if (!state.completed.has(key) && !state.inFlight.has(key)) {
      const currentGen = state.generations.get(key)
      if (currentGen !== undefined && currentGen !== entry.generation) {
        state.generations.delete(key)
      }
    }
    // Do not resolve the abort promise on successful completion; waiters
    // that race `existing.promise` against it would otherwise see the abort
    // win for a happy-path exit. The entry becomes unreachable once inFlight
    // drops it, so the pending abort promise will be garbage-collected.
  })
  state.inFlight.set(key, entry)
  return entry.promise
}

function createEntry(state: BootstrapSyncState, indexName: string, partitionId: number, key: string): BootstrapEntry {
  const startGeneration = state.generations.get(key) ?? 0
  let abortResolve: () => void = () => {}
  const abortPromise = new Promise<typeof ABORT_SENTINEL>(resolve => {
    abortResolve = () => resolve(ABORT_SENTINEL)
  })
  return {
    indexName,
    partitionId,
    generation: startGeneration,
    promise: Promise.resolve(false),
    aborted: false,
    abortResolve,
    abortPromise,
  }
}

async function executeBootstrapSync(
  state: BootstrapSyncState,
  entry: BootstrapEntry,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  deps: BootstrapSyncDeps,
): Promise<boolean> {
  const deadlineMs = deps.deadlineMs ?? DEFAULT_BOOTSTRAP_SYNC_DEADLINE_MS
  const deadline = Date.now() + deadlineMs
  const key = entryKey(indexName, partitionId)

  const abortCheck = (): boolean => {
    const currentGeneration = state.generations.get(key) ?? 0
    if (currentGeneration !== entry.generation) {
      entry.aborted = true
    }
    return entry.aborted
  }

  if (hasLiveBootstrapSyncDeps(deps)) {
    return executeLiveBootstrapSync(
      state,
      entry,
      indexName,
      partitionId,
      primaryNodeId,
      deps,
      deadlineMs,
      deadline,
      abortCheck,
    )
  }

  const schemaResult = await fetchSchemaAndPrepare(entry, indexName, primaryNodeId, deps)
  if (schemaResult === 'aborted') {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }
  if (schemaResult === null) {
    return false
  }
  if (abortCheck()) {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  if (Date.now() >= deadline) {
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(ErrorCodes.SNAPSHOT_SYNC_TIMEOUT, 'bootstrap sync exceeded deadline before fetching snapshot', {
        indexName,
        deadlineMs,
      }),
    )
    return false
  }

  const targetsResult = await resolveTransportTargets(indexName, primaryNodeId, deps.resolveNodeTargets)
  if (targetsResult instanceof NarsilError) {
    surfaceError(deps, indexName, primaryNodeId, targetsResult)
    return false
  }

  const fetchDeps = { transport: deps.transport, sourceNodeId: deps.sourceNodeId }
  const fetchResult = await fetchSnapshotFromAnyTarget(
    indexName,
    primaryNodeId,
    targetsResult,
    deadline,
    fetchDeps,
    abortCheck,
    partitionId,
  )
  if (!fetchResult.ok) {
    if (fetchResult.code === ErrorCodes.SNAPSHOT_SYNC_ABORTED) {
      surfaceAborted(deps, indexName, primaryNodeId)
      return false
    }
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(fetchResult.code, fetchResult.message, {
        indexName,
        primaryNodeId,
        ...fetchResult.details,
      }),
    )
    return false
  }

  if (abortCheck()) {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  const restoreSucceeded = await applyRestore(
    state,
    entry,
    indexName,
    primaryNodeId,
    fetchResult.bytes,
    schemaResult,
    deadline,
    deps,
  )
  if (!restoreSucceeded) {
    return false
  }

  // Defense-in-depth: an eviction may have slipped in between applyRestore's
  // final generation check and this point (there are no awaits in between
  // today, but a future edit could add one). Re-check before mutating the
  // shared completed set so a drained worker never revives a stale slot.
  if (abortCheck()) {
    if (!anotherBootstrapOwnsKey(state, key, entry)) {
      await dropRestoredIndexQuietly(deps.engine, indexName, deps)
    }
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }
  deps.onSnapshotApplied?.(indexName, partitionId, fetchResult.header)
  state.completed.add(key)
  return true
}

type AbortCheck = () => boolean

interface LiveSyncSuccess {
  ok: true
  tier: 'incremental' | 'snapshot'
  entriesApplied: number
  newSeqNo: number
  snapshotHeader: ReplicationSnapshotHeader | null
}

type LiveSyncResult = LiveSyncSuccess | { ok: false; error: NarsilError }

async function resolveLivePartitionCount(
  coordinator: ClusterCoordinator,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  abortPromise: Promise<typeof ABORT_SENTINEL>,
): Promise<{ partitionCount: number } | { error: NarsilError } | 'aborted'> {
  try {
    const winner = await Promise.race([coordinator.getAllocation(indexName), abortPromise])
    if (winner === ABORT_SENTINEL) {
      return 'aborted'
    }

    const allocation = winner
    if (allocation === null) {
      return {
        error: new NarsilError(
          ErrorCodes.SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
          `coordinator has no allocation for index '${indexName}'`,
          { indexName, primaryNodeId },
        ),
      }
    }

    const assignment = allocation.assignments.get(partitionId)
    if (assignment === undefined) {
      return {
        error: new NarsilError(
          ErrorCodes.SNAPSHOT_SYNC_NOT_ASSIGNED,
          `No assignment exists for partition ${partitionId} of index '${indexName}'`,
          { indexName, partitionId, primaryNodeId },
        ),
      }
    }

    if (assignment.primary !== primaryNodeId) {
      return {
        error: new NarsilError(
          ErrorCodes.SNAPSHOT_SYNC_NOT_ASSIGNED,
          `Partition ${partitionId} of index '${indexName}' is no longer primary on '${primaryNodeId}'`,
          { indexName, partitionId, primaryNodeId, currentPrimary: assignment.primary },
        ),
      }
    }

    return { partitionCount: allocation.assignments.size }
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err)
    return {
      error: new NarsilError(
        ErrorCodes.SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
        `coordinator.getAllocation failed: ${cause}`,
        {
          indexName,
          partitionId,
          primaryNodeId,
          cause,
        },
      ),
    }
  }
}

async function executeLiveBootstrapSync(
  state: BootstrapSyncState,
  entry: BootstrapEntry,
  indexName: string,
  partitionId: number,
  primaryNodeId: string,
  deps: LiveBootstrapSyncDeps,
  deadlineMs: number,
  deadline: number,
  abortCheck: AbortCheck,
): Promise<boolean> {
  const schemaResult = await loadCoordinatorSchema(deps.coordinator, indexName, primaryNodeId, entry.abortPromise)
  if (schemaResult === 'aborted') {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }
  if ('error' in schemaResult) {
    surfaceError(deps, indexName, primaryNodeId, schemaResult.error)
    return false
  }
  if (abortCheck()) {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  const allocationResult = await resolveLivePartitionCount(
    deps.coordinator,
    indexName,
    partitionId,
    primaryNodeId,
    entry.abortPromise,
  )
  if (allocationResult === 'aborted') {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }
  if ('error' in allocationResult) {
    surfaceError(deps, indexName, primaryNodeId, allocationResult.error)
    return false
  }

  if (Date.now() >= deadline) {
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(ErrorCodes.SNAPSHOT_SYNC_TIMEOUT, 'bootstrap sync exceeded deadline before starting live sync', {
        indexName,
        deadlineMs,
      }),
    )
    return false
  }

  const targetsResult = await resolveTransportTargets(indexName, primaryNodeId, deps.resolveNodeTargets)
  if (targetsResult instanceof NarsilError) {
    surfaceError(deps, indexName, primaryNodeId, targetsResult)
    return false
  }

  const syncResult = await syncFromAnyTarget(
    state,
    entry,
    indexName,
    partitionId,
    primaryNodeId,
    targetsResult,
    schemaResult.schema,
    allocationResult.partitionCount,
    deadline,
    deps,
    abortCheck,
  )

  if (!syncResult.ok) {
    if (syncResult.error.code === ErrorCodes.SNAPSHOT_SYNC_ABORTED) {
      surfaceAborted(deps, indexName, primaryNodeId)
      return false
    }
    if (syncResult.error.details.alreadySurfaced !== true) {
      surfaceError(deps, indexName, primaryNodeId, syncResult.error)
    }
    return false
  }

  if (abortCheck()) {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  if (syncResult.snapshotHeader !== null) {
    deps.onSnapshotApplied?.(indexName, partitionId, syncResult.snapshotHeader)
  }
  state.completed.add(entryKey(indexName, partitionId))
  return true
}

async function syncFromAnyTarget(
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

async function syncFromTarget(
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

interface LocalLogState {
  lastSeqNo: number
  lastPrimaryTerm: number
}

function readLocalLogState(indexName: string, partitionId: number, deps: LiveBootstrapSyncDeps): LocalLogState {
  const log = deps.getReplicationLog(indexName, partitionId)
  const lastSeqNo = log.committedSeqNo
  const lastPrimaryTerm = log.committedPrimaryTerm
  const newestEntry = log.getEntry(lastSeqNo)
  return { lastSeqNo, lastPrimaryTerm: newestEntry?.primaryTerm ?? lastPrimaryTerm }
}

interface LiveSyncFrameState {
  snapshotState: ReturnType<typeof createSnapshotStreamState>
  syncEntries: SyncEntriesPayload[]
  sawSnapshotFrame: boolean
  error: NarsilError | null
}

function createLiveSyncFrameState(indexName: string, partitionId: number): LiveSyncFrameState {
  return {
    snapshotState: createSnapshotStreamState({ indexName, partitionId }),
    syncEntries: [],
    sawSnapshotFrame: false,
    error: null,
  }
}

function handleLiveSyncFrame(state: LiveSyncFrameState, frame: Uint8Array): void {
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

function decodeSyncEntriesRecord(record: Record<string, unknown>): SyncEntriesPayload | NarsilError | null {
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

async function applyLiveIncrementalSync(
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

async function applyLiveSnapshotSync(
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

async function restoreLiveSnapshotPartition(
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

async function ensureLocalIndexForIncremental(
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

interface ApplyEntriesSuccess {
  ok: true
  entriesApplied: number
  newSeqNo: number
}

type ApplyEntriesResult = ApplyEntriesSuccess | { ok: false; error: NarsilError }

async function applySyncEntries(
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

function validateSyncEntryBatchTermination(entriesPayloads: SyncEntriesPayload[]): NarsilError | null {
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

function validateSyncEntryForApply(
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
      ErrorCodes.REPLICATION_ENTRY_INVALID,
      `Invalid sync entry ${entry.seqNo}: ${validation.error ?? 'unknown validation error'}`,
      { indexName, partitionId, seqNo: entry.seqNo },
    )
  }
  return null
}

function streamFailureToError(failure: SnapshotStreamFailure): NarsilError {
  return new NarsilError(failure.code, failure.message, failure.details)
}

function anotherBootstrapOwnsKey(state: BootstrapSyncState, key: string, self: BootstrapEntry): boolean {
  const current = state.inFlight.get(key)
  if (current === undefined) {
    return false
  }
  return current !== self
}

async function fetchSchemaAndPrepare(
  entry: BootstrapEntry,
  indexName: string,
  primaryNodeId: string,
  deps: BootstrapSyncDeps,
): Promise<SchemaDefinition | null | 'aborted'> {
  const dropError = await dropExistingIndex(deps.engine, indexName, primaryNodeId)
  if (dropError !== null) {
    surfaceError(deps, indexName, primaryNodeId, dropError)
    return null
  }

  if (entry.aborted) {
    return 'aborted'
  }

  const schemaResult = await loadCoordinatorSchema(deps.coordinator, indexName, primaryNodeId, entry.abortPromise)
  if (schemaResult === 'aborted') {
    return 'aborted'
  }
  if ('error' in schemaResult) {
    surfaceError(deps, indexName, primaryNodeId, schemaResult.error)
    return null
  }
  return schemaResult.schema
}

async function applyRestore(
  state: BootstrapSyncState,
  entry: BootstrapEntry,
  indexName: string,
  primaryNodeId: string,
  bytes: Uint8Array,
  coordinatorSchema: SchemaDefinition,
  deadline: number,
  deps: BootstrapSyncDeps,
): Promise<boolean> {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    surfaceError(
      deps,
      indexName,
      primaryNodeId,
      new NarsilError(ErrorCodes.SNAPSHOT_SYNC_TIMEOUT, 'bootstrap sync exceeded deadline before restore', {
        indexName,
      }),
    )
    return false
  }

  const key = entryKey(indexName, entry.partitionId)
  const generationBeforeRestore = state.generations.get(key) ?? 0
  if (generationBeforeRestore !== entry.generation || entry.aborted) {
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  const restoreError = await executeEngineRestore(deps.engine, indexName, primaryNodeId, bytes, remainingMs)
  if (restoreError !== null) {
    surfaceError(deps, indexName, primaryNodeId, restoreError)
    return false
  }

  const generationAfterRestore = state.generations.get(key) ?? 0
  if (generationAfterRestore !== entry.generation || entry.aborted) {
    // Our bootstrap was aborted, but another bootstrap may already be racing
    // us for the same index (M-new-2 allows a fresh runBootstrapSync to
    // start immediately after eviction). Dropping the index here would
    // destroy that bootstrap's restored data. Defer to the takeover.
    if (!anotherBootstrapOwnsKey(state, key, entry)) {
      await dropRestoredIndexQuietly(deps.engine, indexName, deps)
    }
    surfaceAborted(deps, indexName, primaryNodeId)
    return false
  }

  const schemaError = validateRestoredSchema(deps.engine, indexName, primaryNodeId, coordinatorSchema)
  if (schemaError !== null) {
    await dropRestoredIndexQuietly(deps.engine, indexName, deps)
    surfaceError(deps, indexName, primaryNodeId, schemaError)
    return false
  }

  return true
}
