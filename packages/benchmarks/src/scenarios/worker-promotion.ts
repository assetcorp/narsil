import { createNarsil, type Narsil } from '@delali/narsil'
import { type AnyOrama, create, insertMultiple, search } from '@orama/orama'
import { generateDocumentBatch, generateQueries } from '../data'
import { fmt, median, percentile } from '../stats'
import type { ComparisonRow, ScenarioResult, TimeSeriesPoint } from '../types'
import { measureSearchBatch } from '../run-scenarios'

const BATCH_SIZE = 1_000
const BATCH_COUNT = 20
const QUERIES_PER_BATCH = 50
const PROMOTION_THRESHOLD = 10_000
const SEED = 42

export async function runWorkerPromotion(): Promise<ScenarioResult> {
  const start = performance.now()
  const queries = generateQueries(QUERIES_PER_BATCH, SEED + 1)
  const timeSeries: TimeSeriesPoint[] = []
  const comparisons: ComparisonRow[] = []

  let promoted = false
  let instance: Narsil | undefined
  try {
    instance = await createNarsil({
      workers: { enabled: true, promotionThreshold: PROMOTION_THRESHOLD },
    })

    instance.on('workerPromote', () => {
      promoted = true
    })

    await instance.createIndex('bench', {
      schema: {
        title: 'string' as const,
        body: 'string' as const,
        score: 'number' as const,
        category: 'enum' as const,
      },
      language: 'english',
      trackPositions: false,
    })

    for (let batch = 0; batch < BATCH_COUNT; batch++) {
      const offset = batch * BATCH_SIZE
      const docs = generateDocumentBatch(BATCH_SIZE, SEED + batch + 10, offset)
      const insertDocs = docs.map(({ id, ...rest }) => rest)

      const insertStart = performance.now()
      await instance.insertBatch('bench', insertDocs, { skipClone: true })
      const insertMs = performance.now() - insertStart
      const throughput = Math.round(BATCH_SIZE / (insertMs / 1000))

      const { medianMs, p95Ms } = await measureSearchBatch(instance, 'bench', queries)
      const checkpoint = offset + BATCH_SIZE
      const label = promoted ? 'worker-executor' : 'direct-executor'

      console.log(
        `  ${fmt(checkpoint)} docs [${label}]: ` +
          `${fmt(throughput)} inserts/sec, ` +
          `search ${medianMs.toFixed(3)}ms median`,
      )

      timeSeries.push({
        checkpoint,
        label,
        insertThroughput: throughput,
        searchMedianMs: Number(medianMs.toFixed(3)),
        searchP95Ms: Number(p95Ms.toFixed(3)),
      })
    }
  } finally {
    if (instance) await instance.shutdown()
  }

  console.log('  measuring orama at same scale for comparison...')
  const oramaDb = create({
    schema: { title: 'string' as const, body: 'string' as const, score: 'number' as const, category: 'enum' as const },
    language: 'english',
  })
  const allDocs = []
  for (let batch = 0; batch < BATCH_COUNT; batch++) {
    const docs = generateDocumentBatch(BATCH_SIZE, SEED + batch + 10, batch * BATCH_SIZE)
    allDocs.push(...docs.map(({ id, ...rest }) => rest))
  }
  const oramaInsertStart = performance.now()
  await insertMultiple(oramaDb, allDocs)
  const oramaInsertMs = performance.now() - oramaInsertStart
  const oramaInsertThroughput = Math.round((BATCH_COUNT * BATCH_SIZE) / (oramaInsertMs / 1000))

  const oramaSearchTimes: number[] = []
  for (const q of queries) {
    const s = performance.now()
    await search(oramaDb, { term: q })
    oramaSearchTimes.push(performance.now() - s)
  }
  const oramaSearchMedian = median(oramaSearchTimes)
  const oramaSearchP95 = percentile(oramaSearchTimes, 95)

  console.log(
    `  orama at 20K: ${fmt(oramaInsertThroughput)} docs/sec, ` +
      `search ${oramaSearchMedian.toFixed(3)}ms median`,
  )

  comparisons.push({
    label: 'orama-20k-baseline',
    metrics: {
      insertDocsPerSec: oramaInsertThroughput,
      searchMedianMs: Number(oramaSearchMedian.toFixed(3)),
      searchP95Ms: Number(oramaSearchP95.toFixed(3)),
    },
  })

  return {
    name: 'worker-promotion',
    description: 'Latency curve across DirectExecutor -> WorkerExecutor boundary, vs Orama at same scale',
    config: {
      batchSize: BATCH_SIZE,
      batchCount: BATCH_COUNT,
      promotionThreshold: PROMOTION_THRESHOLD,
      queriesPerBatch: QUERIES_PER_BATCH,
    },
    timeSeries,
    comparisons,
    durationMs: performance.now() - start,
  }
}
