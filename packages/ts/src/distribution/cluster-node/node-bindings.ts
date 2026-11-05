import { bindRerankWindowSource, rerankWindowCapOf } from '../../narsil/internals'
import { bindWriteBlockLookup } from '../../narsil/write-blocks'
import { bindSyncServing, type SyncServing } from '../../server/sync/serving'
import type { ClusterCoordinator } from '../coordinator/types'
import type { ClusterLocalEngine } from './local-engine'
import { findWriteBlock, type NodeMemoryView } from './memory/write-block'
import { routableAllocation } from './routable-allocation'

export interface NodeBindingSources {
  coordinator: ClusterCoordinator
  engine: ClusterLocalEngine
  memoryView: NodeMemoryView
  syncServing: () => SyncServing
}

export function bindNodeSources(node: object, sources: NodeBindingSources): void {
  bindWriteBlockLookup(node, async indexName => {
    const table = await routableAllocation(sources.coordinator, indexName).catch(() => null)
    return table === null ? null : findWriteBlock(table, sources.memoryView)
  })
  bindRerankWindowSource(node, () => rerankWindowCapOf(sources.engine))
  bindSyncServing(node, sources.syncServing)
}
