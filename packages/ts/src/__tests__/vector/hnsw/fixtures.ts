import type { HNSWIndex } from '../../../vector/hnsw'
import { magnitude } from '../../../vector/similarity'
import type { VectorStore } from '../../../vector/vector-store'

export const DIM = 8

export function randomVector(dim: number): Float32Array {
  const v = new Float32Array(dim)
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1
  }
  return v
}

export function normalizedVector(dim: number): Float32Array {
  const v = randomVector(dim)
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
