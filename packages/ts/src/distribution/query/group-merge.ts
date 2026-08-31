import { compareCodePoints, type SortDirection } from '../../core/ordering'
import type { SortField, WireGroupEntry, WireQueryParams } from '../transport/types'
import { mergeAndTruncateScoredEntries, mergeAndTruncateSortedEntries } from './merge'

/**
 * Merges the group lists the data nodes returned into one, the way the local
 * engine's grouping presents one. Groups whose field values are equal in
 * field order merge into one group, each merged group keeps its best
 * `maxPerGroup` entries across the nodes, the groups order by their first
 * entry, score then document ID, and the list truncates to `limit` where the
 * query sets one.
 *
 * @param perNode - One group list per responding node.
 * @param fields - The grouping fields, in the order the query names them.
 * @param maxPerGroup - The entry cap each merged group keeps.
 * @param limit - The cap on merged groups, or null to keep every group.
 * @param sortDirections - The sort directions of a sorted query, or null to merge entries by score.
 * @returns The merged groups.
 */
export function mergeDistributedGroups(
  perNode: WireGroupEntry[][],
  fields: string[],
  maxPerGroup: number,
  limit: number | null,
  sortDirections: readonly SortDirection[] | null,
): WireGroupEntry[] {
  const byKey = new Map<string, { values: Record<string, unknown>; lists: WireGroupEntry['scored'][] }>()
  for (const groups of perNode) {
    for (const group of groups) {
      const key = JSON.stringify(fields.map(field => group.values[field]))
      const existing = byKey.get(key)
      if (existing === undefined) {
        byKey.set(key, { values: group.values, lists: [group.scored] })
      } else {
        existing.lists.push(group.scored)
      }
    }
  }

  const merged: WireGroupEntry[] = []
  for (const entry of byKey.values()) {
    const scored =
      sortDirections !== null
        ? mergeAndTruncateSortedEntries(entry.lists, maxPerGroup, sortDirections)
        : mergeAndTruncateScoredEntries(entry.lists, maxPerGroup)
    merged.push({ values: entry.values, scored })
  }

  merged.sort((a, b) => {
    const aScore = a.scored.length > 0 ? (a.scored[0].score ?? 0) : 0
    const bScore = b.scored.length > 0 ? (b.scored[0].score ?? 0) : 0
    if (aScore !== bScore) return bScore - aScore
    const aId = a.scored.length > 0 ? a.scored[0].docId : ''
    const bId = b.scored.length > 0 ? b.scored[0].docId : ''
    return compareCodePoints(aId, bId)
  })

  if (limit !== null && merged.length > limit) {
    merged.length = limit
  }
  return merged
}

/**
 * Merges the nodes' group lists for one request, or returns null where the
 * request asked for no grouping or no node answered with groups.
 *
 * @param params - The wire query the coordinator ran.
 * @param allGroups - One group list per responding node.
 * @param sortFields - The query's sort fields, or null without a sort.
 * @returns The merged groups, or null.
 */
export function mergeGroupsFor(
  params: WireQueryParams,
  allGroups: WireGroupEntry[][],
  sortFields: SortField[] | null,
): WireGroupEntry[] | null {
  if (params.group === null || allGroups.length === 0) {
    return null
  }
  return mergeDistributedGroups(
    allGroups,
    params.group.fields,
    params.group.maxPerGroup,
    params.group.limit,
    sortFields !== null ? sortFields.map(field => field.direction) : null,
  )
}
