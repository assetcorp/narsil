import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import type { VectorQuantizationMode, VectorStorageMode } from '../../../types/schema'
import type { VectorMetric } from '../../../vector/brute-force'
import { setNativeSearchCoreEnabled } from '../../../vector/native/backend'
import { createVectorIndex, type VectorIndex } from '../../../vector/vector-index'

export const DIMENSION = 53
export const DOCUMENTS = 600
export const QUERIES = 60
export const WIDTHS: VectorQuantizationMode[] = ['none', 'osq8', 'osq4', 'osq2', 'osq1']
export const METRICS: VectorMetric[] = ['cosine', 'dotProduct', 'euclidean']

export const hostBinary =
  process.env.NARSIL_NATIVE_CORE_PATH ??
  fileURLToPath(
    new URL(`../../../../../native/npm/${process.platform}-${process.arch}/narsil-core.node`, import.meta.url),
  )
export const binaryBuilt = existsSync(hostBinary)

export function pointAtTheHostBinary(): () => void {
  const previousPath = process.env.NARSIL_NATIVE_CORE_PATH
  process.env.NARSIL_NATIVE_CORE_PATH = hostBinary
  return () => {
    if (previousPath === undefined) delete process.env.NARSIL_NATIVE_CORE_PATH
    else process.env.NARSIL_NATIVE_CORE_PATH = previousPath
  }
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

export function clusteredVectors(count: number, seed: number): Float32Array[] {
  const next = seededRandom(seed)
  const centres = Array.from({ length: 12 }, () => Float32Array.from({ length: DIMENSION }, () => next() * 2 - 1))
  return Array.from({ length: count }, () => {
    const centre = centres[Math.floor(next() * centres.length)]
    return Float32Array.from(centre, value => value + (next() - 0.5) * 0.6)
  })
}

export function docIdOf(position: number): string {
  return `doc-${String(position).padStart(4, '0')}`
}

export interface BuiltIndexOptions {
  quantization: VectorQuantizationMode
  metric: VectorMetric
  native: boolean
  storage?: VectorStorageMode
  threshold?: number
  documents?: number
}

export async function settleBuild(index: VectorIndex): Promise<void> {
  index.scheduleBuild()
  await new Promise(resolve => setTimeout(resolve, 0))
  await index.awaitPendingBuild()
}

export async function builtIndex(options: BuiltIndexOptions): Promise<VectorIndex> {
  setNativeSearchCoreEnabled(options.native)
  const random = seededRandom(20260918)
  const spy = vi.spyOn(Math, 'random').mockImplementation(random)
  const index = createVectorIndex(
    'embedding',
    DIMENSION,
    {
      threshold: options.threshold ?? 50,
      quantization: options.quantization,
      hnswConfig: { m: 8, efConstruction: 60, metric: options.metric },
    },
    { enabled: false },
    'documents',
    options.storage ?? 'memory',
  )
  const vectors = clusteredVectors(options.documents ?? DOCUMENTS, 7)
  for (let i = 0; i < vectors.length; i++) index.insert(docIdOf(i), vectors[i])
  await settleBuild(index)
  spy.mockRestore()
  return index
}

const BYTES_BEFORE_THE_VECTORS = 3

export async function moveVectorsToAFile(index: VectorIndex, directory: string, name: string): Promise<string> {
  const [part] = index.serialize()
  const path = join(directory, name)
  const bytes = new Uint8Array(BYTES_BEFORE_THE_VECTORS + part.vectors.byteLength)
  bytes.set(part.vectors, BYTES_BEFORE_THE_VECTORS)
  await writeFile(path, bytes)
  await index.adoptDiskLayout({ path, vectorsOffset: BYTES_BEFORE_THE_VECTORS, docIds: part.docIds })
  return path
}

export function searchAll(index: VectorIndex, metric: VectorMetric, native: boolean, oversample?: number) {
  setNativeSearchCoreEnabled(native)
  return clusteredVectors(QUERIES, 99).map(query =>
    index
      .search(query, 10, { metric, minSimilarity: Number.NEGATIVE_INFINITY, oversample })
      .map(hit => [hit.docId, hit.score]),
  )
}
