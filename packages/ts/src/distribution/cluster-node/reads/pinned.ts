import type { QueryParams } from '../../../types/search'
import type { AllocationTable } from '../../coordinator/types'
import { selectReplica } from '../../query/selection'
import type { DistributedQueryResult } from '../../query/types'
import { readDistributedDocuments } from '../node-messaging'
import { resolvePartitionId } from '../write-routing'
import type { ClusterReadDeps } from './scatter'

/**
 * Splits a pinned id list by whether any active replica serves the partition
 * holding each id. The coordinator verifies and drops only the ids it can
 * reach, and it keeps an entry it cannot verify, because a partition outage
 * says nothing about whether the document exists.
 *
 * @param pinnedIds - The pinned document ids.
 * @param allocation - The allocation table naming each partition's replicas.
 * @returns The ids a replica can answer for, and the ids none can.
 */
export function splitPinnedByReachability(
  pinnedIds: Iterable<string>,
  allocation: AllocationTable,
): { verifiable: string[]; unverifiable: Set<string> } {
  const partitionCount = allocation.assignments.size
  const verifiable: string[] = []
  const unverifiable = new Set<string>()
  for (const docId of pinnedIds) {
    const partitionId = resolvePartitionId(docId, partitionCount)
    const assignment = allocation.assignments.get(partitionId)
    const nodeId = assignment === undefined ? null : selectReplica(assignment, undefined, partitionId)
    if (nodeId === null) {
      unverifiable.add(docId)
    } else {
      verifiable.push(docId)
    }
  }
  return { verifiable, unverifiable }
}

export interface PinPresence {
  pinnedIds: ReadonlySet<string>
  stored: ReadonlySet<string>
  unverifiable: ReadonlySet<string>
}

/**
 * Reads, once for the whole query, which pinned documents a reachable node
 * stores, so that dropping unstored placements and counting outside pins
 * share one read. Cursor pages carry no placements, so they need none.
 *
 * @param deps - The cluster configuration, this node's id, the local engine, and the node target resolver.
 * @param indexName - The index the query ran against.
 * @param params - The caller's query.
 * @param allocation - The allocation table that routes each document id to its holder.
 * @returns The stored and unverifiable pinned ids, or null where the query places no pins.
 */
export async function readPinPresence(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
  allocation: AllocationTable,
): Promise<PinPresence | null> {
  if (params.pinned === undefined || params.searchAfter !== undefined) return null
  const pinnedIds = new Set(params.pinned.map(entry => entry.docId))
  const { verifiable, unverifiable } = splitPinnedByReachability(pinnedIds, allocation)
  const documents =
    verifiable.length === 0
      ? new Map()
      : await readDistributedDocuments(deps.config, deps.nodeId, deps.engine, indexName, verifiable, allocation)
  return { pinnedIds, stored: new Set(documents.keys()), unverifiable }
}

/**
 * Drops each pinned placement whose document no reachable node stores, as the
 * local engine drops an unresolvable pin, and keeps a placement it cannot
 * verify because its partition has no active replica.
 *
 * @param distributed - The merged distributed result.
 * @param presence - Which pinned documents a node stores, or null where the query places no pins.
 * @returns The scored entries with every known-unstored placement removed.
 */
export function dropUnstoredPinnedEntries(
  distributed: DistributedQueryResult,
  presence: PinPresence | null,
): DistributedQueryResult['scored'] {
  if (presence === null) return distributed.scored
  return distributed.scored.filter(
    entry =>
      !presence.pinnedIds.has(entry.docId) ||
      presence.unverifiable.has(entry.docId) ||
      presence.stored.has(entry.docId),
  )
}

export function countStoredPinsFromOutside(
  distributed: DistributedQueryResult,
  presence: PinPresence | null,
): { stored: number; everyPinVerified: boolean } {
  const outside = distributed.pinnedFromOutside ?? []
  if (outside.length === 0) return { stored: 0, everyPinVerified: true }
  if (presence === null) return { stored: 0, everyPinVerified: false }
  let count = 0
  let everyPinVerified = true
  for (const docId of outside) {
    if (presence.unverifiable.has(docId)) everyPinVerified = false
    else if (presence.stored.has(docId)) count++
  }
  return { stored: count, everyPinVerified }
}
