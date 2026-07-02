import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import { averagePrecision, ndcgAtK, precisionAtK, type RelevanceMap, reciprocalRank } from './metrics'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 })

interface ScifactDoc {
  id: number
  title: string
  text: string
}

interface ScifactQuery {
  id: number
  text: string
}

interface ScifactQrel {
  queryId: number
  docId: number
  relevance: number
}

function loadFixture<T>(fileName: string): T[] {
  const parsed = JSON.parse(readFileSync(new URL(`./fixtures/${fileName}`, import.meta.url), 'utf-8')) as unknown
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`fixture ${fileName} is not a non-empty JSON array`)
  }
  return parsed as T[]
}

const scifactDocuments = loadFixture<ScifactDoc>('scifact-documents.json')
const scifactQueries = loadFixture<ScifactQuery>('scifact-queries.json')
const scifactQrels = loadFixture<ScifactQrel>('scifact-qrels.json')

const THRESHOLDS = {
  ndcg10: 0.66,
  precision10: 0.088,
  map: 0.61,
  mrr: 0.62,
}

type QrelLookup = Map<number, { judgments: RelevanceMap; totalRelevant: number }>

function buildQrelLookup(): QrelLookup {
  const lookup: QrelLookup = new Map()

  for (const qrel of scifactQrels) {
    let entry = lookup.get(qrel.queryId)
    if (entry === undefined) {
      entry = { judgments: new Map(), totalRelevant: 0 }
      lookup.set(qrel.queryId, entry)
    }
    entry.judgments.set(String(qrel.docId), qrel.relevance)
    if (qrel.relevance > 0) entry.totalRelevant++
  }

  return lookup
}

describe('SciFact Relevance Evaluation', () => {
  let narsil: Narsil
  let qrelLookup: QrelLookup
  const top10Results = new Map<number, string[]>()
  const fullResults = new Map<number, string[]>()
  let queriesWithZeroResults = 0
  let queriesWithZeroRelevant = 0

  beforeAll(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('scifact', {
      schema: { title: 'string' as const, text: 'string' as const },
      language: 'english',
    })

    for (const doc of scifactDocuments) {
      await narsil.insert('scifact', { title: doc.title, text: doc.text }, String(doc.id))
    }

    qrelLookup = buildQrelLookup()

    for (const query of scifactQueries) {
      const result = await narsil.query('scifact', { term: query.text, limit: 100 })
      const allIds = result.hits.map(h => h.id)

      top10Results.set(query.id, allIds.slice(0, 10))
      fullResults.set(query.id, allIds)

      if (result.count === 0) queriesWithZeroResults++
      const entry = qrelLookup.get(query.id)
      if (entry === undefined || entry.totalRelevant === 0) queriesWithZeroRelevant++
    }

    console.log(`  SciFact setup: ${scifactDocuments.length} docs, ${scifactQueries.length} queries`)
    console.log(`  Queries with zero results: ${queriesWithZeroResults}`)
    console.log(`  Queries with zero relevant docs: ${queriesWithZeroRelevant}`)
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  function computeMeanMetric(
    resultMap: Map<number, string[]>,
    metricFn: (ranked: string[], judgments: RelevanceMap, extra: number) => number,
    extraFn: (entry: { judgments: RelevanceMap; totalRelevant: number }) => number,
  ): number {
    let sum = 0
    let count = 0

    for (const query of scifactQueries) {
      const entry = qrelLookup.get(query.id)
      if (entry === undefined || entry.totalRelevant === 0) continue

      const ranked = resultMap.get(query.id) ?? []
      sum += metricFn(ranked, entry.judgments, extraFn(entry))
      count++
    }

    return count > 0 ? sum / count : 0
  }

  it('achieves acceptable nDCG@10', () => {
    const mean = computeMeanMetric(
      top10Results,
      (ranked, judgments, k) => ndcgAtK(ranked, judgments, k),
      () => 10,
    )
    console.log(`    nDCG@10: ${mean.toFixed(4)}`)
    expect(mean).toBeGreaterThanOrEqual(THRESHOLDS.ndcg10)
  })

  it('achieves acceptable Precision@10', () => {
    const mean = computeMeanMetric(
      top10Results,
      (ranked, judgments, k) => precisionAtK(ranked, judgments, k),
      () => 10,
    )
    console.log(`    P@10:    ${mean.toFixed(4)}`)
    expect(mean).toBeGreaterThanOrEqual(THRESHOLDS.precision10)
  })

  it('achieves acceptable MAP', () => {
    const mean = computeMeanMetric(
      fullResults,
      (ranked, judgments, totalRelevant) => averagePrecision(ranked, judgments, totalRelevant),
      entry => entry.totalRelevant,
    )
    console.log(`    MAP:     ${mean.toFixed(4)}`)
    expect(mean).toBeGreaterThanOrEqual(THRESHOLDS.map)
  })

  it('achieves acceptable MRR', () => {
    const mean = computeMeanMetric(
      top10Results,
      (ranked, judgments) => reciprocalRank(ranked, judgments),
      () => 0,
    )
    console.log(`    MRR:     ${mean.toFixed(4)}`)
    expect(mean).toBeGreaterThanOrEqual(THRESHOLDS.mrr)
  })
})
