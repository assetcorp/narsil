import { DEFAULT_LINEAR_ALPHA, DEFAULT_RANK_CONSTANT } from '../../search/constants'
import { fuseRankings } from '../../search/fusion-rankings'
import type { ScoredEntry } from '../transport/types'

export interface DistributedRRFOptions {
  k: number
}

export interface DistributedLinearOptions {
  alpha: number
}

export function distributedRRF(
  lists: readonly [ScoredEntry[], ScoredEntry[]],
  options: DistributedRRFOptions,
): ScoredEntry[] {
  return fuseRankings(lists[0], lists[1], 0, options.k, DEFAULT_LINEAR_ALPHA, withFusedScore)
}

export function distributedLinearCombination(
  textResults: ScoredEntry[],
  vectorResults: ScoredEntry[],
  options: DistributedLinearOptions,
): ScoredEntry[] {
  return fuseRankings(textResults, vectorResults, 1, DEFAULT_RANK_CONSTANT, options.alpha, withFusedScore)
}

function withFusedScore(entry: ScoredEntry, score: number): ScoredEntry {
  return {
    docId: entry.docId,
    score,
    sortValues: null,
  }
}
