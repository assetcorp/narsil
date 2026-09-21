import { ErrorCodes, NarsilError } from '../../errors'
import { createHNSWIndex, type SerializedHNSWGraph } from '../hnsw'
import { type OsqQuantizer, osqBitsOf } from '../osq'
import {
  bytesToVectors,
  VECTOR_INDEX_PART_VECTORS,
  VECTOR_INDEX_PAYLOAD_VERSION,
  type VectorIndexCodes,
  type VectorIndexPayload,
  vectorsToBytes,
} from './payload'
import { adoptGraph, emptyFieldBeforeRestore, recalibrateFromStore, type VectorIndexState } from './shared'

function liveDocIds(state: VectorIndexState): string[] {
  const docIds: string[] = []
  for (let ordinal = 0; ordinal < state.store.slots; ordinal++) {
    const docId = state.store.docIdForOrdinal(ordinal)
    if (docId === undefined || state.tombstones.has(docId)) continue
    docIds.push(docId)
  }
  return docIds
}

function partVectors(state: VectorIndexState, docIds: readonly string[]): Float32Array {
  const dimension = state.dimension
  const vectors = new Float32Array(docIds.length * dimension)
  for (let i = 0; i < docIds.length; i++) {
    const entry = state.store.get(docIds[i])
    if (entry !== undefined) vectors.set(entry.vector, i * dimension)
  }
  return vectors
}

function graphsPerPart(state: VectorIndexState, partOf: Map<string, number>, parts: number): SerializedHNSWGraph[][] {
  const sliced: SerializedHNSWGraph[][] = Array.from({ length: parts }, () => [])
  if (state.hnsw === null || partOf.size === 0) return sliced
  const graph = state.hnsw.serialize()
  const nodesPerPart: SerializedHNSWGraph['nodes'][] = Array.from({ length: parts }, () => [])
  for (const node of graph.nodes) {
    const part = partOf.get(node[0])
    if (part !== undefined) nodesPerPart[part].push(node)
  }
  for (let part = 0; part < parts; part++) sliced[part].push({ ...graph, nodes: nodesPerPart[part] })
  return sliced
}

function recordFor(state: VectorIndexState, quantizer: OsqQuantizer, docId: string): Uint8Array | undefined {
  const record = quantizer.recordOf(docId)
  if (record !== undefined) return record
  if (!state.store.has(docId)) return undefined
  quantizer.quantize(docId)
  return quantizer.recordOf(docId)
}

export function codedCentroid(state: VectorIndexState): number[] | null {
  const centroid = state.osq?.centroid ?? null
  if (centroid === null || state.store.handles.codeLayout === null || state.hnsw === null) return null
  return Array.from(centroid)
}

function sameCentroid(state: VectorIndexState, planned: readonly number[]): boolean {
  const current = state.osq?.centroid ?? null
  if (current === null || current.length !== planned.length) return false
  for (let i = 0; i < planned.length; i++) {
    if (current[i] !== planned[i]) return false
  }
  return true
}

