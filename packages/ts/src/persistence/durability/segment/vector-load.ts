import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { openChecksummedEnvelope } from '../../../serialization/envelope-file'
import { HEADER_SIZE } from '../../../serialization/header'
import type { VectorIndex } from '../../../vector/vector-index'
import {
  assembleGraphParts,
  decodeVectorFilePayload,
  decodeVectorGraphPartPayload,
  type VectorFilePayload,
  type VectorGraphPartPayload,
  type VectorGraphParts,
} from '../../../vector/vector-index/checkpoint-payload'
import { countDead } from '../../../vector/vector-index/dead-bits'
import type { FileRef, VectorFieldRef, VectorFileRef } from './manifest'
import { type CheckpointStore, readListedFile, requireListedChecksum } from './store'

export const VECTOR_FILE_ENVELOPE_VERSION = 2
export const GRAPH_PART_ENVELOPE_VERSION = 2

function liveVectorsOf(ref: VectorFieldRef): number {
  let live = 0
  for (const file of ref.files) live += file.count - countDead(file.dead, file.count)
  return live
}

async function openListedFile(
  store: CheckpointStore,
  ref: FileRef,
  what: string,
  allowsCompression: boolean,
): Promise<{ payload: Uint8Array; payloadLength: number }> {
  const bytes = await readListedFile(store, ref.key, { bytes: ref.bytes, what })
  const { header, payload } = await openChecksummedEnvelope(bytes, {
    envelopeFormatVersion: VECTOR_FILE_ENVELOPE_VERSION,
    what: `${what} "${ref.key}"`,
    allowsCompression,
  })
  requireListedChecksum(what, ref.key, header.checksum, ref.checksum)
  return { payload, payloadLength: header.payloadLength }
}

export async function readGraphParts(store: CheckpointStore, ref: VectorFieldRef): Promise<VectorGraphParts | null> {
  if (ref.graphParts.length === 0) return null
  const parts: VectorGraphPartPayload[] = []
  for (const part of ref.graphParts) {
    const { payload } = await openListedFile(store, part, 'graph part', true)
    const decoded = decodeVectorGraphPartPayload(decode(payload))
    if (decoded.fieldName !== ref.fieldPath) {
      throw new NarsilError(
        ErrorCodes.PERSISTENCE_LOAD_FAILED,
        `The graph part "${part.key}" names field "${decoded.fieldName}" where the manifest lists "${ref.fieldPath}"`,
        { key: part.key },
      )
    }
    parts.push(decoded)
  }
  return assembleGraphParts(parts)
}

export async function readVectorFile(
  store: CheckpointStore,
  file: VectorFileRef,
  fieldPath: string,
): Promise<{ payload: VectorFilePayload; payloadLength: number }> {
  const { payload: bytes, payloadLength } = await openListedFile(store, file, 'vector file', false)
  const payload = decodeVectorFilePayload(decode(bytes))
  if (payload.docIds.length !== file.count) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `The vector file "${file.key}" holds ${payload.docIds.length} vectors where the manifest counts ${file.count}`,
      { key: file.key, held: payload.docIds.length, count: file.count },
    )
  }
  if (payload.fieldName !== fieldPath) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `The vector file "${file.key}" names field "${payload.fieldName}" where the manifest lists "${fieldPath}"`,
      { key: file.key },
    )
  }
  return { payload, payloadLength }
}

export async function loadVectorField(
  store: CheckpointStore,
  ref: VectorFieldRef,
  vectorIndex: VectorIndex,
): Promise<void> {
  const restore = vectorIndex.restoreCheckpoint({
    liveVectors: liveVectorsOf(ref),
    holdsGraph: ref.graphParts.length > 0,
  })
  for (const file of ref.files) {
    const { payload, payloadLength } = await readVectorFile(store, file, ref.fieldPath)
    restore.addFile({
      id: file.id,
      key: file.key,
      payload,
      dead: file.dead,
      location:
        store.pathOf === undefined
          ? null
          : {
              path: await store.pathOf(file.key),
              vectorsOffset: HEADER_SIZE + payloadLength - payload.vectors.byteLength,
            },
    })
  }
  restore.finish(await readGraphParts(store, ref))
}
