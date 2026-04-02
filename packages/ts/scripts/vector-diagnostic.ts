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

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]
}

function measureSearch(
  searchFn: (query: Float32Array) => Array<{ docId: string }>,
  queries: Float32Array[],
): { medianMs: number; p95Ms: number; resultIds: string[][] } {
  for (let i = 0; i < 10; i++) searchFn(queries[i % queries.length])

  const times: number[] = []
  const resultIds: string[][] = []
  for (const q of queries) {
    const start = performance.now()
    const results = searchFn(q)
    times.push(performance.now() - start)
    resultIds.push(results.map(r => r.docId))
  }
  return { medianMs: median(times), p95Ms: percentile(times, 95), resultIds }
}

function recall(truth: string[][], approx: string[][]): number {
  let overlap = 0
  let total = 0
  for (let i = 0; i < truth.length; i++) {
    const gt = new Set(truth[i])
    for (const id of approx[i]) {
      if (gt.has(id)) overlap++
    }
    total += gt.length
  }
  return total > 0 ? overlap / total : 1
}

const K = 10
const QUERY_COUNT = 100

interface Test {
  dim: number
  scales: number[]
}

const TESTS: Test[] = [
  { dim: 384, scales: [1_000, 5_000, 10_000, 50_000] },
  { dim: 768, scales: [1_000, 5_000, 10_000] },
  { dim: 1536, scales: [1_000, 5_000, 10_000] },
  { dim: 3072, scales: [1_000, 5_000] },
]

async function main() {
  console.log('=== Narsil Vector Diagnostic ===\n')
  console.log(`Node ${process.version} | SIMD: ${isSimdAvailable()} | GC: ${typeof globalThis.gc === 'function'}`)
  console.log(`K=${K} | Queries=${QUERY_COUNT}\n`)

  const allResults: Array<{
    dim: number
    scale: number
    bfInsertMs: number
    bfSearchMedian: number
    bfSearchP95: number
    hnswInsertMs: number
    hnswInsertPerVecMs: number
    hnswSearchMedian: number
    hnswSearchP95: number
    hnswRecall: number
    speedup: number
  }> = []

  for (const { dim, scales } of TESTS) {
    console.log(`\n${'='.repeat(50)}`)
    console.log(`  ${dim}-dim`)
    console.log(`${'='.repeat(50)}`)

    for (const scale of scales) {
      console.log(`\n  ${fmt(scale)} vectors:`)

      const vectors = generateVectors(scale, dim, 42)
      const queries = generateVectors(QUERY_COUNT, dim, 999)

      const bfStore = createVectorStore()
      let t0 = performance.now()
      for (let i = 0; i < scale; i++) bfStore.insert(`d${i}`, vectors[i])
      const bf = createBruteForceSearch(dim, bfStore)
      const bfInsertMs = performance.now() - t0

      const bfSearch = measureSearch(q => bf.search(q, K, 'cosine', 0), queries)
      console.log(
        `    BF  insert: ${bfInsertMs.toFixed(1)}ms | search: ${bfSearch.medianMs.toFixed(3)}ms median, ${bfSearch.p95Ms.toFixed(3)}ms p95`,
      )

      console.log(`    HNSW building...`)
      const hnswStore = createVectorStore()
      for (let i = 0; i < scale; i++) hnswStore.insert(`d${i}`, vectors[i])
      const hnsw = createHNSWIndex(dim, hnswStore, { m: 16, efConstruction: 200, metric: 'cosine' })

      t0 = performance.now()
      for (let i = 0; i < scale; i++) {
        hnsw.insertNode(`d${i}`)
        if ((i + 1) % 1000 === 0) {
          const elapsed = performance.now() - t0
          const perVec = elapsed / (i + 1)
          const remaining = perVec * (scale - i - 1)
          process.stdout.write(
            `\r    HNSW ${fmt(i + 1)}/${fmt(scale)} (${perVec.toFixed(2)}ms/vec, ~${(remaining / 1000).toFixed(0)}s remaining)`,
          )

          if (elapsed > 120_000) {
            console.log(`\n    HNSW ABORTED: exceeded 2 minutes at ${fmt(i + 1)} vectors`)
            hnsw.clear()
            bfStore.clear()
            break
          }
        }
      }
      const hnswInsertMs = performance.now() - t0

      if (hnsw.size === 0) {
        bfStore.clear()
        continue
      }

      const perVec = hnswInsertMs / scale
      console.log(
        `\r    HNSW insert: ${(hnswInsertMs / 1000).toFixed(2)}s total (${perVec.toFixed(2)}ms/vec)${' '.repeat(30)}`,
      )

      const hnswSearch = measureSearch(q => hnsw.search(q, K, 'cosine', 0, undefined, 50), queries)
      const r = recall(bfSearch.resultIds, hnswSearch.resultIds)
      const speedup = bfSearch.medianMs / hnswSearch.medianMs

      console.log(
        `    HNSW search (ef=50): ${hnswSearch.medianMs.toFixed(3)}ms median, ${hnswSearch.p95Ms.toFixed(3)}ms p95 | recall: ${(r * 100).toFixed(1)}% | ${speedup.toFixed(1)}x faster`,
      )

      allResults.push({
        dim,
        scale,
        bfInsertMs,
        bfSearchMedian: bfSearch.medianMs,
        bfSearchP95: bfSearch.p95Ms,
        hnswInsertMs,
        hnswInsertPerVecMs: perVec,
        hnswSearchMedian: hnswSearch.medianMs,
        hnswSearchP95: hnswSearch.p95Ms,
        hnswRecall: r,
        speedup,
      })

      bfStore.clear()
      hnsw.clear()
      if (typeof globalThis.gc === 'function') {
        globalThis.gc()
        globalThis.gc()
      }
    }
  }

  console.log('\n\n=== SUMMARY TABLE ===\n')
  console.log('| Dim | Scale | BF Insert | BF Search | HNSW Build | HNSW/vec | HNSW Search | Recall | Speedup |')
  console.log('|-----|-------|-----------|-----------|------------|----------|-------------|--------|---------|')
  for (const r of allResults) {
    console.log(
      `| ${r.dim} | ${fmt(r.scale)} | ${r.bfInsertMs.toFixed(0)}ms | ${r.bfSearchMedian.toFixed(3)}ms | ${(r.hnswInsertMs / 1000).toFixed(1)}s | ${r.hnswInsertPerVecMs.toFixed(2)}ms | ${r.hnswSearchMedian.toFixed(3)}ms | ${(r.hnswRecall * 100).toFixed(1)}% | ${r.speedup.toFixed(1)}x |`,
    )
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
