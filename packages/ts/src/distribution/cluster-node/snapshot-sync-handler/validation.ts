import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { MAX_INDEX_NAME_LENGTH } from '../../cluster/index-metadata'
import type { SnapshotSyncRequestPayload, TransportMessage } from '../../transport/types'
import { respondError, type SingleResponseSink } from '../snapshot-stream-writer'

import type { SnapshotSyncHandlerDeps } from './types'

export const INDEX_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export const MAX_SOURCE_ID_LENGTH = 256

/**
 * Control characters in a sourceId would collide with our per-source slot key
 * separator (NUL) and could let an authorized replica forge a key that aliases
 * another replica's slot. Beyond NUL, reject the full ASCII C0 + DEL set, the
 * Unicode C1 control range, the line and paragraph separators, and the BOM,
 * because all of these confuse log viewers, audit trails, and any future
 * normalization-aware comparator. Reject the whole class at the trust boundary
 * before any slot acquisition or engine work. Uses a character-code scan
 * rather than a regex to avoid embedding control characters in source
 * (biome's noControlCharactersInRegex).
 */
export function containsControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20) {
      return true
    }
    if (code >= 0x7f && code <= 0x9f) {
      return true
    }
    if (code === 0x2028 || code === 0x2029 || code === 0xfeff) {
      return true
    }
  }
  return false
}

/**
 * A SNAPSHOT_SYNC_REQUEST carries `{indexName: string, partitionId?: number}`
 * with `indexName` bounded by the canonical MAX_INDEX_NAME_LENGTH. Rejecting
 * oversized payloads before msgpack decode keeps an abusive peer from pinning
 * a CPU on a 64 MiB decode that then fails validation.
 */

export const MAX_SNAPSHOT_SYNC_REQUEST_BYTES = 4_096

export const REQUEST_DECODE_OPTIONS = {
  maxMapLength: 16,
  maxArrayLength: 16,
  maxStrLength: MAX_INDEX_NAME_LENGTH,
  maxBinLength: 0,
  maxExtLength: 0,
  keyDecoder: null,
} as const

export async function decodeRequest(
  message: TransportMessage,
  sink: SingleResponseSink,
  deps: SnapshotSyncHandlerDeps,
): Promise<SnapshotSyncRequestPayload | null> {
  try {
    const decoded = decode(message.payload, REQUEST_DECODE_OPTIONS) as unknown
    return validateSnapshotSyncRequestPayload(decoded)
  } catch (err) {
    const code = err instanceof NarsilError ? err.code : ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID
    const errMessage = err instanceof Error ? err.message : String(err)
    await respondError(sink, deps.nodeId, message.requestId, code, errMessage)
    return null
  }
}

export function validateSourceId(sourceId: unknown): string | null {
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    return 'request sourceId is missing'
  }
  if (sourceId.length > MAX_SOURCE_ID_LENGTH) {
    return `request sourceId exceeds ${MAX_SOURCE_ID_LENGTH} characters`
  }
  if (containsControlCharacter(sourceId)) {
    return 'request sourceId contains control characters'
  }
  return null
}

/**
 * Forward-compatible validator: unknown top-level fields are tolerated so
 * future protocol versions can add optional hints without breaking older peers.
 * All required fields are validated strictly.
 */
export function validateSnapshotSyncRequestPayload(decoded: unknown): SnapshotSyncRequestPayload {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
      'Invalid SnapshotSyncRequestPayload: expected an object',
    )
  }
  const record = decoded as Record<string, unknown>
  const indexName = record.indexName
  if (typeof indexName !== 'string' || indexName.length === 0) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
      'Invalid SnapshotSyncRequestPayload: "indexName" must be a non-empty string',
    )
  }
  if (indexName.length > MAX_INDEX_NAME_LENGTH) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
      `Invalid SnapshotSyncRequestPayload: "indexName" must be at most ${MAX_INDEX_NAME_LENGTH} characters`,
      { length: indexName.length, limit: MAX_INDEX_NAME_LENGTH },
    )
  }
  if (!INDEX_NAME_PATTERN.test(indexName) || indexName.includes('..')) {
    throw new NarsilError(
      ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
      'Invalid SnapshotSyncRequestPayload: "indexName" contains invalid characters',
    )
  }
  const partitionId = record.partitionId
  if (partitionId !== undefined && partitionId !== null) {
    if (typeof partitionId !== 'number' || !Number.isInteger(partitionId) || partitionId < 0) {
      throw new NarsilError(
        ErrorCodes.SNAPSHOT_SYNC_REQUEST_INVALID,
        'Invalid SnapshotSyncRequestPayload: "partitionId" must be a non-negative integer when provided',
      )
    }
    return { indexName, partitionId }
  }
  return { indexName, partitionId: null }
}
