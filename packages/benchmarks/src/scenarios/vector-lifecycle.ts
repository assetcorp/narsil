import { createNarsil, type Narsil } from '@delali/narsil'
import { type AnyOrama, create, insertMultiple, searchVector } from '@orama/orama'
import { generateQueryVectors, generateVectorDocumentBatch } from '../data'
import { fmt, median, percentile } from '../stats'
import type { ComparisonRow, ScenarioResult, TimeSeriesPoint } from '../types'

const DIMENSION = 1536
const TOTAL_VECTORS = 2_000
const BATCH_SIZE = 100
const BATCH_COUNT = TOTAL_VECTORS / BATCH_SIZE
const QUERIES_PER_BATCH = 20
const PROMOTION_THRESHOLD = 1_000
const VECTOR_K = 10
const SEED = 42

export async function runVectorLifecycle(): Promise<ScenarioResult> {
  const start = performance.now()
  const queryVectors = generateQueryVectors(QUERIES_PER_BATCH, DIMENSION, SEED + 5)
  const timeSeries: TimeSeriesPoint[] = []
  const comparisons: ComparisonRow[] = []

  let instance: Narsil | undefined
  try {
    instance = await createNarsil()
    await instance.createIndex('bench', {
      schema: {
        title: 'string' as const,
        embedding: `vector[${DIMENSION}]` as const,
      },
      language: 'english',
      trackPositions: false,
      vectorPromotion: {
        threshold: PROMOTION_THRESHOLD,
        hnswConfig: { m: 16, efConstruction: 200 },
      },
    })

    for (let batch = 0; batch < BATCH_COUNT; batch++) {
      const offset = batch * BATCH_SIZE
      const docs = generateVectorDocumentBatch(BATCH_SIZE, DIMENSION, SEED + batch + 10, offset)
      const insertDocs = docs.map(({ id, ...rest }) => rest)

      await instance.insertBatch('bench', insertDocs, { skipClone: true })

      const checkpoint = offset + BATCH_SIZE
      const times: number[] = []
      for (const qv of queryVectors) {
        const searchStart = performance.now()
        await instance.query('bench', {
          vector: { field: 'embedding', value: qv, metric: 'cosine' },
          limit: VECTOR_K,
        })
        times.push(performance.now() - searchStart)
      }

      const medianMs = median(times)
      const p95Ms = percentile(times, 95)

      const stats = instance.getPartitionStats('bench')
      let label: string
      if (checkpoint < PROMOTION_THRESHOLD) {
        label = 'brute-force'
      } else if (stats.some(s => s.isHnswPromoted)) {
        label = 'hnsw-active'
      } else {
        label = 'hnsw-building'
      }

      console.log(
        `  ${fmt(checkpoint)} vectors [${label}]: ` +
          `search ${medianMs.toFixed(3)}ms median, ${p95Ms.toFixed(3)}ms p95`,
      )

      timeSeries.push({
        checkpoint,
        label,
        searchMedianMs: Number(medianMs.toFixed(3)),
        searchP95Ms: Number(p95Ms.toFixed(3)),
      })
    }
  } finally {
    if (instance) await instance.shutdown()
  }

  console.log('  measuring orama vector search at same scale...')
  const oramaDb = create({
    schema: { title: 'string' as const, embedding: `vector[${DIMENSION}]` as const },
    language: 'english',
  })
  const allVecDocs = []
  for (let batch = 0; batch < BATCH_COUNT; batch++) {
    const docs = generateVectorDocumentBatch(BATCH_SIZE, DIMENSION, SEED + batch + 10, batch * BATCH_SIZE)
    allVecDocs.push(...docs.map(({ id, ...rest }) => rest))
  }
  await insertMultiple(oramaDb, allVecDocs)

  const oramaTimes: number[] = []
  for (const qv of queryVectors) {
    const s = performance.now()
    await searchVector(oramaDb, {
      mode: 'vector',
      vector: { value: qv, property: 'embedding' },
      similarity: 0,
      limit: VECTOR_K,
    })
    oramaTimes.push(performance.now() - s)
  }
  const oramaMedian = median(oramaTimes)
  const oramaP95 = percentile(oramaTimes, 95)

  console.log(
    `  orama at ${fmt(TOTAL_VECTORS)} vectors: ` +
      `search ${oramaMedian.toFixed(3)}ms median, ${oramaP95.toFixed(3)}ms p95`,
  )

  comparisons.push({
    label: `orama-${fmt(TOTAL_VECTORS)}-vectors`,
    metrics: {
      searchMedianMs: Number(oramaMedian.toFixed(3)),
      searchP95Ms: Number(oramaP95.toFixed(3)),
    },
  })

  return {
    name: 'vector-lifecycle',
    description: `Vector search latency (${DIMENSION}-dim) across brute-force -> HNSW phases, vs Orama`,
    config: {
      dimension: DIMENSION,
      totalVectors: TOTAL_VECTORS,
      batchSize: BATCH_SIZE,
      promotionThreshold: PROMOTION_THRESHOLD,
      queriesPerBatch: QUERIES_PER_BATCH,
      efConstruction: 200,
    },
    timeSeries,
    comparisons,
    durationMs: performance.now() - start,
  }
}
