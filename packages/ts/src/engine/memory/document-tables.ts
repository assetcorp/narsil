import { shardEntryRangeOf } from '#platform/doc-id-tables'
import type { ShardEntryRange } from '../../core/doc-id-tables/types'
import { isCompositePartition } from '../../core/partition/composite'
import type { EngineCore } from '../core'
import { documentChurnOf } from './document-churn'
import { createTableModel, observeTable, type TableModel, tableGrowthBytes } from './table-model'

export type HeldTableSizes = (indexName: string, visit: (partitionId: number, entries: number) => void) => void

export type DocumentTableGrowth = (indexName: string, documents: number, pendingDocuments: number) => number

function plainShapeOf(entries: number): ShardEntryRange {
  return { shards: 1, smallest: entries, largest: entries }
}

export function createDocumentTableGrowth(
  core: Pick<EngineCore, 'executor'>,
  heldTableSizes?: HeldTableSizes,
): DocumentTableGrowth {
  const modelsByIndex = new Map<string, Map<string, TableModel>>()

  return (indexName, documents, pendingDocuments) => {
    const manager = core.executor.getManager(indexName)
    if (manager === undefined || manager === null) {
      modelsByIndex.delete(indexName)
      return 0
    }
    const previous = modelsByIndex.get(indexName)
    const models = new Map<string, TableModel>()
    modelsByIndex.set(indexName, models)
    const churn = documentChurnOf(indexName)
    let bytes = 0

    const measure = (key: string, entries: number, shape: ShardEntryRange, followsRemoves: boolean): void => {
      let model = previous?.get(key)
      if (model === undefined) {
        model = createTableModel(entries, churn, followsRemoves ? churn : Number.POSITIVE_INFINITY, shape)
      } else {
        observeTable(model, entries, churn, shape)
      }
      models.set(key, model)
      if (documents <= 0) return
      bytes +=
        tableGrowthBytes(model, shape, pendingDocuments + documents) - tableGrowthBytes(model, shape, pendingDocuments)
    }

    const located = manager.countDocuments()
    measure('located', located, shardEntryRangeOf(located), true)
    for (const partition of manager.getAllPartitions()) {
      const entries = (isCompositePartition(partition) ? partition.live : partition).count()
      measure(`partition:${partition.partitionId}`, entries, shardEntryRangeOf(entries), true)
    }
    for (const [field, vectorIndex] of manager.getVectorIndexes()) {
      vectorIndex.visitDocumentTables((table, entries, followsRemoves) =>
        measure(`vector:${field}:${table}`, entries, shardEntryRangeOf(entries), followsRemoves),
      )
    }
    heldTableSizes?.(indexName, (partitionId, entries) =>
      measure(`held:${partitionId}`, entries, plainShapeOf(entries), true),
    )
    return bytes
  }
}