export function partCodes(
  state: VectorIndexState,
  docIds: readonly string[],
  centroid: number[] | null,
): VectorIndexCodes | null {
  const quantizer = state.osq
  const layout = state.store.handles.codeLayout
  if (centroid === null || quantizer === null || layout === null) return null
  if (!sameCentroid(state, centroid)) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The vector field "${state.fieldName}" was recalibrated while a save was writing its vectors`,
      { fieldName: state.fieldName },
    )
  }
  const records = new Uint8Array(docIds.length * layout.slotStride)
  for (let i = 0; i < docIds.length; i++) {
    const record = recordFor(state, quantizer, docIds[i])
    if (record !== undefined) records.set(record, i * layout.slotStride)
  }
  return { bits: quantizer.bits, centroid, records }
}

interface VectorIndexPartsPlan {
  readonly parts: number
  readPart(part: number): VectorIndexPayload
}

function planParts(state: VectorIndexState): VectorIndexPartsPlan {
  const docIds = liveDocIds(state)
  const parts = Math.max(1, Math.ceil(docIds.length / VECTOR_INDEX_PART_VECTORS))
  const partOf = new Map<string, number>()
  for (let i = 0; i < docIds.length; i++) partOf.set(docIds[i], Math.floor(i / VECTOR_INDEX_PART_VECTORS))
  const graphs = graphsPerPart(state, partOf, parts)
  const centroid = codedCentroid(state)

  return {
    parts,
    readPart(part: number): VectorIndexPayload {
      const start = part * VECTOR_INDEX_PART_VECTORS
      const slice = docIds.slice(start, start + VECTOR_INDEX_PART_VECTORS)
      return {
        v: VECTOR_INDEX_PAYLOAD_VERSION,
        fieldName: state.fieldName,
        dimension: state.dimension,
        part,
        parts,
        docIds: slice,
        graphs: graphs[part],
        codes: partCodes(state, slice, centroid),
        vectors: vectorsToBytes(partVectors(state, slice)),
      }
    },
  }
}

export function serialize(state: VectorIndexState): VectorIndexPayload[] {
  const plan = planParts(state)
  return Array.from({ length: plan.parts }, (_, part) => plan.readPart(part))
}

interface Sequence {
  docIds: string[]
  graphs: SerializedHNSWGraph[]
  codes: VectorIndexCodes | null
  codesComplete: boolean
}

function splitSequences(parts: VectorIndexPayload[]): Sequence[] {
  const sequences: Sequence[] = []
  let current: Sequence | null = null
  for (const part of parts) {
    if (current === null || part.part === 0) {
      current = { docIds: [], graphs: [], codes: null, codesComplete: true }
      sequences.push(current)
    }
    current.docIds.push(...part.docIds)
    for (let index = 0; index < part.graphs.length; index++) {
      const graph = part.graphs[index]
      const held = current.graphs[index]
      if (held === undefined) current.graphs[index] = { ...graph, nodes: [...graph.nodes] }
      else held.nodes.push(...graph.nodes)
    }
    if (part.codes === null) {
      if (part.docIds.length > 0) current.codesComplete = false
      continue
    }
    if (current.codes === null) {
      current.codes = { bits: part.codes.bits, centroid: part.codes.centroid, records: part.codes.records }
      continue
    }
    if (current.codes.bits !== part.codes.bits) {
      current.codesComplete = false
      continue
    }
    const joined = new Uint8Array(current.codes.records.length + part.codes.records.length)
    joined.set(current.codes.records, 0)
    joined.set(part.codes.records, current.codes.records.length)
    current.codes = { ...current.codes, records: joined }
  }
  return sequences
}

function restoreCodes(state: VectorIndexState, sequences: Sequence[]): void {
  const quantizer = state.osq
  const layout = state.store.handles.codeLayout
  if (quantizer === null || layout === null) return
  const usable = sequences.filter(sequence => sequence.docIds.length > 0)
  const single = usable.length === 1 ? usable[0] : null
  if (single === null || single.codes === null || !single.codesComplete || single.codes.bits !== quantizer.bits) {
    recalibrateFromStore(state)
    return
  }
  quantizer.restoreCentroid(Float32Array.from(single.codes.centroid))
  const recordBytes = layout.slotStride
  for (let i = 0; i < single.docIds.length; i++) {
    quantizer.restoreRecord(single.docIds[i], single.codes.records.subarray(i * recordBytes, (i + 1) * recordBytes))
  }
}

function restoreGraphs(state: VectorIndexState, graphs: SerializedHNSWGraph[]): void {
  if (graphs.length === 0) {
    for (const [docId] of state.store.entries()) {
      if (!state.tombstones.has(docId)) state.buffer.add(docId)
    }
    return
  }
  const graphData = graphs[0]
  const restoredHnsw = createHNSWIndex(
    state.dimension,
    state.store,
    {
      m: graphData.m ?? state.hnswConfig?.m,
      efConstruction: graphData.efConstruction ?? state.hnswConfig?.efConstruction,
      metric: graphData.metric ?? state.hnswConfig?.metric,
    },
    state.osq ?? undefined,
  )
  restoredHnsw.deserialize(graphData)
  adoptGraph(state, restoredHnsw)

  for (let i = 1; i < graphs.length; i++) {
    for (const [nodeDocId] of graphs[i].nodes) {
      if (!restoredHnsw.has(nodeDocId) && state.store.has(nodeDocId)) restoredHnsw.insertNode(nodeDocId)
    }
  }

  for (const [docId] of state.store.entries()) {
    if (state.tombstones.has(docId)) continue
    if (!restoredHnsw.has(docId)) state.buffer.add(docId)
  }

  if (state.buffer.size > restoredHnsw.size) {
    adoptGraph(state, null)
    state.buffer.clear()
    for (const [docId] of state.store.entries()) {
      if (!state.tombstones.has(docId)) state.buffer.add(docId)
    }
  }
}

function insertPart(state: VectorIndexState, part: VectorIndexPayload): void {
  const dimension = state.dimension
  const vectors = bytesToVectors(part.vectors)
  for (let i = 0; i < part.docIds.length; i++) {
    state.store.insert(part.docIds[i], vectors.subarray(i * dimension, (i + 1) * dimension))
  }
}

export function deserialize(state: VectorIndexState, parts: VectorIndexPayload[]): void {
  for (const part of parts) {
    if (part.dimension !== state.dimension) {
      throw new NarsilError(
        ErrorCodes.VECTOR_DIMENSION_MISMATCH,
        `Payload dimension ${part.dimension} does not match index dimension ${state.dimension}`,
        { expected: state.dimension, received: part.dimension },
      )
    }
  }
  const sequences = splitSequences(parts)
  const graphs: SerializedHNSWGraph[] = []
  for (const sequence of sequences) {
    for (const graph of sequence.graphs) {
      if (graph.nodes.length > 0) graphs.push(graph)
    }
  }

  emptyFieldBeforeRestore(state)

  for (const part of parts) insertPart(state, part)

  if (state.osq !== null && osqBitsOf(state.quantizationMode) !== null && graphs.length > 0) {
    restoreCodes(state, sequences)
  }
  restoreGraphs(state, graphs)
}
