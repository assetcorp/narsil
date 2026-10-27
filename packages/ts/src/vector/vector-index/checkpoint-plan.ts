import { MAX_DOC_ID_LENGTH } from '../../engine/constants'
import { MAX_FILE_BYTES } from '../../serialization/constants'
import { graphWithoutNodes } from '../hnsw/numbered-graph'
import { osqBitsOf } from '../osq'
import { osqRecordBytes } from '../osq/record'
import { STORE_CALIBRATION_GENERATION } from '../vector-store/handles'
import {
  VECTOR_FILE_MAX_VECTORS,
  VECTOR_FILE_PAYLOAD_VERSION,
  VECTOR_GRAPH_PART_PAYLOAD_VERSION,
  VECTOR_GRAPH_PART_VECTORS,
  type VectorFilePayload,
  type VectorGraphPartPayload,
} from './checkpoint-payload'
import {
  VECTOR_FILE_CENTROID_BYTES_PER_COMPONENT,
  VECTOR_FILE_FIXED_OVERHEAD_BYTES,
  VECTOR_FILE_REPLACED_ABOVE_DEAD_SHARE,
  VECTOR_FILE_STRING_HEADER_BYTES,
} from './constants'
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
  dead: Uint8Array | null
}

export interface VectorCheckpointPlan {
  readonly unchanged: boolean
  readonly kept: readonly KeptVectorFile[]
  readonly keptFiles: readonly SavedVectorFile[]
  readonly newFiles: number
  readonly graphParts: readonly VectorGraphPartPayload[] | null
  readonly signature: FieldSignature
  readNewFile(index: number): NewVectorFile
}

export function vectorsPerFile(dimension: number, codeBits: number | null): number {
  const recordBytes =
    codeBits === 1 || codeBits === 2 || codeBits === 4 || codeBits === 8 ? osqRecordBytes(dimension, codeBits) : 0
  const docIdBytes = VECTOR_FILE_STRING_HEADER_BYTES + MAX_DOC_ID_LENGTH * 3
  const perVector = dimension * 4 + recordBytes + docIdBytes
  const overhead = VECTOR_FILE_FIXED_OVERHEAD_BYTES + dimension * VECTOR_FILE_CENTROID_BYTES_PER_COMPONENT
  const fitting = Math.floor((MAX_FILE_BYTES - overhead) / perVector)
  return Math.max(1, Math.min(VECTOR_FILE_MAX_VECTORS, fitting))
}

