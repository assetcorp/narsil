import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import cranfieldDocuments from './fixtures/cranfield-documents.json'
import cranfieldQrels from './fixtures/cranfield-qrels.json'
import cranfieldQueries from './fixtures/cranfield-queries.json'
import { averagePrecision, ndcgAtK, precisionAtK, type RelevanceMap, reciprocalRank } from './metrics'

vi.setConfig({ testTimeout: 30_000 })

const THRESHOLDS = {
  ndcg10: 0.32,
  precision10: 0.21,
  map: 0.27,
  mrr: 0.48,
}

type QrelLookup = Map<number, { judgments: RelevanceMap; totalRelevant: number }>

function buildQrelLookup(): QrelLookup {
  const lookup: QrelLookup = new Map()

  for (const qrel of cranfieldQrels) {
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

describe('Cranfield Relevance Evaluation', () => {
  let narsil: Narsil
  let qrelLookup: QrelLookup
  const top10Results = new Map<number, string[]>()
  const fullResults = new Map<number, string[]>()
  let queriesWithZeroResults = 0
  let queriesWithZeroRelevant = 0

  beforeAll(async () => {
    narsil = await createNarsil()
    await narsil.createIndex('cranfield', {
      schema: { title: 'string' as const, body: 'string' as const },
      language: 'english',
    })

    for (const doc of cranfieldDocuments) {
      await narsil.insert('cranfield', { title: doc.title, body: doc.body }, String(doc.id))
    }

    qrelLookup = buildQrelLookup()

    for (const query of cranfieldQueries) {
      const top10 = await narsil.query('cranfield', { term: query.text, limit: 10 })
      top10Results.set(
        query.id,
        top10.hits.map(h => h.id),
      )

      const full = await narsil.query('cranfield', { term: query.text, limit: 1400 })
      fullResults.set(
        query.id,
        full.hits.map(h => h.id),
      )

      if (top10.count === 0) queriesWithZeroResults++
      const entry = qrelLookup.get(query.id)
      if (entry === undefined || entry.totalRelevant === 0) queriesWithZeroRelevant++
    }

    console.log(`  Cranfield setup: ${cranfieldDocuments.length} docs, ${cranfieldQueries.length} queries`)
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

    for (const query of cranfieldQueries) {
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
