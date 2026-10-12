import type { HNSWIndex, SerializedHNSWGraph } from '../../../../vector/hnsw'
import { magnitude } from '../../../../vector/similarity'
import type { VectorStore } from '../../../../vector/vector-store'

export const DIM = 8

export function seededVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(seed * (i + 1) * 1.618) * Math.cos(seed * 0.7 + i)
  }
  return v
}

export function normalizedVector(dim: number, seed: number): Float32Array {
  const v = seededVector(dim, seed)
  const mag = magnitude(v)
  if (mag === 0) return v
  for (let i = 0; i < dim; i++) {
    v[i] /= mag
  }
  return v
}

export function vectorFromValues(...values: number[]): Float32Array {
  return new Float32Array(values)
}

export function insertVec(store: VectorStore, index: HNSWIndex, docId: string, vector: Float32Array): void {
  store.insert(docId, vector)
  index.insertNode(docId)
}

export function removeVec(store: VectorStore, index: HNSWIndex, docId: string): void {
  index.markTombstone(docId)
  store.remove(docId)
}

export function graphView(index: HNSWIndex, store: VectorStore): SerializedHNSWGraph {
  const slots = store.slots
  const identity = Int32Array.from({ length: slots }, (_, ordinal) => ordinal)
  const parts = index.serializeNumbered(identity, identity, Math.max(1, slots))
  const nodes: SerializedHNSWGraph['nodes'] = []
  let entryPoint: string | null = null
  for (const part of parts) {
    if (part.entryPoint !== null) entryPoint = store.docIdForOrdinal(part.entryPoint) ?? null
    const view = new DataView(part.neighbours.buffer, part.neighbours.byteOffset, part.neighbours.byteLength)
    let cursor = 0
    for (let ordinal = 0; ordinal < part.levels.length; ordinal++) {
      const layers = part.levels[ordinal]
      if (layers === 0) continue
      const layerConns: Array<[number, string[]]> = []
      for (let layer = 0; layer < layers; layer++) {
        const count = view.getUint32(cursor * 4, true)
        const neighbours: string[] = []
        for (let i = 1; i <= count; i++) {
          const neighbour = store.docIdForOrdinal(view.getUint32((cursor + i) * 4, true))
          if (neighbour !== undefined) neighbours.push(neighbour)
        }
        cursor += count + 1
        if (neighbours.length > 0) layerConns.push([layer, neighbours])
      }
      const docId = store.docIdForOrdinal(ordinal)
      if (docId !== undefined) nodes.push([docId, layers - 1, layerConns])
    }
  }
  const first = parts[0]
  return {
    entryPoint,
    maxLayer: index.topLayer,
    m: first?.m ?? index.m,
    efConstruction: first?.efConstruction ?? index.efConstruction,
    metric: first?.metric ?? index.metric,
    nodes,
  }
}
