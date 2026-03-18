import { createNarsil, type Narsil } from '@delali/narsil'
import { create, insertMultiple, search } from '@orama/orama'
import MiniSearch from 'minisearch'
import { stemmer } from 'stemmer'
import { generateDocumentBatch, generateQueries } from '../data'
import { fmt, median, percentile } from '../stats'
import type { BenchDocument, ComparisonRow, ScenarioResult, TimeSeriesPoint } from '../types'

const BATCH_SIZE = 5_000
const TOTAL_DOCS = 100_000
const QUERIES_PER_CHECKPOINT = 20
const SEED = 42
const CHECKPOINT_THRESHOLDS = [25_000, 50_000, 100_000]

function measureSearchTimes(searchFn: (q: string) => void, queries: string[]): number[] {
  const times: number[] = []
  for (const q of queries) {
    const s = performance.now()
    searchFn(q)
    times.push(performance.now() - s)
  }
  return times
}

async function measureSearchTimesAsync(searchFn: (q: string) => Promise<void>, queries: string[]): Promise<number[]> {
  const times: number[] = []
  for (const q of queries) {
    const s = performance.now()
    await searchFn(q)
    times.push(performance.now() - s)
  }
  return times
}

async function runNarsilIncremental(): Promise<{
  timeSeries: TimeSeriesPoint[]
  checkpointSnapshots: Map<number, { throughput: number; searchMedianMs: number; searchP95Ms: number }>
}> {
  const timeSeries: TimeSeriesPoint[] = []
  const checkpointSnapshots = new Map<number, { throughput: number; searchMedianMs: number; searchP95Ms: number }>()
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
    })

    let totalInserted = 0
    const totalBatches = TOTAL_DOCS / BATCH_SIZE

    for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
      const batch = generateDocumentBatch(BATCH_SIZE, SEED + batchIdx, totalInserted)
      const insertDocs = batch.map(({ id, ...rest }) => rest)

      const insertStart = performance.now()
      await instance.insertBatch('bench', insertDocs, { skipClone: true })
      const insertMs = performance.now() - insertStart
      const throughput = Math.round(BATCH_SIZE / (insertMs / 1000))

      totalInserted += BATCH_SIZE

      const batchQueries = generateQueries(QUERIES_PER_CHECKPOINT, SEED + 1000 + batchIdx)
      const searchTimes = await measureSearchTimesAsync(async q => {
        await instance?.query('bench', { term: q })
      }, batchQueries)
      const searchMed = median(searchTimes)
      const searchP95 = percentile(searchTimes, 95)

      timeSeries.push({
        checkpoint: totalInserted,
        label: 'narsil',
        insertThroughput: throughput,
        searchMedianMs: Number(searchMed.toFixed(3)),
        searchP95Ms: Number(searchP95.toFixed(3)),
      })

      if (CHECKPOINT_THRESHOLDS.includes(totalInserted)) {
        checkpointSnapshots.set(totalInserted, {
          throughput,
          searchMedianMs: Number(searchMed.toFixed(3)),
          searchP95Ms: Number(searchP95.toFixed(3)),
        })
      }

      console.log(
        `  narsil @ ${fmt(totalInserted)}: ${fmt(throughput)} docs/sec, ` + `search ${searchMed.toFixed(3)}ms median`,
      )
    }
  } finally {
    if (instance) await instance.shutdown()
  }

  return { timeSeries, checkpointSnapshots }
}

async function runOramaIncremental(): Promise<
  Map<number, { throughput: number; searchMedianMs: number; searchP95Ms: number }>
> {
  const checkpointSnapshots = new Map<number, { throughput: number; searchMedianMs: number; searchP95Ms: number }>()

  const db = create({
    schema: {
      title: 'string' as const,
      body: 'string' as const,
      score: 'number' as const,
      category: 'enum' as const,
    },
    language: 'english',
  })

  let totalInserted = 0
  const totalBatches = TOTAL_DOCS / BATCH_SIZE

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = generateDocumentBatch(BATCH_SIZE, SEED + batchIdx, totalInserted)
    const insertDocs = batch.map(({ id, ...rest }) => rest)

    const insertStart = performance.now()
    await insertMultiple(db, insertDocs)
    const insertMs = performance.now() - insertStart
    const throughput = Math.round(BATCH_SIZE / (insertMs / 1000))

    totalInserted += BATCH_SIZE

    if (CHECKPOINT_THRESHOLDS.includes(totalInserted)) {
      const batchQueries = generateQueries(QUERIES_PER_CHECKPOINT, SEED + 1000 + batchIdx)
      const searchTimes = await measureSearchTimesAsync(async q => {
        await search(db, { term: q })
      }, batchQueries)
      const searchMed = median(searchTimes)
      const searchP95 = percentile(searchTimes, 95)

      checkpointSnapshots.set(totalInserted, {
        throughput,
        searchMedianMs: Number(searchMed.toFixed(3)),
        searchP95Ms: Number(searchP95.toFixed(3)),
      })

      console.log(
        `  orama @ ${fmt(totalInserted)}: ${fmt(throughput)} docs/sec, ` + `search ${searchMed.toFixed(3)}ms median`,
      )
    }
  }

  return checkpointSnapshots
}

