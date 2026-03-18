import { createNarsil, type Narsil } from '@delali/narsil'
import { create, insertMultiple, search } from '@orama/orama'
import MiniSearch from 'minisearch'
import { generateDocuments, generateQueries } from '../data'
import { measureSearchBatch } from '../run-scenarios'
import { fmt, median, percentile } from '../stats'
import type { BenchDocument, ComparisonRow, ScenarioResult } from '../types'

const TOTAL_DOCS = 100_000
const PARTITION_CONFIGS = [1, 5, 10, 20]
const QUERY_COUNT = 100
const WARMUP_QUERIES = 10
const SEED = 42

async function measureOramaBaseline(
  docs: BenchDocument[],
  queries: string[],
): Promise<{ insertDocsPerSec: number; searchMedianMs: number; searchP95Ms: number }> {
  const db = create({
    schema: { title: 'string' as const, body: 'string' as const, score: 'number' as const, category: 'enum' as const },
    language: 'english',
  })
  const insertDocs = docs.map(({ id, ...rest }) => rest)
  const insertStart = performance.now()
  await insertMultiple(db, insertDocs)
  const insertMs = performance.now() - insertStart

  for (const q of queries.slice(0, WARMUP_QUERIES)) {
    await search(db, { term: q })
  }
  const times: number[] = []
  for (const q of queries) {
    const s = performance.now()
    await search(db, { term: q })
    times.push(performance.now() - s)
  }

  return {
    insertDocsPerSec: Math.round(TOTAL_DOCS / (insertMs / 1000)),
    searchMedianMs: median(times),
    searchP95Ms: percentile(times, 95),
  }
}

function measureMiniSearchBaseline(
  docs: BenchDocument[],
  queries: string[],
): { insertDocsPerSec: number; searchMedianMs: number; searchP95Ms: number } {
  const ms = new MiniSearch<BenchDocument>({
    fields: ['title', 'body'],
    storeFields: ['title', 'body', 'score', 'category'],
    idField: 'id',
  })
  const insertStart = performance.now()
  ms.addAll(docs)
  const insertMs = performance.now() - insertStart

  for (const q of queries.slice(0, WARMUP_QUERIES)) {
    ms.search(q)
  }
  const times: number[] = []
  for (const q of queries) {
    const s = performance.now()
    ms.search(q)
    times.push(performance.now() - s)
  }

  return {
    insertDocsPerSec: Math.round(TOTAL_DOCS / (insertMs / 1000)),
    searchMedianMs: median(times),
    searchP95Ms: percentile(times, 95),
  }
}

export async function runPartitionedSearch(): Promise<ScenarioResult> {
  const start = performance.now()
  const docs = generateDocuments(TOTAL_DOCS, SEED)
  const queries = generateQueries(QUERY_COUNT, SEED + 1)

  const comparisons: ComparisonRow[] = []

  console.log('  measuring orama baseline...')
  const orama = await measureOramaBaseline(docs, queries)
  console.log(
    `  orama: ${fmt(orama.insertDocsPerSec)} docs/sec, ` +
      `search ${orama.searchMedianMs.toFixed(3)}ms median, ${orama.searchP95Ms.toFixed(3)}ms p95`,
  )
  comparisons.push({
    label: 'orama',
    metrics: {
      insertDocsPerSec: orama.insertDocsPerSec,
      searchMedianMs: Number(orama.searchMedianMs.toFixed(3)),
      searchP95Ms: Number(orama.searchP95Ms.toFixed(3)),
    },
  })

  console.log('  measuring minisearch baseline...')
  const mini = measureMiniSearchBaseline(docs, queries)
  console.log(
    `  minisearch: ${fmt(mini.insertDocsPerSec)} docs/sec, ` +
      `search ${mini.searchMedianMs.toFixed(3)}ms median, ${mini.searchP95Ms.toFixed(3)}ms p95`,
  )
  comparisons.push({
    label: 'minisearch',
    metrics: {
      insertDocsPerSec: mini.insertDocsPerSec,
      searchMedianMs: Number(mini.searchMedianMs.toFixed(3)),
      searchP95Ms: Number(mini.searchP95Ms.toFixed(3)),
    },
  })

  for (const partitionCount of PARTITION_CONFIGS) {
    const maxDocsPerPartition = Math.ceil(TOTAL_DOCS / partitionCount)

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
        partitions: { maxDocsPerPartition, maxPartitions: partitionCount },
      })

      const insertDocs = docs.map(({ id, ...rest }) => rest)
      const insertStart = performance.now()
      await instance.insertBatch('bench', insertDocs, { skipClone: true })
      const insertMs = performance.now() - insertStart
      const insertThroughput = Math.round(TOTAL_DOCS / (insertMs / 1000))

      for (const q of queries.slice(0, WARMUP_QUERIES)) {
        await instance.query('bench', { term: q })
      }

      const { medianMs, p95Ms } = await measureSearchBatch(instance, 'bench', queries)

      console.log(
        `  narsil ${partitionCount}p: ${fmt(insertThroughput)} docs/sec, ` +
          `search ${medianMs.toFixed(3)}ms median, ${p95Ms.toFixed(3)}ms p95`,
      )

      comparisons.push({
        label: `narsil-${partitionCount}p`,
        metrics: {
          insertDocsPerSec: insertThroughput,
          searchMedianMs: Number(medianMs.toFixed(3)),
          searchP95Ms: Number(p95Ms.toFixed(3)),
        },
      })
    } finally {
      if (instance) await instance.shutdown()
    }
  }

  return {
    name: 'partitioned-search',
    description: 'Narsil partition fan-out vs Orama and MiniSearch at 100K documents',
    config: { totalDocs: TOTAL_DOCS, partitionConfigs: PARTITION_CONFIGS, queryCount: QUERY_COUNT },
    comparisons,
    durationMs: performance.now() - start,
  }
}
