import { ErrorCodes, NarsilError, type NarsilErrorCode } from '../../errors'

const TRANSIENT_CODES: ReadonlySet<NarsilErrorCode> = new Set<NarsilErrorCode>([
  ErrorCodes.SNAPSHOT_SYNC_TRANSPORT_FAILED,
  ErrorCodes.SNAPSHOT_SYNC_TIMEOUT,
  ErrorCodes.SNAPSHOT_SYNC_CAPACITY_EXHAUSTED,
  ErrorCodes.SNAPSHOT_SYNC_ALLOCATION_UNAVAILABLE,
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

export function isTransientFailure(code: NarsilErrorCode, details: Record<string, unknown>): boolean {
  if (TRANSIENT_CODES.has(code)) {
    return true
  }
  if (code !== ErrorCodes.SNAPSHOT_SYNC_PRIMARY_ERROR) {
    return false
  }
  return typeof details.primaryCode === 'string' && TRANSIENT_PRIMARY_CODES.has(details.primaryCode)
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
