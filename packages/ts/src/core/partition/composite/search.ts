import type { InternalSearchParams, InternalSearchResult } from '../../../types/internal'
import { type PartitionSearchMatches, searchFulltextMatches } from '../matches'
import type { PartitionReadState } from '../read-state'
import { kWayMerge } from '../scored-merge'
import { searchFulltext } from '../search'
import { type OrdinalLayout, subBitsetView } from './filters'
import { compositeQueryStats } from './stats'

function subParams(
  params: InternalSearchParams,
  layout: OrdinalLayout,
  subIndex: number,
  globalStats: InternalSearchParams['globalStats'],
): InternalSearchParams {
  return {
    ...params,
    globalStats,
    filterBitset: params.filterBitset === undefined ? undefined : subBitsetView(params.filterBitset, layout, subIndex),
  }
}

export function compositeSearchFulltext(
  subs: readonly PartitionReadState[],
  layout: OrdinalLayout,
  params: InternalSearchParams,
): InternalSearchResult {
  if (params.queryTokens.length === 0) {
    return { scored: [], totalMatched: 0 }
  }

  const globalStats = compositeQueryStats(subs, params)
  const results = subs.map((sub, index) => searchFulltext(sub, subParams(params, layout, index, globalStats)))

  const scored = kWayMerge(results.map(result => result.scored))
  if (params.maxResults !== undefined && scored.length > params.maxResults) {
    scored.length = params.maxResults
  }

  let totalMatched = 0
  for (const result of results) {
    totalMatched += result.totalMatched
  }

  if (params.collectMatchedIds !== true) {
    return { scored, totalMatched }
  }

  const matchedIds: string[] = []
  for (const result of results) {
    if (result.matchedIds !== undefined) matchedIds.push(...result.matchedIds)
  }
  return { scored, totalMatched, matchedIds }
}

export function compositeSearchMatches(
  subs: readonly PartitionReadState[],
  layout: OrdinalLayout,
  params: InternalSearchParams,
): PartitionSearchMatches {
  const subMatches = subs.map((sub, index) => searchFulltextMatches(sub, subParams(params, layout, index, undefined)))

  let count = 0
  for (const matches of subMatches) {
    count += matches.count
  }

  return {
    count,
    hasExternal(docId: string): boolean {
      for (const matches of subMatches) {
        if (matches.hasExternal(docId)) return true
      }
      return false
    },
    hasInternal(internalId: number): boolean {
      for (let i = subMatches.length - 1; i >= 0; i--) {
        if (internalId >= layout.bases[i]) {
          return subMatches[i].hasInternal(internalId - layout.bases[i])
        }
      }
      return false
    },
    matchedDocIds(): Set<string> {
      const combined = new Set<string>()
      for (const matches of subMatches) {
        for (const docId of matches.matchedDocIds()) {
          combined.add(docId)
        }
      }
      return combined
    },
  }
}
