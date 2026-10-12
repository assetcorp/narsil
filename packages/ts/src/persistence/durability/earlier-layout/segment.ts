import { decode } from '@msgpack/msgpack'
import type { SegmentDocument } from '../../../core/partition/segment-builder'
import { ErrorCodes, NarsilError } from '../../../errors'
import { unpackEnvelopeBytes } from '../../../serialization/envelope'
import { deserializePayloadV2, documentsOfPayloadV2 } from '../../../serialization/payload-v2'
import type { SerializablePartition } from '../../../types/internal'
import type { CheckpointStore } from '../segment/store'

export interface EarlierSegmentContents {
  partition: SerializablePartition
  tombstones: string[]
}

export interface EarlierSegmentDocuments {
  schema: Record<string, string>
  documents: SegmentDocument[]
  tombstones: string[]
}

interface EarlierSegmentContainer {
  payload: Uint8Array
  tombstones: string[]
}

function normalizeTombstones(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || !raw.every(value => typeof value === 'string')) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment file has a malformed tombstone list')
  }
  return raw
}

async function openContainer(store: CheckpointStore, key: string): Promise<EarlierSegmentContainer> {
  const bytes = await store.read(key)
  if (bytes === null) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, `Segment file "${key}" is missing`, { key })
  }
  const { payloadBytes } = await unpackEnvelopeBytes(bytes)
  const raw = decode(payloadBytes) as { payload?: unknown; tombstones?: unknown }
  if (!(raw.payload instanceof Uint8Array)) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'Segment file is missing its partition payload', { key })
  }
  return { payload: raw.payload, tombstones: normalizeTombstones(raw.tombstones) }
}

export async function readEarlierSegmentContents(store: CheckpointStore, key: string): Promise<EarlierSegmentContents> {
  const { payload, tombstones } = await openContainer(store, key)
  return { partition: deserializePayloadV2(payload), tombstones }
}

export async function readEarlierSegmentDocuments(
  store: CheckpointStore,
  key: string,
): Promise<EarlierSegmentDocuments> {
  const { payload, tombstones } = await openContainer(store, key)
  const stored = documentsOfPayloadV2(payload)
  const documents: SegmentDocument[] = []
  for (const [docId, document] of Object.entries(stored.documents)) {
    documents.push({ docId, document: document.fields })
  }
  return { schema: stored.schema, documents, tombstones }
}
