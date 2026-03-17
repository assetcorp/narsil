import { createBruteForceVectorStore } from '../src/vector/brute-force'
import { createHNSWIndex } from '../src/vector/hnsw'

function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function generateVectors(count: number, dim: number, seed: number): Float32Array[] {
  const rand = mulberry32(seed)
  const vectors: Float32Array[] = []
  for (let i = 0; i < count; i++) {
    const v = new Float32Array(dim)
    for (let j = 0; j < dim; j++) v[j] = rand() * 2 - 1
    vectors.push(v)
  }
  return vectors
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const DIM = 384
const SCALE = 10_000
const K = 10
const QUERY_COUNT = 100

const vectors = generateVectors(SCALE, DIM, 42)
const queries = generateVectors(QUERY_COUNT, DIM, 999)

const bf = createBruteForceVectorStore(DIM)
for (let i = 0; i < SCALE; i++) bf.insert(`d${i}`, vectors[i])

const groundTruth = queries.map(q => bf.search(q, K, 'cosine', 0).map(r => r.docId))

const bfTimes: number[] = []
for (const q of queries) {
  const t = performance.now()
  bf.search(q, K, 'cosine', 0)
  bfTimes.push(performance.now() - t)
}
console.log(`BF search median: ${median(bfTimes).toFixed(3)}ms\n`)

for (const efCon of [16, 32, 64, 100, 200]) {
  const hnsw = createHNSWIndex(DIM, { m: 16, efConstruction: efCon, metric: 'cosine' })

  const t0 = performance.now()
  for (let i = 0; i < SCALE; i++) hnsw.insert(`d${i}`, vectors[i])
  const buildMs = performance.now() - t0

  for (const efSearch of [20, 50, 100]) {
    const hnswResults = queries.map(q => hnsw.search(q, K, 'cosine', 0, undefined, efSearch).map(r => r.docId))

    let overlap = 0
    let total = 0
    for (let i = 0; i < queries.length; i++) {
      const gt = new Set(groundTruth[i])
      for (const id of hnswResults[i]) {
        if (gt.has(id)) overlap++
      }
      total += gt.length
    }
    const recall = total > 0 ? overlap / total : 1

    const times: number[] = []
    for (const q of queries) {
      const t = performance.now()
      hnsw.search(q, K, 'cosine', 0, undefined, efSearch)
      times.push(performance.now() - t)
    }

    console.log(
      `efCon=${String(efCon).padStart(3)} efSearch=${String(efSearch).padStart(3)} | build: ${(buildMs / 1000).toFixed(1)}s (${(buildMs / SCALE).toFixed(2)}ms/vec) | search: ${median(times).toFixed(3)}ms | recall: ${(recall * 100).toFixed(1)}%`,
    )
  }
  hnsw.clear()
  console.log()
}
