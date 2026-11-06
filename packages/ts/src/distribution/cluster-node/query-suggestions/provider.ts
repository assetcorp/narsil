import type { QuerySuggestions } from '../../../types/query-suggestions'
import type { ClusterNodeConfig } from '../types'
import { requestClusterBuild } from './build-request'
import type { ClusterSuggestionView } from './view'

export interface ClusterProviderDeps {
  config: ClusterNodeConfig
  nodeId: string
  view: ClusterSuggestionView
  isController(): boolean
  guard(): void
}

export function clusterQuerySuggestions(deps: ClusterProviderDeps, base: QuerySuggestions): QuerySuggestions {
  async function afterRefresh<T>(indexName: string, work: () => Promise<T>): Promise<T> {
    await deps.view.refresh(indexName)
    return work()
  }

  return {
    ...base,
    async recordQuery(indexName, query) {
      if (deps.view.get(indexName) === null) await deps.view.refresh(indexName)
      return base.recordQuery(indexName, query)
    },
    updateSetting: (indexName, setting) => afterRefresh(indexName, () => base.updateSetting(indexName, setting)),
    status: indexName => afterRefresh(indexName, () => base.status(indexName)),
    build: indexName =>
      afterRefresh(indexName, () =>
        deps.isController()
          ? base.build(indexName)
          : requestClusterBuild({ config: deps.config, nodeId: deps.nodeId, guard: deps.guard }, indexName),
      ),
    preview: (indexName, limit) => afterRefresh(indexName, () => base.preview(indexName, limit)),
    bans: indexName => afterRefresh(indexName, () => base.bans(indexName)),
    updateBans: (indexName, phrases) => afterRefresh(indexName, () => base.updateBans(indexName, phrases)),
    removeQuery: (indexName, query) => afterRefresh(indexName, () => base.removeQuery(indexName, query)),
    addSuggestion: (indexName, suggestion) => afterRefresh(indexName, () => base.addSuggestion(indexName, suggestion)),
  }
}
