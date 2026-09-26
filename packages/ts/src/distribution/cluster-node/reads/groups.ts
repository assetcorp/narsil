import { applyProjection, type ResolvedProjection } from '../../../core/projection'
import { foldGroupReducer, hitsKeptPerGroup } from '../../../search/grouping'
import type { GroupResult, Hit } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { GroupReducer, QueryParams } from '../../../types/search'
import type { AllocationTable } from '../../coordinator/types'
import { MAX_FETCH_DOCUMENT_IDS } from '../../query/constants'
import type { DistributedQueryResult } from '../../query/types'
import type { WireGroupEntry } from '../../transport/types'
import { readDistributedDocuments } from '../node-messaging'
import type { ClusterReadDeps } from './scatter'

/**
 * Turns the merged wire groups of a distributed query into the group results
 * the engine returns locally. The group entries name documents by ID, so this
 * reads their bodies from the nodes that hold them, and it folds the caller's
 * reducer here, because a reducer is a function the wire cannot carry.
 *
 * @param deps - The cluster configuration, this node's id, the local engine, and the node target resolver.
 * @param indexName - The index the query ran against.
 * @param params - The caller's query, whose `group.reduce` closure folds here.
 * @param distributed - The merged distributed result carrying the wire groups.
 * @param allocation - The allocation table that routes each document ID to its holder.
 * @param projection - The resolved document projection of the query.
 * @returns The assembled groups, or undefined when the query asked for none.
 */
export async function assembleDistributedGroups(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
  distributed: DistributedQueryResult,
  allocation: AllocationTable,
  projection: ResolvedProjection,
): Promise<GroupResult[] | undefined> {
  const wireGroups = distributed.groups
  const group = params.group
  if (wireGroups === null || group === undefined) {
    return undefined
  }

  const reduce = group.reduce
  const needsDocuments = reduce !== undefined || projection.kind !== 'none'
  const keptPerGroup = hitsKeptPerGroup(group.maxPerGroup)
  const docIdsRead = (entry: WireGroupEntry): string[] =>
    (reduce === undefined ? entry.scored.slice(0, keptPerGroup) : entry.scored).map(scored => scored.docId)

  const results: GroupResult[] = []
  let batch: WireGroupEntry[] = []
  let batchDocIds = new Set<string>()

  async function assembleBatch(): Promise<void> {
    const documents =
      needsDocuments && batchDocIds.size > 0
        ? await readDistributedDocuments(deps.config, deps.nodeId, deps.engine, indexName, [...batchDocIds], allocation)
        : new Map<string, AnyDocument>()
    for (const entry of batch) results.push(assembleGroup(entry, documents, keptPerGroup, projection, reduce))
    batch = []
    batchDocIds = new Set()
  }

  for (const entry of wireGroups) {
    const docIds = docIdsRead(entry)
    if (batch.length > 0 && batchDocIds.size + docIds.length > MAX_FETCH_DOCUMENT_IDS) await assembleBatch()
    batch.push(entry)
    for (const docId of docIds) batchDocIds.add(docId)
  }
  if (batch.length > 0) await assembleBatch()
  return results
}

function assembleGroup(
  entry: WireGroupEntry,
  documents: Map<string, AnyDocument>,
  keptPerGroup: number,
  projection: ResolvedProjection,
  reduce: GroupReducer | undefined,
): GroupResult {
  const hits: Hit[] = entry.scored.slice(0, keptPerGroup).map(scored => ({
    id: scored.docId,
    score: scored.score ?? undefined,
    document: projectedGroupDocument(documents.get(scored.docId), projection),
  }))
  const result: GroupResult = { values: entry.values, hits }
  if (reduce === undefined) return result
  const folded = foldGroupReducer(
    reduce,
    entry.scored.map(scored => ({ document: documents.get(scored.docId), score: scored.score ?? 0 })),
  )
  if (folded.reducerError !== undefined) {
    result.reducerError = folded.reducerError
  } else {
    result.reduced = folded.reduced
  }
  return result
}

function projectedGroupDocument(document: AnyDocument | undefined, projection: ResolvedProjection): AnyDocument {
  if (document === undefined || projection.kind === 'none') {
    return {}
  }
  return applyProjection(document, projection)
}
