import type { ScoredDocument } from '../types/internal'

export interface RRFOptions {
  k: number
}

export interface LinearCombinationOptions {
  alpha: number
}

export function reciprocalRankFusion(lists: ScoredDocument[][], options: RRFOptions): ScoredDocument[] {
  const k = options.k > 0 ? options.k : 60
  const scores = new Map<string, number>()
  const docData = new Map<string, ScoredDocument>()

  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const doc = list[rank]
      const rrfContribution = 1 / (k + rank + 1)
      scores.set(doc.docId, (scores.get(doc.docId) ?? 0) + rrfContribution)
      if (!docData.has(doc.docId)) {
        docData.set(doc.docId, doc)
      }
    }
  }

  const result: ScoredDocument[] = []
  for (const [docId, score] of scores) {
    const original = docData.get(docId)
    if (!original) continue
    result.push({
      docId,
      score,
      termFrequencies: original.termFrequencies,
      fieldLengths: original.fieldLengths,
      idf: original.idf,
    })
  }

  result.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
  return result
}

export function linearCombination(
  textResults: ScoredDocument[],
  vectorResults: ScoredDocument[],
  options: LinearCombinationOptions,
): ScoredDocument[] {
  const { alpha } = options

  const normalizedText = minMaxNormalize(textResults)
  const normalizedVector = minMaxNormalize(vectorResults)

  const textScoreMap = new Map<string, number>()
  for (const doc of normalizedText) {
    textScoreMap.set(doc.docId, doc.score)
  }

  const textDocMap = new Map<string, ScoredDocument>()
  for (const doc of textResults) {
    textDocMap.set(doc.docId, doc)
  }

  const vectorScoreMap = new Map<string, number>()
  for (const doc of normalizedVector) {
    vectorScoreMap.set(doc.docId, doc.score)
  }

  const allDocIds = new Set<string>()
  for (const doc of textResults) allDocIds.add(doc.docId)
  for (const doc of vectorResults) allDocIds.add(doc.docId)

  const result: ScoredDocument[] = []
  for (const docId of allDocIds) {
    const tScore = textScoreMap.get(docId) ?? 0
    const vScore = vectorScoreMap.get(docId) ?? 0
    const combined = alpha * vScore + (1 - alpha) * tScore

    const original = textDocMap.get(docId)
    result.push({
      docId,
      score: combined,
      termFrequencies: original?.termFrequencies ?? {},
      fieldLengths: original?.fieldLengths ?? {},
      idf: original?.idf ?? {},
    })
  }

  result.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId))
  return result
}

export function minMaxNormalize(docs: ScoredDocument[]): Array<{ docId: string; score: number }> {
  if (docs.length === 0) return []

  let min = docs[0].score
  let max = docs[0].score
  for (let i = 1; i < docs.length; i++) {
    if (docs[i].score < min) min = docs[i].score
    if (docs[i].score > max) max = docs[i].score
  }

  const range = max - min
  if (range === 0) {
    return docs.map(d => ({ docId: d.docId, score: 1.0 }))
  }

  return docs.map(d => ({ docId: d.docId, score: (d.score - min) / range }))
}
