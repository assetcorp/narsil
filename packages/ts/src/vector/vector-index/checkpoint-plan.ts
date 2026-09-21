import { STORE_CALIBRATION_GENERATION } from '../vector-store/handles'
import {
  VECTOR_FILE_MAX_VECTORS,
  VECTOR_FILE_PAYLOAD_VERSION,
  VECTOR_GRAPH_PAYLOAD_VERSION,
  type VectorFilePayload,
  type VectorGraphPayload,
} from './checkpoint-payload'
import { VECTOR_FILE_REPLACED_ABOVE_DEAD_SHARE } from './constants'
import { deadBitsWhere, NO_LIVE_VECTOR_AT_POSITION } from './dead-bits'
import { vectorsToBytes } from './payload'
import { codedCentroid, partCodes } from './persistence'
import type { VectorIndexState } from './shared'

const ORDINAL_HOLDS_NO_NUMBER = -1

export interface SavedVectorFile {
  id: number
  key: string
  ordinals: Int32Array
  calibration: number | null
}

export interface FieldSignature {
  revision: number
  graphSize: number
  calibration: number | null
}

export interface KeptVectorFile {
  id: number
  key: string
  count: number
  dead: Uint8Array | null
}

export interface NewVectorFile {
  payload: VectorFilePayload
  ordinals: Int32Array
}

export interface VectorCheckpointPlan {
  readonly unchanged: boolean
  readonly kept: readonly KeptVectorFile[]
  readonly keptFiles: readonly SavedVectorFile[]
  readonly newFiles: number
  readonly graph: VectorGraphPayload | null
  readonly signature: FieldSignature
  readNewFile(index: number): NewVectorFile
}

function calibrationOf(state: VectorIndexState): number | null {
  if (codedCentroid(state) === null) return null
  return Atomics.load(state.store.handles.header, STORE_CALIBRATION_GENERATION)
}

export function signatureOf(state: VectorIndexState): FieldSignature {
  return { revision: state.revision, graphSize: state.hnsw?.size ?? -1, calibration: calibrationOf(state) }
}

function sameSignature(a: FieldSignature | null, b: FieldSignature): boolean {
  return a !== null && a.revision === b.revision && a.graphSize === b.graphSize && a.calibration === b.calibration
}

function registryMatches(state: VectorIndexState, listedKeys: readonly string[] | null): boolean {
  const listed = listedKeys ?? []
  if (listed.length !== state.savedFiles.length) return false
  return state.savedFiles.every((file, index) => file.key === listed[index])
}

function isLive(state: VectorIndexState, ordinal: number): boolean {
  if (ordinal === NO_LIVE_VECTOR_AT_POSITION) return false
  const docId = state.store.docIdForOrdinal(ordinal)
  return docId !== undefined && !state.tombstones.has(docId)
}

function liveCountOf(state: VectorIndexState, file: SavedVectorFile): number {
  let live = 0
  for (let i = 0; i < file.ordinals.length; i++) if (isLive(state, file.ordinals[i])) live += 1
  return live
}

function deadBitsOf(state: VectorIndexState, file: SavedVectorFile): Uint8Array | null {
  return deadBitsWhere(file.ordinals.length, position => !isLive(state, file.ordinals[position]))
}

function filesWorthKeeping(
  state: VectorIndexState,
  listed: readonly SavedVectorFile[],
  calibration: number | null,
  liveCounts: number[],
): SavedVectorFile[] {
  const kept: SavedVectorFile[] = []
  for (const file of listed) {
    const live = liveCountOf(state, file)
    const deadShare = file.ordinals.length === 0 ? 1 : 1 - live / file.ordinals.length
    if (file.calibration !== calibration || deadShare > VECTOR_FILE_REPLACED_ABOVE_DEAD_SHARE) continue
    kept.push(file)
    liveCounts.push(live)
  }
  return kept
}

function absorbSmallerPartialFiles(kept: SavedVectorFile[], liveCounts: number[], vectorsToWrite: number): void {
  let pending = vectorsToWrite
  for (let index = kept.length - 1; index >= 0 && pending > 0; index--) {
    if (kept[index].ordinals.length >= VECTOR_FILE_MAX_VECTORS) continue
    if (liveCounts[index] > pending) return
    pending += liveCounts[index]
    kept.splice(index, 1)
    liveCounts.splice(index, 1)
  }
}

function ordinalsOutsideOf(state: VectorIndexState, kept: readonly SavedVectorFile[]): number[] {
  const slots = state.store.slots
  const saved = new Uint8Array(slots)
  for (const file of kept) {
    for (let i = 0; i < file.ordinals.length; i++) {
      const ordinal = file.ordinals[i]
      if (ordinal !== NO_LIVE_VECTOR_AT_POSITION && ordinal < slots) saved[ordinal] = 1
    }
  }
  const outside: number[] = []
  for (let ordinal = 0; ordinal < slots; ordinal++) {
    if (saved[ordinal] === 0 && isLive(state, ordinal)) outside.push(ordinal)
  }
  return outside
}

