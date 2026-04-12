import { encode } from '@msgpack/msgpack'
import { generateId } from '../../core/id-generator'
import { type ErrorCode, ErrorCodes, NarsilError } from '../../errors'
import { crc32 } from '../../serialization/crc32'
import {
  createSnapshotStreamState,
  finalizeSnapshotStream,
  handleIncomingSnapshotFrame,
  type SnapshotStreamFailure,
  type SnapshotStreamResult,
  toStreamFailure,
} from '../replication/snapshot-stream-assembler'
import type { NodeTransport, SnapshotSyncRequestPayload, TransportMessage } from '../transport/types'
import { ReplicationMessageTypes, TransportError } from '../transport/types'

export const CAPACITY_EXHAUSTED_BACKOFF_BASE_MS = 100
export const CAPACITY_EXHAUSTED_BACKOFF_MAX_MS = 500

/**
 * Errors that can legitimately be transient on the same target: retry the same
 * or next target. These are traffic-shaping, network, or controller-state errors.
 */
const RETRY_ANY_TARGET_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCodes.SNAPSHOT_SYNC_TRANSPORT_FAILED,
  ErrorCodes.SNAPSHOT_SYNC_TIMEOUT,
  ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED,
  ErrorCodes.SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
])

/**
 * Protocol-level errors that indicate a malformed frame from the peer. They
 * may be a transient bit-flip or a buggy peer; either way the sensible reaction
 * is to try a different target exactly once, not to cycle indefinitely.
 */
const RETRY_DIFFERENT_TARGET_PROTOCOL_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCodes.SNAPSHOT_SYNC_DECODE_FAILED,
  ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID,
  ErrorCodes.SNAPSHOT_SYNC_CHECKSUM_MISMATCH,
  ErrorCodes.SNAPSHOT_SYNC_CHUNK_OUT_OF_ORDER,
  ErrorCodes.SNAPSHOT_SYNC_CHUNK_OVERFLOW,
  ErrorCodes.SNAPSHOT_SYNC_CHUNK_MISSING,
  ErrorCodes.SNAPSHOT_SYNC_END_MISSING,
])

const TRANSIENT_PRIMARY_CODES: ReadonlySet<string> = new Set<string>([
  ErrorCodes.SNAPSHOT_SYNC_SNAPSHOT_FAILED,
  ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED,
  ErrorCodes.SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
])

type RetryKind = 'none' | 'any-target' | 'protocol'

function classifyFailure(code: ErrorCode, details: Record<string, unknown>): RetryKind {
  if (RETRY_ANY_TARGET_CODES.has(code)) {
    return 'any-target'
  }
  if (RETRY_DIFFERENT_TARGET_PROTOCOL_CODES.has(code)) {
    return 'protocol'
  }
  if (code === ErrorCodes.SNAPSHOT_SYNC_PRIMARY_ERROR) {
    const primaryCode = typeof details.primaryCode === 'string' ? details.primaryCode : null
    if (primaryCode !== null && TRANSIENT_PRIMARY_CODES.has(primaryCode)) {
      return 'any-target'
    }
  }
  return 'none'
}

export function isTransientFailure(code: ErrorCode, details: Record<string, unknown>): boolean {
  return classifyFailure(code, details) !== 'none'
}

export interface FetchFromTargetsDeps {
  transport: NodeTransport
  sourceNodeId: string
}

export async function fetchSnapshotFromAnyTarget(
  indexName: string,
  primaryNodeId: string,
  targets: string[],
  deadline: number,
  deps: FetchFromTargetsDeps,
  abortCheck: () => boolean,
): Promise<SnapshotStreamResult> {
  let lastFailure: SnapshotStreamFailure = {
    ok: false,
    code: ErrorCodes.SNAPSHOT_SYNC_TRANSPORT_FAILED,
    message: 'no snapshot fetch attempts were made',
    details: { primaryNodeId },
  }

  const attempted = new Set<string>()
  let protocolErrorBudget = targets.length
  for (const target of targets) {
    if (attempted.has(target)) {
      continue
    }
    attempted.add(target)
    if (abortCheck()) {
      return {
        ok: false,
        code: ErrorCodes.SNAPSHOT_SYNC_ABORTED,
        message: 'bootstrap sync aborted before next target',
        details: { primaryNodeId, target },
      }
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        code: ErrorCodes.SNAPSHOT_SYNC_TIMEOUT,
        message: 'bootstrap sync exceeded deadline while iterating targets',
        details: { primaryNodeId, targets },
      }
    }

    const attempt = await fetchSnapshotFromTarget(indexName, target, deadline, deps)
    if (attempt.ok) {
      return attempt
    }

    lastFailure = { ...attempt, details: { ...attempt.details, target } }
    const kind = classifyFailure(attempt.code, attempt.details)
    if (kind === 'none') {
      return lastFailure
    }
    if (kind === 'protocol') {
      protocolErrorBudget -= 1
      if (protocolErrorBudget <= 0) {
        return lastFailure
      }
    }

    if (attempt.code === ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED) {
      const aborted = await jitteredBackoff(
        CAPACITY_EXHAUSTED_BACKOFF_BASE_MS,
        CAPACITY_EXHAUSTED_BACKOFF_MAX_MS,
        deadline,
        abortCheck,
      )
      if (aborted) {
        return {
          ok: false,
          code: ErrorCodes.SNAPSHOT_SYNC_ABORTED,
          message: 'bootstrap sync aborted while backing off after capacity exhaustion',
          details: { primaryNodeId, target },
        }
      }
      if (Date.now() >= deadline) {
        return {
          ok: false,
          code: ErrorCodes.SNAPSHOT_SYNC_TIMEOUT,
          message: 'bootstrap sync exceeded deadline during capacity backoff',
          details: { primaryNodeId, targets },
        }
      }
    }
  }

  return lastFailure
}

