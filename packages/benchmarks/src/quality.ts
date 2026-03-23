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

interface TokenStats {
  tf: Map<string, Map<string, number>>
  df: Map<string, number>
  fieldLengths: Map<string, number>
  avgFieldLength: number
  docCount: number
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter(t => t.length > 0)
}

function buildStats(docs: BenchDocument[]): TokenStats {
  const tf = new Map<string, Map<string, number>>()
  const df = new Map<string, number>()
  const fieldLengths = new Map<string, number>()
  let totalLength = 0

  for (const doc of docs) {
    const tokens = [...tokenize(doc.title), ...tokenize(doc.body)]
    fieldLengths.set(doc.id, tokens.length)
    totalLength += tokens.length

    const termFreqs = new Map<string, number>()
    const seenTerms = new Set<string>()
    for (const token of tokens) {
      termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1)
      seenTerms.add(token)
    }
    tf.set(doc.id, termFreqs)
    for (const term of seenTerms) {
      df.set(term, (df.get(term) ?? 0) + 1)
    }
  }

  return { tf, df, fieldLengths, avgFieldLength: totalLength / docs.length, docCount: docs.length }
}

function bm25Score(stats: TokenStats, docId: string, queryTerms: string[], k1 = 1.2, b = 0.75): number {
  const docTf = stats.tf.get(docId)
  if (!docTf) return 0
  const dl = stats.fieldLengths.get(docId) ?? 0
  let score = 0

  for (const term of queryTerms) {
    const freq = docTf.get(term) ?? 0
    if (freq === 0) continue
    const docFreq = stats.df.get(term) ?? 0
    const idf = Math.log(1 + (stats.docCount - docFreq + 0.5) / (docFreq + 0.5))
    const tfNorm = (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (dl / stats.avgFieldLength)))
    score += idf * tfNorm
  }

  return score
}

export function computeGroundTruthBM25(docs: BenchDocument[], query: string, k = 10): string[] {
  const stats = buildStats(docs)
  const queryTerms = tokenize(query)

  const scores: Array<{ docId: string; score: number }> = []
  for (const doc of docs) {
    const score = bm25Score(stats, doc.id, queryTerms)
    if (score > 0) {
      scores.push({ docId: doc.id, score })
    }
  }

  scores.sort((a, b) => b.score - a.score)
  return scores.slice(0, k).map(s => s.docId)
}

export function computeNDCG(predicted: string[], groundTruth: string[], k = 10): number {
  const relevance = new Map<string, number>()
  for (let i = 0; i < groundTruth.length; i++) {
    relevance.set(groundTruth[i], groundTruth.length - i)
  }

  let dcg = 0
  for (let i = 0; i < Math.min(predicted.length, k); i++) {
    const rel = relevance.get(predicted[i]) ?? 0
    dcg += rel / Math.log2(i + 2)
  }

  let idcg = 0
  const idealRels = Array.from(relevance.values()).sort((a, b) => b - a)
  for (let i = 0; i < Math.min(idealRels.length, k); i++) {
    idcg += idealRels[i] / Math.log2(i + 2)
  }

  return idcg === 0 ? 0 : dcg / idcg
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
