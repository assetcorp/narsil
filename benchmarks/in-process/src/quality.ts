import type { Qrels } from './data/beir'
import type { RelevanceQualityResult } from './types'

type RelevanceMap = Map<string, number>

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

function countRelevant(judgments: RelevanceMap): number {
  let total = 0
  for (const relevance of judgments.values()) {
    if (relevance > 0) total++
  }
  return total
}

export function evaluateRelevance(
  rankings: Map<string, string[]>,
  qrels: Qrels,
  dataset: string,
  docCount: number,
): RelevanceQualityResult {
  let ndcgSum = 0
  let pSum = 0
  let mapSum = 0
  let mrrSum = 0
  let evaluated = 0

  for (const [queryId, judgments] of qrels) {
    const totalRelevant = countRelevant(judgments)
    if (totalRelevant === 0) continue

    const ranked = rankings.get(queryId) ?? []
    ndcgSum += ndcgAtK(ranked, judgments, 10)
    pSum += precisionAtK(ranked, judgments, 10)
    mapSum += averagePrecision(ranked, judgments, totalRelevant)
    mrrSum += reciprocalRank(ranked, judgments)
    evaluated++
  }

  return {
    dataset,
    meanNdcg10: evaluated > 0 ? ndcgSum / evaluated : 0,
    meanPrecision10: evaluated > 0 ? pSum / evaluated : 0,
    meanMap: evaluated > 0 ? mapSum / evaluated : 0,
    meanMrr: evaluated > 0 ? mrrSum / evaluated : 0,
    queryCount: evaluated,
    docCount,
  }
}
