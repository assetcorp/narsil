import { mergeGroups } from '#platform/group-merge'
import { compareCodePoints, type SortDirection } from '../../core/ordering'
import { requireLoadedOptionalReads } from '../../engine/optional-reads-code'
import { ErrorCodes, NarsilError } from '../../errors'
import type { ScoredEntry, SortField, WireGroupEntry, WireQueryParams } from '../transport/types'
import { groupIdentities } from './group-identities'

function entryRanks(
  entries: readonly ScoredEntry[],
  compare: (left: ScoredEntry, right: ScoredEntry) => number,
): Uint32Array {
  const order = Uint32Array.from(entries, (_, position) => position)
  order.sort((left, right) => compare(entries[left], entries[right]))
  const ranks = new Uint32Array(entries.length)
  let rank = 0
  for (let at = 0; at < order.length; at++) {
    if (at > 0 && compare(entries[order[at - 1]], entries[order[at]]) !== 0) rank++
    ranks[order[at]] = rank
  }
  return ranks
}

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
  const { compareSortValues } = requireLoadedOptionalReads()
  const sources: WireGroupEntry[] = []
  let count = 0
  for (const groups of perNode) {
    for (const group of groups) {
      sources.push(group)
      count += group.scored.length
    }
  }
  if (count > 0xffffffff || sources.length > 0xffffffff) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The grouped results exceed the merge layout')
  }
  const { keys, values } = groupIdentities(sources, fields)
  const offsets = new Uint32Array(sources.length + 1)
  const entries = new Array<ScoredEntry>(count)
  const scores = new Float64Array(count)
  let presence: Uint32Array | null = null
  let present = 0
  let position = 0
  for (let source = 0; source < sources.length; source++) {
    offsets[source] = position
    for (const entry of sources[source].scored) {
      entries[position] = entry
      if (entry.score === null) {
        presence ??= new Uint32Array(Math.max(1, Math.ceil(count / 32))).fill(0xffffffff)
        presence[position >>> 5] &= ~(1 << (position & 31))
      } else {
        scores[position] = entry.score
        present++
      }
      position++
    }
  }
  offsets[sources.length] = position
  const idRanks = entryRanks(entries, (left, right) => compareCodePoints(left.docId, right.docId))
  const ranks =
    sortDirections === null
      ? idRanks
      : entryRanks(
          entries,
          (left, right) =>
            compareSortValues(left.sortValues ?? [], right.sortValues ?? [], sortDirections) ||
            compareCodePoints(left.docId, right.docId),
        )
  const outKeys = new Uint32Array(values.length)
  const outOffsets = new Uint32Array(values.length + 1)
  const outSources = new Uint32Array(count)
  const outIndices = new Uint32Array(count)
  const found = mergeGroups(
    keys,
    offsets,
    present === 0 ? null : scores,
    present === 0 ? null : presence,
    ranks,
    idRanks,
    sortDirections !== null,
    maxPerGroup,
    limit,
    outKeys,
    outOffsets,
    outSources,
    outIndices,
  )
  if (found < 0) throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'The groups cannot be merged', { status: found })
  const merged = new Array<WireGroupEntry>(found)
  for (let group = 0; group < found; group++) {
    const scored: ScoredEntry[] = []
    for (let at = outOffsets[group]; at < outOffsets[group + 1]; at++) {
      scored.push(sources[outSources[at]].scored[outIndices[at]])
    }
    merged[group] = { values: values[outKeys[group]], scored }
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