const JITTERED_BACKOFF_POLL_INTERVAL_MS = 20

/**
 * Race a jittered sleep against both the caller's deadline and a cooperative
 * abort check. Returns true when the abort check tripped before the sleep
 * finished, false otherwise. The poll interval is short enough that an abort
 * is observed within ~20 ms even though `abortCheck` is synchronous and has
 * no wake-up primitive. Timers are cleared on every exit path so the event
 * loop never holds a stray handle.
 */
export async function jitteredBackoff(
  baseMs: number,
  maxMs: number,
  deadline: number,
  abortCheck: () => boolean,
): Promise<boolean> {
  const plannedMs = Math.floor(baseMs + Math.random() * (maxMs - baseMs))
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    return false
  }
  const sleepMs = Math.min(plannedMs, remainingMs)
  if (sleepMs <= 0) {
    return false
  }

  const sleepUntil = Date.now() + sleepMs
  if (abortCheck()) {
    return true
  }

  while (Date.now() < sleepUntil) {
    if (abortCheck()) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    const now = Date.now()
    const remaining = Math.min(sleepUntil - now, deadline - now)
    if (remaining <= 0) {
      return false
    }
    // Exit before the tail of the window degenerates into 1 ms spin-sleeps.
    // A final abort check above already protected the 2 ms slice we're giving
    // up; losing this slice is cheaper than re-entering setTimeout twice.
    if (remaining <= 2) {
      return false
    }
    const tickMs = Math.min(remaining, JITTERED_BACKOFF_POLL_INTERVAL_MS)
    await sleepForMs(tickMs)
  }
  return abortCheck()
}

function sleepForMs(ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      clearTimeout(timer)
      resolve()
    }, ms)
  })
}

async function fetchSnapshotFromTarget(
  indexName: string,
  target: string,
  deadline: number,
  deps: FetchFromTargetsDeps,
): Promise<SnapshotStreamResult> {
  const requestPayload: SnapshotSyncRequestPayload = { indexName }
  const request: TransportMessage = {
    type: ReplicationMessageTypes.SNAPSHOT_SYNC_REQUEST,
    sourceId: deps.sourceNodeId,
    requestId: generateId(),
    payload: encode(requestPayload),
  }

  const streamState = createSnapshotStreamState({ indexName, partitionId: null })

  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    return {
      ok: false,
      code: ErrorCodes.SNAPSHOT_SYNC_TIMEOUT,
      message: 'deadline expired before streaming snapshot',
      details: { target },
    }
  }

  try {
    const streamWork = deps.transport.stream(target, request, (chunk: Uint8Array) => {
      handleIncomingSnapshotFrame(streamState, chunk)
    })
    await withDeadline(streamWork, remainingMs, indexName, 'stream')
  } catch (err) {
    if (err instanceof NarsilError && err.code === ErrorCodes.SNAPSHOT_SYNC_TIMEOUT) {
      return toStreamFailure(err, ErrorCodes.SNAPSHOT_SYNC_TIMEOUT, 'snapshot stream deadline exceeded')
    }
    if (err instanceof TransportError) {
      return toStreamFailure(err, ErrorCodes.SNAPSHOT_SYNC_TRANSPORT_FAILED, 'snapshot transport failed')
    }
    return toStreamFailure(err, ErrorCodes.SNAPSHOT_SYNC_PRIMARY_ERROR, 'snapshot fetch raised non-transport error')
  }

  const result = finalizeSnapshotStream(streamState)
  if (!result.ok) {
    return result
  }

  const computedChecksum = crc32(result.bytes)
  if (computedChecksum !== result.header.checksum) {
    return {
      ok: false,
      code: ErrorCodes.SNAPSHOT_SYNC_CHECKSUM_MISMATCH,
      message: 'computed checksum does not match header checksum',
      details: { computed: computedChecksum, header: result.header.checksum },
    }
  }
  return result
}

export async function withDeadline<T>(work: Promise<T>, ms: number, indexName: string, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const deadlinePromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new NarsilError(ErrorCodes.SNAPSHOT_SYNC_TIMEOUT, `bootstrap sync exceeded deadline during ${phase}`, {
          indexName,
          phase,
        }),
      )
    }, ms)
  })
  try {
    return await Promise.race([work, deadlinePromise])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}
