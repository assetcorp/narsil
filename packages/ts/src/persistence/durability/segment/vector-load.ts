import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import { openChecksummedEnvelope } from '../../../serialization/envelope-file'
import { HEADER_SIZE } from '../../../serialization/header'
import { osqBitsOf } from '../../../vector/osq'
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
import { type CheckpointStore, readListedFile, requireListedChecksum, requireListedSize } from './store'

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

function holdsEveryHead(ref: VectorFieldRef): boolean {
  if (ref.graphParts.length === 0 || ref.files.length === 0) return false
  return [...ref.files, ...ref.graphParts].every(file => file.headOffset !== undefined)
}

async function loadFieldOnDemand(
  store: CheckpointStore,
  ref: VectorFieldRef,
  vectorIndex: VectorIndex,
  resolvePartition: (docId: string) => number | undefined,
): Promise<boolean> {
  const { pathOf } = store
  if (pathOf === undefined || vectorIndex.storage !== 'disk' || !holdsEveryHead(ref)) return false
  const { loadFilesByParts, openColdVectorField, waitBeforeColdLoad } = await import('../../paged/module')
  await Promise.all([
    ...ref.files.map(file => requireListedSize(store, file.key, { bytes: file.bytes, what: 'vector file' })),
    ...ref.graphParts.map(part => requireListedSize(store, part.key, { bytes: part.bytes, what: 'graph part' })),
  ])
  const files = await Promise.all(
    ref.files.map(async file => ({ ref: file, path: await pathOf.call(store, file.key) })),
  )
  const graphParts = await Promise.all(
    ref.graphParts.map(async part => ({ ref: part, path: await pathOf.call(store, part.key) })),
  )
  const field = openColdVectorField({
    fieldPath: ref.fieldPath,
    dimension: vectorIndex.dimension,
    metric: vectorIndex.metric,
    codeBits: osqBitsOf(vectorIndex.quantization),
    files,
    graphParts,
    resolvePartition,
  })
  if (field === null) return false
  vectorIndex.openColdField(field, async (beginRestore, stillWanted) => {
    await waitBeforeColdLoad()
    if (!stillWanted()) return
    const graph = await readGraphParts(store, ref)
    if (!stillWanted()) return
    const restore = beginRestore({ liveVectors: liveVectorsOf(ref), holdsGraph: true, graph })
    await loadFilesByParts(files, restore, ref.fieldPath, vectorIndex.dimension, stillWanted)
  })
  return true
}

export async function loadVectorField(
  store: CheckpointStore,
  ref: VectorFieldRef,
  vectorIndex: VectorIndex,
  resolvePartition: ((docId: string) => number | undefined) | null = null,
): Promise<void> {
  if (resolvePartition !== null && (await loadFieldOnDemand(store, ref, vectorIndex, resolvePartition))) return
  const restore = vectorIndex.restoreCheckpoint({
    liveVectors: liveVectorsOf(ref),
    holdsGraph: ref.graphParts.length > 0,
    graph: await readGraphParts(store, ref),
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
  restore.finish()
}
