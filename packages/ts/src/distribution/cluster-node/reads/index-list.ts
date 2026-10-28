import { ErrorCodes, NarsilError } from '../../../errors'
import type { IndexInfo, IndexStats } from '../../../types/results'
import { statsCluster } from './counts'
import type { ClusterReadDeps } from './scatter'

async function statsOfListedIndex(deps: ClusterReadDeps, indexName: string): Promise<IndexStats | null> {
  try {
    return await statsCluster(deps, indexName)
  } catch (error) {
    if (error instanceof NarsilError && error.code === ErrorCodes.INDEX_NOT_FOUND) return null
    throw error
  }
}

export async function listIndexesCluster(deps: ClusterReadDeps): Promise<IndexInfo[]> {
  const held = new Map(deps.engine.listIndexes().map(index => [index.name, index]))
  const names = await deps.config.coordinator.listSchemas()
  const described = await Promise.all(names.map(name => statsOfListedIndex(deps, name)))
  const listed: IndexInfo[] = []
  names.forEach((name, position) => {
    const stats = described[position]
    if (stats === null || stats === undefined) return
    const local = held.get(name)
    listed.push({
      name,
      documentCount: stats.documentCount,
      partitionCount: stats.partitionCount,
      language: stats.language,
      ...(local?.analysisStale === true ? { analysisStale: true } : {}),
      state: local?.state ?? 'open',
      reopenCount: local?.reopenCount ?? 0,
    })
  })
  return listed
}
