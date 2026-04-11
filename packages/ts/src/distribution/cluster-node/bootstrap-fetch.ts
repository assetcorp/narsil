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

const TRANSIENT_FAILURE_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  ErrorCodes.SNAPSHOT_SYNC_TRANSPORT_FAILED,
  ErrorCodes.SNAPSHOT_SYNC_TIMEOUT,
  ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED,
  ErrorCodes.SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
  ErrorCodes.SNAPSHOT_SYNC_CHECKSUM_MISMATCH,
  ErrorCodes.SNAPSHOT_SYNC_DECODE_FAILED,
  ErrorCodes.SNAPSHOT_SYNC_FRAME_INVALID,
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

export function isTransientFailure(code: ErrorCode, details: Record<string, unknown>): boolean {
  if (TRANSIENT_FAILURE_CODES.has(code)) {
    return true
  }
  if (code === ErrorCodes.SNAPSHOT_SYNC_PRIMARY_ERROR) {
    const primaryCode = typeof details.primaryCode === 'string' ? details.primaryCode : null
    if (primaryCode !== null && TRANSIENT_PRIMARY_CODES.has(primaryCode)) {
      return true
    }
  }
  return false
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

    if (!isTransientFailure(attempt.code, attempt.details)) {
      return lastFailure
    }

    if (attempt.code === ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED) {
      await jitteredBackoff(CAPACITY_EXHAUSTED_BACKOFF_BASE_MS, CAPACITY_EXHAUSTED_BACKOFF_MAX_MS)
    }
  }

  return lastFailure
}

function jitteredBackoff(baseMs: number, maxMs: number): Promise<void> {
  const jitter = baseMs + Math.random() * (maxMs - baseMs)
  return new Promise(resolve => {
    setTimeout(resolve, Math.floor(jitter))
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
