import { resolveIndexAnalysis } from '../../../analysis/registry'
import { changesNotEnabled } from '../../../changes/cursor'
import { createDocumentTest, validChangeFilter } from '../../../changes/filter-test'
import type { ChangeSource } from '../../../changes/source'
import { getVectorFieldPaths } from '../../../engine/vector-fields'
import { getLanguage } from '../../../languages/registry'
import { resolvePartitionInsertOptions } from '../../../partitioning/insert-options'
import { validateSchema } from '../../../schema/validator'
import type { FeedSource } from '../../../sync/feed/source'
import { getClusterIndexConfig } from '../../cluster/index-metadata'
import type { ClusterCoordinator } from '../../coordinator/types'
import { changesStateOfSettings } from './state'
import type { DeviceSyncView } from './view'

export interface ClusterChangeSourceDeps {
  feed: FeedSource
  view: DeviceSyncView
  coordinator: ClusterCoordinator
}

export function createClusterChangeSource(deps: ClusterChangeSourceDeps): ChangeSource {
  const { feed, view, coordinator } = deps
  return {
    changesState(indexName) {
      const held = view.held(indexName)
      const state = changesStateOfSettings(held?.settings)
      if (held === undefined || state === null) return null
      return {
        epoch: state.epoch,
        partitionCount: held.serving.partitionCount,
        previousDocument: state.previousDocument,
      }
    },

    async documentTest(indexName, filter) {
      const held = view.held(indexName)
      if (held === undefined) throw changesNotEnabled(indexName)
      const { servingName } = held.serving
      const stored = await coordinator.getSchema(servingName)
      if (stored === null) throw changesNotEnabled(indexName)
      const schema = validateSchema(stored)
      const valid = validChangeFilter(filter, schema)
      const config = await getClusterIndexConfig(coordinator, servingName, schema)
      return createDocumentTest(
        {
          schema,
          language: getLanguage(config.language ?? 'english'),
          insertOptions: resolvePartitionInsertOptions(config, resolveIndexAnalysis(config)),
          vectorFieldPaths: getVectorFieldPaths(schema),
        },
        valid,
      )
    },

    bounds: (indexName, partitionId, freshness) => feed.bounds(indexName, partitionId, freshness),
    read: (indexName, partitionId, afterSeqNo, upToSeqNo, maxBytes) =>
      feed.read(indexName, partitionId, afterSeqNo, upToSeqNo, maxBytes),
    bytesBehind: (indexName, seqNos) => feed.bytesBehind(indexName, seqNos),
    pendingBeyondHead: (indexName, partitionId, head) => feed.pendingBeyondHead(indexName, partitionId, head),
    listen: onChange => feed.listen(onChange),
    watchIndex: indexName => feed.watchIndex?.(indexName) ?? (() => undefined),
  }
}
