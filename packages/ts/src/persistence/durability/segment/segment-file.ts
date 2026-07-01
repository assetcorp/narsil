import { decode, encode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import {
  type EnvelopeParts,
  packSnapshotEnvelopePartsRetrying,
  unpackEnvelopeBytes,
} from '../../../serialization/envelope'
import { deserializePayloadV2 } from '../../../serialization/payload-v2'
import type { SerializablePartition } from '../../../types/internal'
import type { DurableDirectory } from '../durable-filesystem'

export interface SegmentContents {
  partition: SerializablePartition
  tombstones: string[]
}

export async function persistSegmentFile(
  directory: DurableDirectory,
  key: string,
  payload: Uint8Array,
  tombstones: string[],
): Promise<void> {
  const parts = await encodeSegmentFile(payload, tombstones)
  await directory.atomicWrite(key, [parts.header, parts.payload])
}

export async function readSegmentContents(directory: DurableDirectory, key: string): Promise<SegmentContents> {
  const bytes = await directory.read(key)
  if (bytes === null) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Segment file "${key}" is missing`, { key })
  }
  return decodeSegmentFile(bytes)
}

interface RawSegmentContainer {
  payload?: Uint8Array
  tombstones?: unknown
}

export function encodeSegmentFile(payload: Uint8Array, tombstones: string[]): Promise<EnvelopeParts> {
  return packSnapshotEnvelopePartsRetrying(() => encode({ payload, tombstones }))
}

export async function decodeSegmentFile(bytes: Uint8Array): Promise<SegmentContents> {
  const { payloadBytes } = await unpackEnvelopeBytes(bytes)
  const raw = decode(payloadBytes) as RawSegmentContainer
  if (!(raw.payload instanceof Uint8Array)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment file is missing its partition payload')
  }
  const tombstones = normalizeTombstones(raw.tombstones)
  return { partition: deserializePayloadV2(raw.payload), tombstones }
}

function normalizeTombstones(raw: unknown): string[] {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment file has a malformed tombstone list')
  }
  const result: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string') {
      throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment file tombstone entry is not a string', {
        value,
      })
    }
    result.push(value)
  }
  return result
}
