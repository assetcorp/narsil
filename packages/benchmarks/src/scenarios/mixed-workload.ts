import { createNarsil, type Narsil } from '@delali/narsil'
import { create, insertMultiple, search } from '@orama/orama'
import MiniSearch from 'minisearch'
import { stemmer } from 'stemmer'
import { generateDocumentBatch, generateDocuments, generateQueries } from '../data'
import { fmt, median, percentile } from '../stats'
import type { BenchDocument, ComparisonRow, ScenarioResult } from '../types'

const PRELOAD_DOCS = 10_000
const ADDITIONAL_DOCS = 5_000
const QUERY_COUNT = 200
const INTERLEAVE_CYCLES = 10
const INTERLEAVE_INSERT_SIZE = 500
const INTERLEAVE_QUERY_COUNT = 20
const SEED = 42

export async function runMixedWorkload(): Promise<ScenarioResult> {
  const start = performance.now()
  const queries = generateQueries(QUERY_COUNT, SEED + 1)

  const comparisons: ComparisonRow[] = []

  console.log('  measuring orama baseline...')
  const oramaDb = create({
    schema: { title: 'string' as const, body: 'string' as const, score: 'number' as const, category: 'enum' as const },
    language: 'english',
  })
  const preloadDocs = generateDocuments(PRELOAD_DOCS, SEED)
  await insertMultiple(
    oramaDb,
    preloadDocs.map(({ id, ...rest }) => rest),
  )

  const oramaAdditional = generateDocumentBatch(ADDITIONAL_DOCS, SEED + 10, PRELOAD_DOCS).map(({ id, ...rest }) => rest)
  const oInsertStart = performance.now()
  await insertMultiple(oramaDb, oramaAdditional)
  const oInsertMs = performance.now() - oInsertStart
  const oramaInsertThroughput = Math.round(ADDITIONAL_DOCS / (oInsertMs / 1000))

  const oramaSearchTimes: number[] = []
  for (const q of queries) {
    const s = performance.now()
    await search(oramaDb, { term: q })
    oramaSearchTimes.push(performance.now() - s)
  }
  console.log(
    `  orama: ${fmt(oramaInsertThroughput)} insert docs/sec, ` +
      `search ${median(oramaSearchTimes).toFixed(3)}ms median`,
  )
  comparisons.push({
    label: 'orama-insert',
    metrics: { docsPerSec: oramaInsertThroughput, totalMs: Math.round(oInsertMs) },
  })
  comparisons.push({
    label: 'orama-search',
    metrics: {
      medianMs: Number(median(oramaSearchTimes).toFixed(3)),
      p95Ms: Number(percentile(oramaSearchTimes, 95).toFixed(3)),
    },
  })

  console.log('  measuring minisearch baseline...')
  const ms = new MiniSearch<BenchDocument>({
    fields: ['title', 'body'],
    storeFields: ['title', 'body', 'score', 'category'],
    idField: 'id',
    processTerm: (term: string) => stemmer(term.toLowerCase()),
  })
  ms.addAll(preloadDocs)

  const msAdditional = generateDocumentBatch(ADDITIONAL_DOCS, SEED + 10, PRELOAD_DOCS)
  const msInsertStart = performance.now()
  ms.addAll(msAdditional)
  const msInsertMs = performance.now() - msInsertStart
  const msInsertThroughput = Math.round(ADDITIONAL_DOCS / (msInsertMs / 1000))

  const msSearchTimes: number[] = []
  for (const q of queries) {
    const s = performance.now()
    ms.search(q)
    msSearchTimes.push(performance.now() - s)
  }
  console.log(
    `  minisearch: ${fmt(msInsertThroughput)} insert docs/sec, ` +
      `search ${median(msSearchTimes).toFixed(3)}ms median`,
  )
  comparisons.push({
    label: 'minisearch-insert',
    metrics: { docsPerSec: msInsertThroughput, totalMs: Math.round(msInsertMs) },
  })
  comparisons.push({
    label: 'minisearch-search',
    metrics: {
      medianMs: Number(median(msSearchTimes).toFixed(3)),
      p95Ms: Number(percentile(msSearchTimes, 95).toFixed(3)),
    },
  })

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

    const preloadInsert = preloadDocs.map(({ id, ...rest }) => rest)
    await instance.insertBatch('bench', preloadInsert, { skipClone: true })

    const isolatedInsertDocs = generateDocumentBatch(ADDITIONAL_DOCS, SEED + 10, PRELOAD_DOCS)
    const isolatedInsert = isolatedInsertDocs.map(({ id, ...rest }) => rest)
    const isolatedInsertStart = performance.now()
    await instance.insertBatch('bench', isolatedInsert, { skipClone: true })
    const isolatedInsertMs = performance.now() - isolatedInsertStart
    const isolatedInsertThroughput = Math.round(ADDITIONAL_DOCS / (isolatedInsertMs / 1000))

    const isolatedSearchTimes: number[] = []
    for (const q of queries) {
      const searchStart = performance.now()
      await instance.query('bench', { term: q })
      isolatedSearchTimes.push(performance.now() - searchStart)
    }
    const isolatedSearchMedian = median(isolatedSearchTimes)
    const isolatedSearchP95 = percentile(isolatedSearchTimes, 95)

    console.log(`  narsil isolated insert: ${fmt(isolatedInsertThroughput)} docs/sec`)
    console.log(`  narsil isolated search: ${isolatedSearchMedian.toFixed(3)}ms median`)

    comparisons.push({
      label: 'narsil-isolated-insert',
      metrics: { docsPerSec: isolatedInsertThroughput, totalMs: Math.round(isolatedInsertMs) },
    })
    comparisons.push({
      label: 'narsil-isolated-search',
      metrics: {
        medianMs: Number(isolatedSearchMedian.toFixed(3)),
        p95Ms: Number(isolatedSearchP95.toFixed(3)),
      },
    })

    await instance.shutdown()

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
    await instance.insertBatch('bench', preloadInsert, { skipClone: true })

    const interleavedInsertThroughputs: number[] = []
    const interleavedSearchMedians: number[] = []
    const interleavedSearchP95s: number[] = []
    let interleavedOffset = PRELOAD_DOCS

    for (let cycle = 0; cycle < INTERLEAVE_CYCLES; cycle++) {
      const batch = generateDocumentBatch(INTERLEAVE_INSERT_SIZE, SEED + cycle + 20, interleavedOffset)
      const insertDocs = batch.map(({ id, ...rest }) => rest)
      interleavedOffset += INTERLEAVE_INSERT_SIZE

      const insertStart = performance.now()
      await instance.insertBatch('bench', insertDocs, { skipClone: true })
      const insertMs = performance.now() - insertStart
      interleavedInsertThroughputs.push(Math.round(INTERLEAVE_INSERT_SIZE / (insertMs / 1000)))

      const cycleQueries = queries.slice(cycle * INTERLEAVE_QUERY_COUNT, (cycle + 1) * INTERLEAVE_QUERY_COUNT)
      const searchTimes: number[] = []
      for (const q of cycleQueries) {
        const searchStart = performance.now()
        await instance.query('bench', { term: q })
        searchTimes.push(performance.now() - searchStart)
      }
      interleavedSearchMedians.push(median(searchTimes))
      interleavedSearchP95s.push(percentile(searchTimes, 95))
    }

    const interleavedInsertAvg = Math.round(
      interleavedInsertThroughputs.reduce((a, b) => a + b, 0) / interleavedInsertThroughputs.length,
    )
    const interleavedSearchAvgMedian = median(interleavedSearchMedians)
    const interleavedSearchAvgP95 = median(interleavedSearchP95s)

    console.log(`  narsil interleaved insert avg: ${fmt(interleavedInsertAvg)} docs/sec`)
    console.log(`  narsil interleaved search avg: ${interleavedSearchAvgMedian.toFixed(3)}ms median`)

    comparisons.push({
      label: 'narsil-interleaved-insert-avg',
      metrics: { docsPerSec: interleavedInsertAvg },
    })
    comparisons.push({
      label: 'narsil-interleaved-search-avg',
      metrics: {
        medianMs: Number(interleavedSearchAvgMedian.toFixed(3)),
        p95Ms: Number(interleavedSearchAvgP95.toFixed(3)),
      },
    })
  } finally {
    if (instance) await instance.shutdown()
  }

  return {
    name: 'mixed-workload',
    description: 'Isolated vs interleaved insert + search, Narsil, Orama, and MiniSearch compared',
    config: {
      preloadDocs: PRELOAD_DOCS,
      additionalDocs: ADDITIONAL_DOCS,
      queryCount: QUERY_COUNT,
      interleaveCycles: INTERLEAVE_CYCLES,
      interleaveInsertSize: INTERLEAVE_INSERT_SIZE,
      interleaveQueryCount: INTERLEAVE_QUERY_COUNT,
    },
    comparisons,
    durationMs: performance.now() - start,
  }
}
