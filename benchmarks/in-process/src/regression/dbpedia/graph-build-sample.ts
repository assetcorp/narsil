import { readFileSync } from 'node:fs'
import { DBPEDIA_DIMENSIONS, type VectorRows } from './dataset'

export const GRAPH_BUILD_SAMPLE_SIZE = 1_000

interface StoredSample {
  ids: string[]
  texts: string[]
  vectors: string
}

export function encodeGraphBuildSample(documents: VectorRows): string {
  const count = Math.min(GRAPH_BUILD_SAMPLE_SIZE, documents.ids.length)
  const vectors = documents.vectors.subarray(0, count * DBPEDIA_DIMENSIONS)
  const sample: StoredSample = {
    ids: documents.ids.slice(0, count),
    texts: documents.texts.slice(0, count),
    vectors: Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength).toString('base64'),
  }
  return `${JSON.stringify(sample)}\n`
}

export function readGraphBuildSample(path: string): VectorRows {
  const sample = JSON.parse(readFileSync(path, 'utf-8')) as Partial<StoredSample>
  const { ids, texts, vectors } = sample
  if (!Array.isArray(ids) || !Array.isArray(texts) || typeof vectors !== 'string' || ids.length !== texts.length) {
    throw new Error(`${path} holds no graph build sample`)
  }
  const bytes = Buffer.from(vectors, 'base64')
  if (bytes.byteLength !== ids.length * DBPEDIA_DIMENSIONS * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`${path} holds ${bytes.byteLength} vector bytes for ${ids.length} documents`)
  }
  const copy = new Uint8Array(bytes)
  return {
    ids: ids.map(String),
    texts: texts.map(String),
    vectors: new Float32Array(copy.buffer, copy.byteOffset, ids.length * DBPEDIA_DIMENSIONS),
  }
}
