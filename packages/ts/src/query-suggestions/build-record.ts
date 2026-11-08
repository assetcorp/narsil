import { encode } from '@msgpack/msgpack'
import { compareCodePoints } from '../core/ordering'
import { sha256 } from '../persistence/durability/sha256'
import { crc32 } from '../serialization/crc32'
import { openChecksummedEnvelope, packEnvelopeWithChecksum } from '../serialization/envelope-file'
import { decode } from '../serialization/msgpack'
import type { QuerySuggestionsBuild, QuerySuggestionsBuildTrigger } from '../types/query-suggestions'

const BUILD_RECORD_FORMAT_VERSION = 1
export const SOURCES_DIGEST_BYTES = 32

export interface BuildRecord {
  buildId: string
  trigger: QuerySuggestionsBuildTrigger
  status: QuerySuggestionsBuild['status']
  startedAt: number
  endedAt?: number
  published: number
  removed: number
  discarded: number
  sourcesDigest: Uint8Array
  errorCode?: string
}

export interface MergedSource {
  nodeId: string
  key: string
  savedAt: number
}

const TRIGGERS = new Set<string>(['schedule', 'missed', 'caller'])
const STATUSES = new Set<string>(['running', 'completed', 'failed', 'skipped'])
const WHAT = 'query suggestions build record'

export function sourcesDigestOf(sources: readonly MergedSource[]): Uint8Array {
  const sorted = [...sources].sort(
    (left, right) => compareCodePoints(left.nodeId, right.nodeId) || compareCodePoints(left.key, right.key),
  )
  return sha256(encode(sorted.map(source => [source.nodeId, source.key, source.savedAt])))
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function buildRecordToWire(record: BuildRecord): Uint8Array {
  return encode({
    buildId: record.buildId,
    trigger: record.trigger,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    published: record.published,
    removed: record.removed,
    discarded: record.discarded,
    sourcesDigest: record.sourcesDigest,
    ...(record.errorCode !== undefined ? { errorCode: record.errorCode } : {}),
  })
}

export function buildRecordFromWire(bytes: Uint8Array): BuildRecord | null {
  let raw: unknown
  try {
    raw = decode(bytes)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const { buildId, trigger, status, startedAt, endedAt, published, removed, discarded, sourcesDigest, errorCode } =
    value
  if (typeof buildId !== 'string' || typeof trigger !== 'string' || !TRIGGERS.has(trigger)) return null
  if (typeof status !== 'string' || !STATUSES.has(status)) return null
  if (!isCount(startedAt) || !isCount(published) || !isCount(removed) || !isCount(discarded)) return null
  if (endedAt !== undefined && !isCount(endedAt)) return null
  if (errorCode !== undefined && typeof errorCode !== 'string') return null
  if (!(sourcesDigest instanceof Uint8Array) || sourcesDigest.byteLength !== SOURCES_DIGEST_BYTES) return null
  return {
    buildId,
    trigger: trigger as QuerySuggestionsBuildTrigger,
    status: status as QuerySuggestionsBuild['status'],
    startedAt,
    ...(endedAt !== undefined ? { endedAt } : {}),
    published,
    removed,
    discarded,
    sourcesDigest: new Uint8Array(sourcesDigest),
    ...(errorCode !== undefined ? { errorCode } : {}),
  }
}

export function encodeBuildRecordFile(record: BuildRecord): Uint8Array {
  const payload = buildRecordToWire(record)
  const packed = packEnvelopeWithChecksum([payload], BUILD_RECORD_FORMAT_VERSION, WHAT, crc32(payload))
  const bytes = new Uint8Array(packed.byteLength)
  let offset = 0
  for (const chunk of packed.chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function decodeBuildRecordFile(bytes: Uint8Array): Promise<BuildRecord | null> {
  try {
    const { payload } = await openChecksummedEnvelope(bytes, {
      envelopeFormatVersion: BUILD_RECORD_FORMAT_VERSION,
      what: WHAT,
      allowsCompression: false,
    })
    return buildRecordFromWire(payload)
  } catch {
    return null
  }
}

export function publicBuildOf(record: BuildRecord): QuerySuggestionsBuild {
  return {
    buildId: record.buildId,
    trigger: record.trigger,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt ?? null,
    published: record.published,
    removed: record.removed,
    discarded: record.discarded,
    errorCode: record.errorCode ?? null,
  }
}
