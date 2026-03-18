import type { BenchDocument } from './types'

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
