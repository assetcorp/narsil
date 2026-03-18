import { createNarsil, type Narsil } from '@delali/narsil'
import { create, insertMultiple, search } from '@orama/orama'
import { generateDocumentBatch, generateQueries } from '../data'
import { measureSearchBatch } from '../run-scenarios'
import { fmt, median, percentile } from '../stats'
import type { ComparisonRow, ScenarioResult, TimeSeriesPoint } from '../types'

const PRELOAD_DOCS = 10_000
const TICK_INSERT_SIZE = 100
const TICK_QUERY_COUNT = 10
const TARGET_PARTITIONS = 5
const SEED = 42

function delay(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

export async function runRebalanceUnderLoad(): Promise<ScenarioResult> {
  const start = performance.now()
  const queries = generateQueries(50, SEED + 1)
  const tickQueries = queries.slice(0, TICK_QUERY_COUNT)
  const timeSeries: TimeSeriesPoint[] = []
  const comparisons: ComparisonRow[] = []

  let instance: Narsil | undefined
  try {
    instance = await createNarsil()
    await instance.createIndex('bench', {
      schema: {
        title: 'string' as const,
        body: 'string' as const,
        score: 'number' as const,
        category: 'enum' as const,
      },
      language: 'english',
      trackPositions: false,
      partitions: { maxDocsPerPartition: 10_000, maxPartitions: 10 },
    })

    const preloadDocs = generateDocumentBatch(PRELOAD_DOCS, SEED, 0)
    const preloadInsert = preloadDocs.map(({ id, ...rest }) => rest)
    await instance.insertBatch('bench', preloadInsert, { skipClone: true })

    let tickIndex = 0
    let docOffset = PRELOAD_DOCS

    const recordTick = async (label: string, inst: Narsil) => {
      const batch = generateDocumentBatch(TICK_INSERT_SIZE, SEED + tickIndex + 100, docOffset)
      const insertDocs = batch.map(({ id, ...rest }) => rest)

      const insertStart = performance.now()
      await inst.insertBatch('bench', insertDocs, { skipClone: true })
      const insertMs = performance.now() - insertStart
      const throughput = Math.round(TICK_INSERT_SIZE / (insertMs / 1000))

      const { medianMs, p95Ms } = await measureSearchBatch(inst, 'bench', tickQueries)
      const stats = inst.getPartitionStats('bench')

      timeSeries.push({
        checkpoint: tickIndex,
        label,
        insertThroughput: throughput,
        searchMedianMs: Number(medianMs.toFixed(3)),
        searchP95Ms: Number(p95Ms.toFixed(3)),
        partitionCount: stats.length,
      })

      console.log(
        `  tick ${tickIndex} [${label}]: ` +
          `${fmt(throughput)} inserts/sec, ` +
          `search ${medianMs.toFixed(3)}ms median, ` +
          `${stats.length} partitions`,
      )

      docOffset += TICK_INSERT_SIZE
      tickIndex++
    }

    for (let i = 0; i < 3; i++) {
      await recordTick('baseline', instance)
      await delay()
    }

    let rebalanceDone = false
    const rebalancePromise = instance.rebalance('bench', TARGET_PARTITIONS).then(() => {
      rebalanceDone = true
    })

    while (!rebalanceDone) {
      await recordTick('during-rebalance', instance)
      await delay()
    }

    await rebalancePromise

    for (let i = 0; i < 5; i++) {
      await recordTick('recovery', instance)
      await delay()
    }

    for (let i = 0; i < 3; i++) {
      await recordTick('post-rebalance', instance)
      await delay()
    }
  } finally {
    if (instance) await instance.shutdown()
  }

  console.log('  measuring orama throughput at same scale for comparison...')
  const oramaDb = create({
    schema: { title: 'string' as const, body: 'string' as const, score: 'number' as const, category: 'enum' as const },
    language: 'english',
  })
  const oramaDocs = generateDocumentBatch(PRELOAD_DOCS, SEED, 0).map(({ id, ...rest }) => rest)
  await insertMultiple(oramaDb, oramaDocs)

  const oramaInsertBatch = generateDocumentBatch(TICK_INSERT_SIZE, SEED + 200, PRELOAD_DOCS).map(
    ({ id, ...rest }) => rest,
  )
  const oInsertStart = performance.now()
  await insertMultiple(oramaDb, oramaInsertBatch)
  const oInsertMs = performance.now() - oInsertStart
  const oramaThroughput = Math.round(TICK_INSERT_SIZE / (oInsertMs / 1000))

  const oramaSearchTimes: number[] = []
  for (const q of tickQueries) {
    const s = performance.now()
    await search(oramaDb, { term: q })
    oramaSearchTimes.push(performance.now() - s)
  }

  console.log(
    `  orama at 10K: ${fmt(oramaThroughput)} inserts/sec, ` + `search ${median(oramaSearchTimes).toFixed(3)}ms median`,
  )

  comparisons.push({
    label: 'orama-10k-baseline',
    metrics: {
      insertDocsPerSec: oramaThroughput,
      searchMedianMs: Number(median(oramaSearchTimes).toFixed(3)),
      searchP95Ms: Number(percentile(oramaSearchTimes, 95).toFixed(3)),
    },
  })

  return {
    name: 'rebalance-under-load',
    description: 'Throughput during partition rebalancing, vs Orama at same scale',
    config: {
      preloadDocs: PRELOAD_DOCS,
      tickInsertSize: TICK_INSERT_SIZE,
      tickQueryCount: TICK_QUERY_COUNT,
      targetPartitions: TARGET_PARTITIONS,
    },
    timeSeries,
    comparisons,
    durationMs: performance.now() - start,
  }
}