function fileCapacityOf(state: VectorIndexState): number {
  return vectorsPerFile(state.dimension, osqBitsOf(state.quantizationMode))
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

function isGraphTombstone(state: VectorIndexState, ordinal: number): boolean {
  return ordinal !== NO_LIVE_VECTOR_AT_POSITION && state.hnsw !== null && state.hnsw.holdsTombstone(ordinal)
}

function isCarried(state: VectorIndexState, ordinal: number): boolean {
  return isLive(state, ordinal) || isGraphTombstone(state, ordinal)
}

function carriedCountOf(state: VectorIndexState, file: SavedVectorFile): number {
  let carried = 0
  for (let i = 0; i < file.ordinals.length; i++) if (isCarried(state, file.ordinals[i])) carried += 1
  return carried
}

function deadBitsOf(state: VectorIndexState, file: SavedVectorFile): Uint8Array | null {
  return deadBitsWhere(file.ordinals.length, position => !isLive(state, file.ordinals[position]))
}

function filesWorthKeeping(
  state: VectorIndexState,
  listed: readonly SavedVectorFile[],
  calibration: number | null,
  carriedCounts: number[],
): SavedVectorFile[] {
  const kept: SavedVectorFile[] = []
  for (const file of listed) {
    const carried = carriedCountOf(state, file)
    const deadWithoutNodeShare = file.ordinals.length === 0 ? 1 : 1 - carried / file.ordinals.length
    if (file.calibration !== calibration || deadWithoutNodeShare > VECTOR_FILE_REPLACED_ABOVE_DEAD_SHARE) continue
    kept.push(file)
    carriedCounts.push(carried)
  }
  return kept
}

function absorbSmallerPartialFiles(
  kept: SavedVectorFile[],
  carriedCounts: number[],
  vectorsToWrite: number,
  capacity: number,
): void {
  let pending = vectorsToWrite
  for (let index = kept.length - 1; index >= 0 && pending > 0; index--) {
    if (kept[index].ordinals.length >= capacity) continue
    if (carriedCounts[index] > pending) return
    pending += carriedCounts[index]
    kept.splice(index, 1)
    carriedCounts.splice(index, 1)
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
    if (saved[ordinal] === 0 && isCarried(state, ordinal)) outside.push(ordinal)
  }
  return outside
}

function countOutside(state: VectorIndexState, carriedCounts: readonly number[]): number {
  let held = 0
  for (const carried of carriedCounts) held += carried
  const tombstonedNodes = state.hnsw?.tombstoneCount ?? 0
  return Math.max(0, state.store.size - state.tombstones.size + tombstonedNodes - held)
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
      if (!isCarried(state, ordinal)) continue
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

function graphPartsOf(state: VectorIndexState, numbers: VectorNumbers): VectorGraphPartPayload[] | null {
  if (state.hnsw === null || numbers.ordinalOfNumber.length === 0) return null
  const parts = state.hnsw.serializeNumbered(
    numbers.numberOfOrdinal,
    numbers.ordinalOfNumber,
    VECTOR_GRAPH_PART_VECTORS,
  )
  const shuffledBuildCount = state.shuffledBuildCount
  return parts.map(graph => ({
    v: VECTOR_GRAPH_PART_PAYLOAD_VERSION,
    fieldName: state.fieldName,
    graphs: [shuffledBuildCount === null ? graph : { ...graph, shuffledBuildCount }],
  }))
}

function graphPartsWithoutNodes(
  parts: readonly VectorGraphPartPayload[],
  numbers: ReadonlySet<number>,
): VectorGraphPartPayload[] {
  return parts.map((part, index) => ({
    ...part,
    graphs: part.graphs.map(graph => graphWithoutNodes(graph, index * VECTOR_GRAPH_PART_VECTORS, numbers)),
  }))
}

interface PlannedVector {
  ordinal: number
  docId: string
  tombstoned: boolean
}

function plannedVectorOf(state: VectorIndexState, ordinal: number): PlannedVector {
  const docId = state.store.docIdForOrdinal(ordinal) ?? state.store.view.docIdAt(ordinal) ?? ''
  return { ordinal, docId, tombstoned: !isLive(state, ordinal) }
}

function readFile(
  state: VectorIndexState,
  planned: readonly PlannedVector[],
  centroid: number[] | null,
): NewVectorFile {
  const dimension = state.dimension
  const vectors = new Float32Array(planned.length * dimension)
  const ordinals = new Int32Array(planned.length).fill(NO_LIVE_VECTOR_AT_POSITION)
  const tombstonedAt = new Map<number, number>()
  const docIds = planned.map(vector => vector.docId)
  for (let i = 0; i < planned.length; i++) {
    const { ordinal, docId, tombstoned } = planned[i]
    const held = tombstoned || state.store.holdsOrdinal(ordinal) ? ordinal : state.store.getOrdinal(docId)
    const entry = held === undefined ? undefined : state.store.entryForOrdinal(held)
    if (held === undefined || entry === undefined) continue
    vectors.set(entry.vector, i * dimension)
    ordinals[i] = held
    if (tombstoned) tombstonedAt.set(i, held)
  }
  return {
    payload: {
      v: VECTOR_FILE_PAYLOAD_VERSION,
      fieldName: state.fieldName,
      dimension,
      docIds,
      codes: partCodes(state, docIds, centroid, tombstonedAt, vectors, ordinals),
      vectors: vectorsToBytes(vectors),
    },
    ordinals,
    dead: deadBitsWhere(planned.length, i => planned[i].tombstoned || ordinals[i] === NO_LIVE_VECTOR_AT_POSITION),
  }
}

export function planCheckpoint(
  state: VectorIndexState,
  listedKeys: readonly string[] | null,
  rewritesGraph = false,
): VectorCheckpointPlan {
  const signature = signatureOf(state)
  const calibration = signature.calibration
  const trusted = registryMatches(state, listedKeys)

  const capacity = fileCapacityOf(state)
  const carriedCounts: number[] = []
  const keptFiles = filesWorthKeeping(state, trusted ? state.savedFiles : [], calibration, carriedCounts)
  absorbSmallerPartialFiles(keptFiles, carriedCounts, countOutside(state, carriedCounts), capacity)
  const written = ordinalsOutsideOf(state, keptFiles)
  const planned = written.map(ordinal => plannedVectorOf(state, ordinal))
  const centroid = codedCentroid(state)
  const listedBefore = trusted && listedKeys !== null
  const unchanged =
    !rewritesGraph && listedBefore && sameSignature(state.savedSignature, signature) && written.length === 0
  let firstWrittenNumber = 0
  for (const file of keptFiles) firstWrittenNumber += file.ordinals.length
  const graphParts = unchanged ? null : graphPartsOf(state, numberEveryVector(state, keptFiles, written))
  const vanished = new Set<number>()
  let vanishedWhenStripped = 0
  let graphPartsToWrite = graphParts

  return {
    unchanged,
    keptFiles,
    kept: keptFiles.map(file => ({
      id: file.id,
      key: file.key,
      count: file.ordinals.length,
      dead: deadBitsOf(state, file),
    })),
    newFiles: Math.ceil(written.length / capacity),
    get graphParts() {
      if (graphParts !== null && vanished.size !== vanishedWhenStripped) {
        graphPartsToWrite = graphPartsWithoutNodes(graphParts, vanished)
        vanishedWhenStripped = vanished.size
      }
      return graphPartsToWrite
    },
    signature,
    readNewFile(index: number): NewVectorFile {
      const start = index * capacity
      const end = start + capacity
      const file = readFile(state, planned.slice(start, end), centroid)
      for (let i = 0; i < file.ordinals.length; i++) {
        if (file.ordinals[i] === NO_LIVE_VECTOR_AT_POSITION) vanished.add(firstWrittenNumber + start + i)
      }
      return file
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
