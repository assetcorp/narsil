export type RelevanceMap = Map<string, number>

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

  if (idcg === 0) return 0
  return dcg / idcg
}

export function precisionAtK(ranked: string[], judgments: RelevanceMap, k: number): number {
  const n = Math.min(ranked.length, k)
  if (n === 0) return 0

  let relevant = 0
  for (let i = 0; i < n; i++) {
    const rel = judgments.get(ranked[i]) ?? 0
    if (rel > 0) relevant++
  }

  return relevant / k
}

export function averagePrecision(ranked: string[], judgments: RelevanceMap, totalRelevant: number): number {
  if (totalRelevant === 0) return 0

  let sumPrecision = 0
  let relevantSoFar = 0

  for (let i = 0; i < ranked.length; i++) {
    const rel = judgments.get(ranked[i]) ?? 0
    if (rel > 0) {
      relevantSoFar++
      sumPrecision += relevantSoFar / (i + 1)
    }
  }

  return sumPrecision / totalRelevant
}

export function reciprocalRank(ranked: string[], judgments: RelevanceMap): number {
  for (let i = 0; i < ranked.length; i++) {
    const rel = judgments.get(ranked[i]) ?? 0
    if (rel > 0) return 1 / (i + 1)
  }
  return 0
}
