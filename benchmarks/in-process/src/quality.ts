import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BenchDocument, CranfieldQualityResult } from './types'

type RelevanceMap = Map<string, number>

interface CranfieldDoc {
  id: number
  title: string
  author: string
  body: string
}

interface CranfieldQuery {
  id: number
  text: string
}

interface CranfieldQrel {
  queryId: number
  docId: number
  relevance: number
}

interface CranfieldData {
  documents: BenchDocument[]
  queries: CranfieldQuery[]
  qrelLookup: Map<number, { judgments: RelevanceMap; totalRelevant: number }>
}

export function ndcgAtK(ranked: string[], judgments: RelevanceMap, k: number): number {
  const n = Math.min(ranked.length, k)
  let dcg = 0
  for (let i = 0; i < n; i++) {
    const rel = judgments.get(ranked[i]) ?? 0
    dcg += (2 ** rel - 1) / Math.log2(i + 2)
  }

  const idealRels = Array.from(judgments.values())
    .filter(r => r > 0)
    .sort((a, b) => b - a)
  let idcg = 0
  const idealN = Math.min(idealRels.length, k)
  for (let i = 0; i < idealN; i++) {
    idcg += (2 ** idealRels[i] - 1) / Math.log2(i + 2)
  }

  return idcg === 0 ? 0 : dcg / idcg
}

export function precisionAtK(ranked: string[], judgments: RelevanceMap, k: number): number {
  const n = Math.min(ranked.length, k)
  if (n === 0) return 0
  let relevant = 0
  for (let i = 0; i < n; i++) {
    if ((judgments.get(ranked[i]) ?? 0) > 0) relevant++
  }
  return relevant / k
}

export function averagePrecision(ranked: string[], judgments: RelevanceMap, totalRelevant: number): number {
  if (totalRelevant === 0) return 0
  let sumPrecision = 0
  let relevantSoFar = 0
  for (let i = 0; i < ranked.length; i++) {
    if ((judgments.get(ranked[i]) ?? 0) > 0) {
      relevantSoFar++
      sumPrecision += relevantSoFar / (i + 1)
    }
  }
  return sumPrecision / totalRelevant
}

export function reciprocalRank(ranked: string[], judgments: RelevanceMap): number {
  for (let i = 0; i < ranked.length; i++) {
    if ((judgments.get(ranked[i]) ?? 0) > 0) return 1 / (i + 1)
  }
  return 0
}

export function loadCranfieldData(fixturesDir: string): CranfieldData {
  const rawDocs = JSON.parse(readFileSync(resolve(fixturesDir, 'cranfield-documents.json'), 'utf-8')) as CranfieldDoc[]
  const rawQueries = JSON.parse(
    readFileSync(resolve(fixturesDir, 'cranfield-queries.json'), 'utf-8'),
  ) as CranfieldQuery[]
  const rawQrels = JSON.parse(readFileSync(resolve(fixturesDir, 'cranfield-qrels.json'), 'utf-8')) as CranfieldQrel[]

  const documents: BenchDocument[] = rawDocs.map(d => ({
    id: String(d.id),
    title: d.title,
    body: d.body,
    score: 0,
    category: 'aerodynamics',
  }))

  const qrelLookup = new Map<number, { judgments: RelevanceMap; totalRelevant: number }>()
  for (const qrel of rawQrels) {
    let entry = qrelLookup.get(qrel.queryId)
    if (entry === undefined) {
      entry = { judgments: new Map(), totalRelevant: 0 }
      qrelLookup.set(qrel.queryId, entry)
    }
    entry.judgments.set(String(qrel.docId), qrel.relevance)
    if (qrel.relevance > 0) entry.totalRelevant++
  }

  return { documents, queries: rawQueries, qrelLookup }
}

export function evaluateCranfield(
  top10Results: Map<number, string[]>,
  fullResults: Map<number, string[]>,
  data: CranfieldData,
): CranfieldQualityResult {
  let ndcgSum = 0
  let pSum = 0
  let mapSum = 0
  let mrrSum = 0
  let evaluated = 0

  for (const query of data.queries) {
    const entry = data.qrelLookup.get(query.id)
    if (entry === undefined || entry.totalRelevant === 0) continue

    const top10 = top10Results.get(query.id) ?? []
    const full = fullResults.get(query.id) ?? []

    ndcgSum += ndcgAtK(top10, entry.judgments, 10)
    pSum += precisionAtK(top10, entry.judgments, 10)
    mapSum += averagePrecision(full, entry.judgments, entry.totalRelevant)
    mrrSum += reciprocalRank(top10, entry.judgments)
    evaluated++
  }

  return {
    meanNdcg10: evaluated > 0 ? ndcgSum / evaluated : 0,
    meanPrecision10: evaluated > 0 ? pSum / evaluated : 0,
    meanMap: evaluated > 0 ? mapSum / evaluated : 0,
    meanMrr: evaluated > 0 ? mrrSum / evaluated : 0,
    queryCount: evaluated,
    docCount: data.documents.length,
  }
}
