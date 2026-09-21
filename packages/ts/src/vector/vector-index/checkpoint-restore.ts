import { ErrorCodes, NarsilError } from '../../errors'
import { createHNSWIndex } from '../hnsw'
import { requireWholeNeighbourLists } from '../hnsw/numbered-graph'
import { osqBitsOf } from '../osq'
import { magnitude } from '../similarity'
import type { VectorFilePayload, VectorGraphPayload } from './checkpoint-payload'
import { type SavedVectorFile, signatureOf } from './checkpoint-plan'
import { isDead, NO_LIVE_VECTOR_AT_POSITION } from './dead-bits'
import { readsFromDisk, type VectorPartFile } from './disk'
import { bytesToVectors, type VectorIndexCodes } from './payload'
import { adoptGraph, emptyFieldBeforeRestore, recalibrateFromStore, type VectorIndexState } from './shared'

const CALIBRATION_NEVER_CURRENT = -1

export interface LoadedVectorFile {
  id: number
  key: string
  payload: VectorFilePayload
  dead: Uint8Array | null
  location: VectorPartFile | null
}

export interface CheckpointRestoreShape {
  liveVectors: number
  holdsGraph: boolean
}

export interface VectorCheckpointRestore {
  addFile(file: LoadedVectorFile): void
  finish(graph: VectorGraphPayload | null): void
}

function sameCentroid(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function bufferEveryVectorOutsideTheGraph(state: VectorIndexState): void {
  for (const [docId] of state.store.entries()) {
    if (state.tombstones.has(docId)) continue
    if (state.hnsw === null || !state.hnsw.has(docId)) state.buffer.add(docId)
  }
}

function restoreGraph(state: VectorIndexState, payload: VectorGraphPayload | null, ordinalOfNumber: Int32Array): void {
  const first = payload?.graphs[0]
  if (payload === null || first === undefined) {
    bufferEveryVectorOutsideTheGraph(state)
    return
  }
  const graph = createHNSWIndex(
    state.dimension,
    state.store,
    { m: first.m, efConstruction: first.efConstruction, metric: first.metric },
    state.osq ?? undefined,
  )
  graph.deserializeNumbered(first, ordinalOfNumber)
  adoptGraph(state, graph)
  for (const later of payload.graphs.slice(1)) {
    requireWholeNeighbourLists(later)
    for (let number = 0; number < later.levels.length && number < ordinalOfNumber.length; number++) {
      const ordinal = ordinalOfNumber[number]
      if (later.levels[number] === 0 || ordinal === NO_LIVE_VECTOR_AT_POSITION) continue
      const docId = state.store.docIdForOrdinal(ordinal)
      if (docId !== undefined && !graph.has(docId)) graph.insertOrdinal(ordinal)
    }
  }
  bufferEveryVectorOutsideTheGraph(state)
  if (state.buffer.size <= graph.size) return
  adoptGraph(state, null)
  state.buffer.clear()
  bufferEveryVectorOutsideTheGraph(state)
}

export function beginCheckpointRestore(
  state: VectorIndexState,
  shape: CheckpointRestoreShape,
): VectorCheckpointRestore {
  emptyFieldBeforeRestore(state)
  const cold = readsFromDisk(state) && (shape.holdsGraph || shape.liveVectors >= state.promotionThreshold)
  const restoresCodes = state.osq !== null && osqBitsOf(state.quantizationMode) !== null && shape.holdsGraph
  const files: Array<{ id: number; key: string; ordinals: Int32Array; coded: boolean }> = []
  let sharedCodes: VectorIndexCodes | null = null
  let codesAgree = true

  function restoreRecords(payload: VectorFilePayload, ordinals: Int32Array): void {
    const quantizer = state.osq
    const layout = state.store.handles.codeLayout
    if (!restoresCodes || quantizer === null || layout === null || !codesAgree) return
    const codes = payload.codes
    if (codes === null || codes.bits !== quantizer.bits) {
      codesAgree = false
      return
    }
    if (sharedCodes === null) {
      sharedCodes = codes
      quantizer.restoreCentroid(Float32Array.from(codes.centroid))
    } else if (!sameCentroid(sharedCodes.centroid, codes.centroid)) {
      codesAgree = false
      return
    }
    const stride = layout.slotStride
    for (let i = 0; i < ordinals.length; i++) {
      if (ordinals[i] === NO_LIVE_VECTOR_AT_POSITION) continue
      quantizer.restoreRecord(payload.docIds[i], codes.records.subarray(i * stride, (i + 1) * stride))
    }
  }

  function addFile(file: LoadedVectorFile): void {
    const { payload, location } = file
    if (payload.dimension !== state.dimension) {
      throw new NarsilError(
        ErrorCodes.VECTOR_DIMENSION_MISMATCH,
        `Payload dimension ${payload.dimension} does not match index dimension ${state.dimension}`,
        { expected: state.dimension, received: payload.dimension },
      )
    }
    const dimension = state.dimension
    const onDisk = readsFromDisk(state) && location !== null
    const vectors = bytesToVectors(payload.vectors)
    const fileIndex = onDisk && cold ? state.store.addVectorFile(location.path) : null
    const ordinals = new Int32Array(payload.docIds.length).fill(NO_LIVE_VECTOR_AT_POSITION)
    for (let i = 0; i < payload.docIds.length; i++) {
      if (isDead(file.dead, i)) continue
      const docId = payload.docIds[i]
      const replaced = state.store.getOrdinal(docId)
      if (replaced !== undefined) state.osq?.removeOrdinal(replaced)
      const vector = vectors.subarray(i * dimension, (i + 1) * dimension)
      const offset = onDisk ? location.vectorsOffset + i * dimension * 4 : 0
      if (fileIndex !== null) {
        ordinals[i] = state.store.insertCold(docId, magnitude(vector), { fileIndex, offset })
        continue
      }
      ordinals[i] = state.store.insert(docId, vector)
      if (onDisk) state.pendingLocations.set(docId, { path: location.path, offset })
    }
    restoreRecords(payload, ordinals)
    files.push({ id: file.id, key: file.key, ordinals, coded: payload.codes !== null })
  }

  function finish(graph: VectorGraphPayload | null): void {
    const codesRestored = restoresCodes && codesAgree && sharedCodes !== null
    if (restoresCodes && !codesRestored) recalibrateFromStore(state)

    let total = 0
    for (const file of files) total += file.ordinals.length
    const ordinalOfNumber = new Int32Array(total)
    let number = 0
    for (const file of files) {
      for (let i = 0; i < file.ordinals.length; i++) {
        if (!state.store.holdsOrdinal(file.ordinals[i])) file.ordinals[i] = NO_LIVE_VECTOR_AT_POSITION
      }
      ordinalOfNumber.set(file.ordinals, number)
      number += file.ordinals.length
    }
    restoreGraph(state, graph, ordinalOfNumber)

    const current = signatureOf(state).calibration
    const codedUnder = codesRestored && current !== null ? current : CALIBRATION_NEVER_CURRENT
    const saved: SavedVectorFile[] = files.map(file => ({
      id: file.id,
      key: file.key,
      ordinals: file.ordinals,
      calibration: file.coded ? codedUnder : null,
    }))
    state.savedFiles = saved
    state.savedSignature = signatureOf(state)
  }

  return { addFile, finish }
}