function runMiniSearchIncremental(): Map<number, { throughput: number; searchMedianMs: number; searchP95Ms: number }> {
  const checkpointSnapshots = new Map<number, { throughput: number; searchMedianMs: number; searchP95Ms: number }>()

  const ms = new MiniSearch<BenchDocument>({
    fields: ['title', 'body'],
    storeFields: ['title', 'body', 'score', 'category'],
    idField: 'id',
    processTerm: (term: string) => stemmer(term.toLowerCase()),
  })

  let totalInserted = 0
  const totalBatches = TOTAL_DOCS / BATCH_SIZE

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = generateDocumentBatch(BATCH_SIZE, SEED + batchIdx, totalInserted)

    const insertStart = performance.now()
    ms.addAll(batch)
    const insertMs = performance.now() - insertStart
    const throughput = Math.round(BATCH_SIZE / (insertMs / 1000))

    totalInserted += BATCH_SIZE

    if (CHECKPOINT_THRESHOLDS.includes(totalInserted)) {
      const batchQueries = generateQueries(QUERIES_PER_CHECKPOINT, SEED + 1000 + batchIdx)
      const searchTimes = measureSearchTimes(q => {
        ms.search(q)
      }, batchQueries)
      const searchMed = median(searchTimes)
      const searchP95 = percentile(searchTimes, 95)

      checkpointSnapshots.set(totalInserted, {
        throughput,
        searchMedianMs: Number(searchMed.toFixed(3)),
        searchP95Ms: Number(searchP95.toFixed(3)),
      })

      console.log(
        `  minisearch @ ${fmt(totalInserted)}: ${fmt(throughput)} docs/sec, ` +
          `search ${searchMed.toFixed(3)}ms median`,
      )
    }
  }

  return checkpointSnapshots
}

export async function runIncrementalInsert(): Promise<ScenarioResult> {
  const start = performance.now()
  const comparisons: ComparisonRow[] = []

  console.log('  running narsil incremental insert...')
  const narsil = await runNarsilIncremental()

  console.log('  running orama incremental insert...')
  const oramaSnapshots = await runOramaIncremental()

  console.log('  running minisearch incremental insert...')
  const miniSnapshots = runMiniSearchIncremental()

  for (const threshold of CHECKPOINT_THRESHOLDS) {
    const narsilSnap = narsil.checkpointSnapshots.get(threshold)
    const oramaSnap = oramaSnapshots.get(threshold)
    const miniSnap = miniSnapshots.get(threshold)

    if (narsilSnap) {
      comparisons.push({
        label: `narsil-${fmt(threshold)}`,
        metrics: {
          docsPerSec: narsilSnap.throughput,
          searchMedianMs: narsilSnap.searchMedianMs,
          searchP95Ms: narsilSnap.searchP95Ms,
        },
      })
    }

    if (oramaSnap) {
      comparisons.push({
        label: `orama-${fmt(threshold)}`,
        metrics: {
          docsPerSec: oramaSnap.throughput,
          searchMedianMs: oramaSnap.searchMedianMs,
          searchP95Ms: oramaSnap.searchP95Ms,
        },
      })
    }

    if (miniSnap) {
      comparisons.push({
        label: `minisearch-${fmt(threshold)}`,
        metrics: {
          docsPerSec: miniSnap.throughput,
          searchMedianMs: miniSnap.searchMedianMs,
          searchP95Ms: miniSnap.searchP95Ms,
        },
      })
    }
  }

  return {
    name: 'incremental-insert',
    description:
      'Insert throughput and search latency degradation as index grows from 0 to 100K across Narsil, Orama, and MiniSearch',
    config: {
      batchSize: BATCH_SIZE,
      totalDocs: TOTAL_DOCS,
      queriesPerCheckpoint: QUERIES_PER_CHECKPOINT,
      checkpointThresholds: CHECKPOINT_THRESHOLDS,
    },
    timeSeries: narsil.timeSeries,
    comparisons,
    durationMs: performance.now() - start,
  }
}
