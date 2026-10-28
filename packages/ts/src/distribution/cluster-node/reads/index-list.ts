import { ErrorCodes, NarsilError } from '../../../errors'
import type { IndexInfo, IndexStats } from '../../../types/results'
import { isHiddenGeneration } from '../../cluster/rebalance/records'
import { servingNameOf } from '../generation-routing'
import { statsCluster } from './counts'
import type { ClusterReadDeps } from './scatter'

interface ListedIndex {
  servingName: string
  stats: IndexStats
}

async function statsOfListedIndex(deps: ClusterReadDeps, indexName: string): Promise<ListedIndex | null> {
  try {
    const servingName = await servingNameOf(deps.config.coordinator, indexName)
    return { servingName, stats: await statsCluster(deps, servingName) }
  } catch (error) {
    if (error instanceof NarsilError && error.code === ErrorCodes.INDEX_NOT_FOUND) return null
    throw error
  }
}

export async function listIndexesCluster(deps: ClusterReadDeps): Promise<IndexInfo[]> {
  const held = new Map(deps.engine.listIndexes().map(index => [index.name, index]))
  const names = (await deps.config.coordinator.listSchemas()).filter(name => !isHiddenGeneration(name))
  const described = await Promise.all(names.map(name => statsOfListedIndex(deps, name)))
  const listed: IndexInfo[] = []
  names.forEach((name, position) => {
    const entry = described[position]
    if (entry === null || entry === undefined) return
    const local = held.get(entry.servingName)
    listed.push({
      name,
      documentCount: entry.stats.documentCount,
      partitionCount: entry.stats.partitionCount,
      language: entry.stats.language,
      ...(local?.analysisStale === true ? { analysisStale: true } : {}),
      state: local?.state ?? 'open',
      reopenCount: local?.reopenCount ?? 0,
    })
  })
  return listed
}