function countOutside(state: VectorIndexState, liveCounts: readonly number[]): number {
  let held = 0
  for (const live of liveCounts) held += live
  return Math.max(0, state.store.size - state.tombstones.size - held)
}

interface VectorNumbers {
  numberOfOrdinal: Int32Array
  ordinalOfNumber: Int32Array
}

function numberEveryVector(
  state: VectorIndexState,
  kept: readonly SavedVectorFile[],
  written: readonly number[],
): VectorNumbers {
  let total = written.length
  for (const file of kept) total += file.ordinals.length
  const numberOfOrdinal = new Int32Array(state.store.slots).fill(ORDINAL_HOLDS_NO_NUMBER)
  const ordinalOfNumber = new Int32Array(total).fill(NO_LIVE_VECTOR_AT_POSITION)
  let number = 0
  for (const file of kept) {
    for (let i = 0; i < file.ordinals.length; i++, number++) {
      const ordinal = file.ordinals[i]
      if (!isLive(state, ordinal)) continue
      numberOfOrdinal[ordinal] = number
      ordinalOfNumber[number] = ordinal
    }
  }
  for (const ordinal of written) {
    numberOfOrdinal[ordinal] = number
    ordinalOfNumber[number] = ordinal
    number += 1
  }
  return { numberOfOrdinal, ordinalOfNumber }
}

function graphOf(state: VectorIndexState, numbers: VectorNumbers): VectorGraphPayload | null {
  if (state.hnsw === null) return null
  return {
    v: VECTOR_GRAPH_PAYLOAD_VERSION,
    fieldName: state.fieldName,
    graphs: [state.hnsw.serializeNumbered(numbers.numberOfOrdinal, numbers.ordinalOfNumber)],
  }
}

function readFile(
  state: VectorIndexState,
  planned: readonly number[],
  docIds: string[],
  centroid: number[] | null,
): NewVectorFile {
  const dimension = state.dimension
  const vectors = new Float32Array(planned.length * dimension)
  const ordinals = new Int32Array(planned.length).fill(NO_LIVE_VECTOR_AT_POSITION)
  for (let i = 0; i < planned.length; i++) {
    const held = state.store.holdsOrdinal(planned[i]) ? planned[i] : state.store.getOrdinal(docIds[i])
    const entry = held === undefined ? undefined : state.store.entryForOrdinal(held)
    if (held === undefined || entry === undefined) continue
    vectors.set(entry.vector, i * dimension)
    ordinals[i] = held
  }
  return {
    payload: {
      v: VECTOR_FILE_PAYLOAD_VERSION,
      fieldName: state.fieldName,
      dimension,
      docIds,
      codes: partCodes(state, docIds, centroid),
      vectors: vectorsToBytes(vectors),
    },
    ordinals,
  }
}

export function planCheckpoint(state: VectorIndexState, listedKeys: readonly string[] | null): VectorCheckpointPlan {
  const signature = signatureOf(state)
  const calibration = signature.calibration
  const trusted = registryMatches(state, listedKeys)

  const liveCounts: number[] = []
  const keptFiles = filesWorthKeeping(state, trusted ? state.savedFiles : [], calibration, liveCounts)
  absorbSmallerPartialFiles(keptFiles, liveCounts, countOutside(state, liveCounts))
  const written = ordinalsOutsideOf(state, keptFiles)
  const writtenDocIds = written.map(ordinal => state.store.docIdForOrdinal(ordinal) ?? '')
  const centroid = codedCentroid(state)
  const listedBefore = trusted && listedKeys !== null
  const unchanged = listedBefore && sameSignature(state.savedSignature, signature) && written.length === 0

  return {
    unchanged,
    keptFiles,
    kept: keptFiles.map(file => ({
      id: file.id,
      key: file.key,
      count: file.ordinals.length,
      dead: deadBitsOf(state, file),
    })),
    newFiles: Math.ceil(written.length / VECTOR_FILE_MAX_VECTORS),
    graph: unchanged ? null : graphOf(state, numberEveryVector(state, keptFiles, written)),
    signature,
    readNewFile(index: number): NewVectorFile {
      const start = index * VECTOR_FILE_MAX_VECTORS
      const end = start + VECTOR_FILE_MAX_VECTORS
      return readFile(state, written.slice(start, end), writtenDocIds.slice(start, end), centroid)
    },
  }
}

export interface WrittenVectorFile {
  id: number
  key: string
  ordinals: Int32Array
}

export function recordCheckpoint(
  state: VectorIndexState,
  plan: VectorCheckpointPlan,
  written: readonly WrittenVectorFile[],
): void {
  if (plan.unchanged) return
  const calibration = plan.signature.calibration
  state.savedFiles = [...plan.keptFiles, ...written.map(file => ({ ...file, calibration }))]
  state.savedSignature = plan.signature
}
