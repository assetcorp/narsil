import type { ResolvedProjection } from '../../../core/projection'
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

/**
 * Drops each pinned placement whose document no reachable node stores, as the
 * local engine drops an unresolvable pin, and keeps a placement it cannot
 * verify because its partition has no active replica. Cursor pages carry no
 * placements, so they pass through untouched.
 *
 * @param deps - The cluster configuration, this node's id, the local engine, and the node target resolver.
 * @param indexName - The index the query ran against.
 * @param params - The caller's query.
 * @param distributed - The merged distributed result.
 * @param allocation - The allocation table that routes each document id to its holder.
 * @param projection - The resolved document projection of the query.
 * @param documents - The documents the fetch phase found, keyed by id.
 * @returns The scored entries with every known-unstored placement removed.
 */
export async function dropUnstoredPinnedEntries<T>(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
  distributed: DistributedQueryResult,
  allocation: AllocationTable,
  projection: ResolvedProjection,
  documents: Map<string, T>,
): Promise<DistributedQueryResult['scored']> {
  if (params.pinned === undefined || params.searchAfter !== undefined) {
    return distributed.scored
  }
  const pinnedIds = new Set(params.pinned.map(entry => entry.docId))
  const { verifiable, unverifiable } = splitPinnedByReachability(pinnedIds, allocation)
  const stored: { has(docId: string): boolean } =
    projection.kind === 'none'
      ? await readDistributedDocuments(deps.config, deps.nodeId, deps.engine, indexName, verifiable, allocation)
      : documents
  return distributed.scored.filter(
    entry => !pinnedIds.has(entry.docId) || unverifiable.has(entry.docId) || stored.has(entry.docId),
  )
}
