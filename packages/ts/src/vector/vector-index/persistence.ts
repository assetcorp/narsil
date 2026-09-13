import { ErrorCodes, NarsilError } from '../../errors'
import { createHNSWIndex, type SerializedHNSWGraph } from '../hnsw'
import { osqBitsOf } from '../osq'
import { magnitude } from '../similarity'
import { readsFromDisk, type VectorPartFile } from './disk'
import {
  bytesToVectors,
  VECTOR_INDEX_PART_VECTORS,
  VECTOR_INDEX_PAYLOAD_VERSION,
  type VectorIndexCodes,
  type VectorIndexPayload,
  vectorsToBytes,
} from './payload'
import { adoptGraph, recalibrateFromStore, type VectorIndexState } from './shared'

interface LiveEntry {
  docId: string
  vector: Float32Array
}

function liveEntries(state: VectorIndexState): LiveEntry[] {
  const entries: LiveEntry[] = []
  for (const [docId, entry] of state.store.entries()) {
    if (state.tombstones.has(docId)) continue
    entries.push({ docId, vector: entry.vector })
  }
  return entries
}

function graphsPerPart(state: VectorIndexState, partOf: Map<string, number>, parts: number): SerializedHNSWGraph[][] {
  const sliced: SerializedHNSWGraph[][] = Array.from({ length: parts }, () => [])
  if (state.hnsw === null) return sliced
  const graph = state.hnsw.serialize()
  const nodesPerPart: SerializedHNSWGraph['nodes'][] = Array.from({ length: parts }, () => [])
  for (const node of graph.nodes) {
    const part = partOf.get(node[0])
    if (part !== undefined) nodesPerPart[part].push(node)
  }
  for (let part = 0; part < parts; part++) sliced[part].push({ ...graph, nodes: nodesPerPart[part] })
  return sliced
}

function codesFor(state: VectorIndexState, entries: LiveEntry[]): VectorIndexCodes | null {
  const quantizer = state.osq
  const centroid = quantizer?.centroid ?? null
  const layout = state.store.handles.codeLayout
  if (quantizer === null || centroid === null || layout === null || state.hnsw === null) return null
  const records = new Uint8Array(entries.length * layout.slotStride)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    let record = quantizer.recordOf(entry.docId)
    if (record === undefined) {
      quantizer.quantize(entry.docId, entry.vector)
      record = quantizer.recordOf(entry.docId)
    }
    if (record !== undefined) records.set(record, i * layout.slotStride)
  }
  return { bits: quantizer.bits, centroid: Array.from(centroid), records }
}

/**
 * Writes the field as the parts the envelope specification defines: at most
 * 65,536 live vectors per part in ordinal order, the graphs sliced to each
 * part's nodes, one code record per vector where the field holds a graph and
 * codes, and the vectors last.
 *
 * @internal
 */
export function serialize(state: VectorIndexState): VectorIndexPayload[] {
  const entries = liveEntries(state)
  const parts = Math.max(1, Math.ceil(entries.length / VECTOR_INDEX_PART_VECTORS))
  const partOf = new Map<string, number>()
  for (let i = 0; i < entries.length; i++) partOf.set(entries[i].docId, Math.floor(i / VECTOR_INDEX_PART_VECTORS))
  const graphs = graphsPerPart(state, partOf, parts)
  const codes = codesFor(state, entries)
  const dimension = state.dimension
  const recordBytes = state.store.handles.codeLayout?.slotStride ?? 0

  const payloads: VectorIndexPayload[] = []
  for (let part = 0; part < parts; part++) {
    const start = part * VECTOR_INDEX_PART_VECTORS
    const slice = entries.slice(start, start + VECTOR_INDEX_PART_VECTORS)
    const vectors = new Float32Array(slice.length * dimension)
    for (let i = 0; i < slice.length; i++) vectors.set(slice[i].vector, i * dimension)
    payloads.push({
      v: VECTOR_INDEX_PAYLOAD_VERSION,
      fieldName: state.fieldName,
      dimension,
      part,
      parts,
      docIds: slice.map(entry => entry.docId),
      graphs: graphs[part],
      codes:
        codes === null
          ? null
          : {
              bits: codes.bits,
              centroid: codes.centroid,
              records: codes.records.subarray(start * recordBytes, (start + slice.length) * recordBytes),
            },
      vectors: vectorsToBytes(vectors),
    })
  }
  return payloads
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

function insertPart(state: VectorIndexState, part: VectorIndexPayload, file: VectorPartFile | null): void {
  const dimension = state.dimension
  const vectors = bytesToVectors(part.vectors)
  const fileIndex = file === null ? null : state.store.addVectorFile(file.path)
  for (let i = 0; i < part.docIds.length; i++) {
    const vector = vectors.subarray(i * dimension, (i + 1) * dimension)
    if (file === null || fileIndex === null) {
      state.store.insert(part.docIds[i], vector)
      continue
    }
    const offset = file.vectorsOffset + i * dimension * 4
    state.store.insertCold(part.docIds[i], magnitude(vector), { fileIndex, offset })
  }
}

/**
 * Reads the field back from its parts. The parts may run several sequences
 * end to end, one per partition file, each starting at part zero. The
 * vectors of every sequence join one store, while the graphs of every
 * sequence join one list. The index restores the codes only where a single
 * sequence carries a complete set at the field's own bits, because two
 * sequences quantised against two centroids cannot share one, and it
 * recalibrates from the vectors otherwise. A field kept on disk points each
 * ordinal at the file its part came from where the caller names one file
 * per part, and it holds the vectors in memory otherwise.
 *
 * @internal
 */
export function deserialize(state: VectorIndexState, parts: VectorIndexPayload[], files?: VectorPartFile[]): void {
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
  for (const sequence of sequences) graphs.push(...sequence.graphs)
  const onDisk = readsFromDisk(state) && files !== undefined && files.length === parts.length

  state.store.clear()
  state.tombstones.clear()
  state.buffer.clear()
  adoptGraph(state, null)
  state.osq?.clear()

  for (let index = 0; index < parts.length; index++) {
    insertPart(state, parts[index], onDisk && files !== undefined ? files[index] : null)
  }

  if (state.osq !== null && osqBitsOf(state.quantizationMode) !== null && graphs.length > 0) {
    restoreCodes(state, sequences)
  }
  restoreGraphs(state, graphs)
}
