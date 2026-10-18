import type { GlobalStatistics, InternalSearchParams } from '../../../types/internal'
import type { PartitionStatsView } from '../../statistics'
import { termGroupOf, typoMatchesFor } from '../group-scoring'
import type { PartitionReadState } from '../read-state'
import { partitionDocumentFrequency } from '../suggestions'

function collectCandidateTerms(subs: readonly PartitionReadState[], params: InternalSearchParams): Set<string> {
  const { queryTokens, termGroups, tolerance = 0, prefixLength = 2, exact = false } = params
  const terms = new Set<string>()

  for (const qt of queryTokens) {
    const group = termGroupOf(termGroups, qt.token)
    if (group !== undefined) {
      for (const member of group.members) terms.add(member.token)
    }
    if (group === undefined && (exact || tolerance === 0)) {
      terms.add(qt.token)
      continue
    }
    for (const sub of subs) {
      for (const match of typoMatchesFor(sub.invertedIdx, qt.token, group, exact, tolerance, prefixLength)) {
        terms.add(match.token)
      }
    }
  }

  return terms
}

export function resolveQueryTermFrequencies(
  subs: readonly PartitionReadState[],
  params: InternalSearchParams,
): Record<string, number> {
  const frequencies: Record<string, number> = Object.create(null)
  for (const term of collectCandidateTerms(subs, params)) {
    const total = partitionDocumentFrequency(subs, term)
    if (total > 0) frequencies[term] = total
  }
  return frequencies
}

export function aggregateFieldStats(subs: readonly PartitionReadState[]): {
  totalDocuments: number
  totalFieldLengths: Record<string, number>
  averageFieldLengths: Record<string, number>
} {
  let totalDocuments = 0
  const totalFieldLengths: Record<string, number> = Object.create(null)

  for (const sub of subs) {
    totalDocuments += sub.stats.totalDocuments
    for (const [field, length] of Object.entries(sub.stats.totalFieldLengths)) {
      totalFieldLengths[field] = (totalFieldLengths[field] ?? 0) + length
    }
  }

  const averageFieldLengths: Record<string, number> = Object.create(null)
  if (totalDocuments > 0) {
    for (const [field, length] of Object.entries(totalFieldLengths)) {
      averageFieldLengths[field] = length / totalDocuments
    }
  }

  return { totalDocuments, totalFieldLengths, averageFieldLengths }
}

export function mergeDocFrequencies(subs: readonly PartitionReadState[]): Readonly<Record<string, number>> {
  const merged: Record<string, number> = Object.create(null)
  for (const sub of subs) {
    for (const [term, frequency] of Object.entries(sub.stats.docFrequencies)) {
      merged[term] = (merged[term] ?? 0) + frequency
    }
  }
  return merged
}

export function buildAggregateStatsView(
  subs: readonly PartitionReadState[],
  docFrequencies: () => Readonly<Record<string, number>>,
): PartitionStatsView {
  const fields = aggregateFieldStats(subs)
  return {
    ...fields,
    get docFrequencies(): Readonly<Record<string, number>> {
      return docFrequencies()
    },
  }
}

export function compositeQueryStats(
  subs: readonly PartitionReadState[],
  params: InternalSearchParams,
): GlobalStatistics {
  const resolved = resolveQueryTermFrequencies(subs, params)
  const caller = params.globalStats

  if (caller === undefined) {
    const fields = aggregateFieldStats(subs)
    return { ...fields, docFrequencies: resolved }
  }

  return {
    totalDocuments: caller.totalDocuments,
    totalFieldLengths: caller.totalFieldLengths,
    averageFieldLengths: caller.averageFieldLengths,
    docFrequencies: { ...resolved, ...caller.docFrequencies },
  }
}
