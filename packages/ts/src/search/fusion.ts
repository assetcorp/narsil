import { compareCodePoints } from '../core/ordering'
import { ErrorCodes, NarsilError } from '../errors'
import type { ScoredDocument } from '../types/internal'
import {
  DEFAULT_LINEAR_ALPHA,
  DEFAULT_RANK_CONSTANT,
  MAX_LINEAR_ALPHA,
  MIN_LINEAR_ALPHA,
  MIN_RANK_CONSTANT,
} from './constants'

export interface RRFOptions {
  k: number
}

export interface LinearCombinationOptions {
  alpha: number
}

export interface HybridFusionSettings {
  strategy?: string | null
  k?: number | null
  alpha?: number | null
}

export interface ResolvedHybridFusion {
  strategy: 'rrf' | 'linear'
  k: number
  alpha: number
}

function rankConstantOf(k: number | null | undefined): number {
  if (k === undefined || k === null) return DEFAULT_RANK_CONSTANT
  if (!Number.isInteger(k) || k < MIN_RANK_CONSTANT) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `hybrid.k must be a whole number of at least ${MIN_RANK_CONSTANT}`,
      { k },
    )
  }
  return k
}

function linearAlphaOf(alpha: number | null | undefined): number {
  if (alpha === undefined || alpha === null) return DEFAULT_LINEAR_ALPHA
  if (!Number.isFinite(alpha) || alpha < MIN_LINEAR_ALPHA || alpha > MAX_LINEAR_ALPHA) {
    throw new NarsilError(
      ErrorCodes.CONFIG_INVALID,
      `hybrid.alpha must be a number from ${MIN_LINEAR_ALPHA} to ${MAX_LINEAR_ALPHA}`,
      { alpha },
    )
  }
  return alpha
}

export function resolveHybridFusion(hybrid: HybridFusionSettings | null | undefined): ResolvedHybridFusion {
  const strategy = hybrid?.strategy ?? 'rrf'
  if (strategy !== 'rrf' && strategy !== 'linear') {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, `hybrid.strategy must be "rrf" or "linear"`, { strategy })
  }
  return { strategy, k: rankConstantOf(hybrid?.k), alpha: linearAlphaOf(hybrid?.alpha) }
}

export function reciprocalRankFusion(lists: ScoredDocument[][], options: RRFOptions): ScoredDocument[] {
  const k = options.k
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

  result.sort((a, b) => b.score - a.score || compareCodePoints(a.docId, b.docId))
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

  result.sort((a, b) => b.score - a.score || compareCodePoints(a.docId, b.docId))
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
