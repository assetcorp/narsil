import type { InternalSearchParams, InternalSearchResult } from '../../../types/internal'
import { createBitSet } from '../../bitset'
import { type PartitionSearchMatches, searchFulltextMatches } from '../matches'
import type { PartitionReadState } from '../read-state'
import { kWayMerge } from '../scored-merge'
import { searchFulltext } from '../search'
import { type OrdinalLayout, placeSubBitset, subBitsetView } from './filters'
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

function onlyPopulatedSub(subs: readonly PartitionReadState[]): number {
  let found = -1
  for (let i = 0; i < subs.length; i++) {
    if (subs[i].stats.totalDocuments === 0) continue
    if (found !== -1) return -1
    found = i
  }
  return found
}

function searchSingleSub(
  subs: readonly PartitionReadState[],
  layout: OrdinalLayout,
  params: InternalSearchParams,
  index: number,
): InternalSearchResult {
  const result = searchFulltext(subs[index], subParams(params, layout, index, params.globalStats))
  if (result.matchedOrdinalBitset === undefined) return result
  const matchedOrdinalBitset = createBitSet(layout.totalCapacity)
  placeSubBitset(matchedOrdinalBitset, layout, index, result.matchedOrdinalBitset)
  return { ...result, matchedOrdinalBitset }
}

export function compositeSearchFulltext(
  subs: readonly PartitionReadState[],
  layout: OrdinalLayout,
  params: InternalSearchParams,
): InternalSearchResult {
  if (params.queryTokens.length === 0) {
    return { scored: [], totalMatched: 0 }
  }

  const single = onlyPopulatedSub(subs)
  if (single !== -1) {
    return searchSingleSub(subs, layout, params, single)
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

  if (params.collectMatchedSet === undefined) {
    return { scored, totalMatched }
  }

  if (params.collectMatchedSet === 'ordinals') {
    const matchedOrdinalBitset = createBitSet(layout.totalCapacity)
    for (let i = 0; i < results.length; i++) {
      const subBitset = results[i].matchedOrdinalBitset
      if (subBitset !== undefined) placeSubBitset(matchedOrdinalBitset, layout, i, subBitset)
    }
    return { scored, totalMatched, matchedOrdinalBitset }
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
    ordinalBitset(): Uint32Array {
      const combined = createBitSet(layout.totalCapacity)
      for (let i = 0; i < subMatches.length; i++) {
        placeSubBitset(combined, layout, i, subMatches[i].ordinalBitset())
      }
      return combined
    },
  }
}
