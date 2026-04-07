import { createBruteForceSearch } from '../src/vector/brute-force'
import { createHNSWIndex } from '../src/vector/hnsw'
import { isSimdAvailable } from '../src/vector/simd'
import { createVectorStore } from '../src/vector/vector-store'

function mulberry32(seed: number): () => number {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DIM = 384
const SCALE = 1000
const K = 10

console.log(`SIMD: ${isSimdAvailable()}`)
console.log(`Generating ${SCALE} vectors @ ${DIM}-dim...`)

const rand = mulberry32(42)
const vectors: Float32Array[] = []
for (let i = 0; i < SCALE; i++) {
  const v = new Float32Array(DIM)
  for (let j = 0; j < DIM; j++) v[j] = rand() * 2 - 1
  vectors.push(v)
}
console.log('Vectors generated.')

console.log('\n--- Brute Force ---')
const bfStore = createVectorStore()
let t0 = performance.now()
for (let i = 0; i < SCALE; i++) bfStore.insert(`doc-${i}`, vectors[i])
const bf = createBruteForceSearch(DIM, bfStore)
console.log(`Insert ${SCALE}: ${(performance.now() - t0).toFixed(1)}ms`)

const query = vectors[0]
t0 = performance.now()
const bfResults = bf.search(query, K, 'cosine', 0)
console.log(`Search: ${(performance.now() - t0).toFixed(3)}ms, returned ${bfResults.length} results`)

console.log('\n--- HNSW (m=16, efConstruction=200) ---')
const hnswStore = createVectorStore()
const hnsw = createHNSWIndex(DIM, hnswStore, { m: 16, efConstruction: 200, metric: 'cosine' })

t0 = performance.now()
for (let i = 0; i < 100; i++) {
  hnswStore.insert(`doc-${i}`, vectors[i])
  hnsw.insertNode(`doc-${i}`)
  if (i % 10 === 0) {
    const elapsed = performance.now() - t0
    console.log(`  Inserted ${i + 1}, elapsed: ${elapsed.toFixed(1)}ms`)
  }
}
console.log(`First 100 inserts: ${(performance.now() - t0).toFixed(1)}ms`)

t0 = performance.now()
for (let i = 100; i < SCALE; i++) {
  hnswStore.insert(`doc-${i}`, vectors[i])
  hnsw.insertNode(`doc-${i}`)
}
console.log(`Remaining ${SCALE - 100} inserts: ${(performance.now() - t0).toFixed(1)}ms`)
console.log(`Total HNSW size: ${hnsw.size}`)

t0 = performance.now()
const hnswResults = hnsw.search(query, K, 'cosine', 0, undefined, 50)
console.log(`Search (ef=50): ${(performance.now() - t0).toFixed(3)}ms, returned ${hnswResults.length} results`)

console.log('\nDone.')
