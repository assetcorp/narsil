import {
  DEFAULT_LINEAR_ALPHA,
  DEFAULT_RANK_CONSTANT,
  ErrorCodes,
  MAX_LINEAR_ALPHA,
  MIN_LINEAR_ALPHA,
  MIN_RANK_CONSTANT,
  NarsilError,
} from '#platform/vector-host'
import type { ScoredDocument } from '../types/internal'
import { fuseRankings } from './fusion-rankings'

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

export function reciprocalRankFusion(
  lists: readonly [ScoredDocument[], ScoredDocument[]],
  options: RRFOptions,
): ScoredDocument[] {
  return fuseRankings(lists[0], lists[1], 0, options.k, DEFAULT_LINEAR_ALPHA, withFusedScore)
}

export function linearCombination(
  textResults: ScoredDocument[],
  vectorResults: ScoredDocument[],
  options: LinearCombinationOptions,
): ScoredDocument[] {
  return fuseRankings(textResults, vectorResults, 1, DEFAULT_RANK_CONSTANT, options.alpha, withFusedScore)
}

function withFusedScore(entry: ScoredDocument, score: number): ScoredDocument {
  return {
    docId: entry.docId,
    score,
    termFrequencies: entry.termFrequencies,
    fieldLengths: entry.fieldLengths,
    idf: entry.idf,
  }
}
