import { encode } from '@msgpack/msgpack'
import { fnv1a } from '../core/hash'
import type { ReplicationOperation } from '../distribution/replication/types'
import { VERSION } from '../index'
import { createDurabilityManager, type DurabilityManager } from '../persistence/durability'
import type { IndexDurabilityHooks } from '../persistence/durability/types'
import type { DurabilityConfig } from '../types/config'
import type { IndexMetadata } from '../types/internal'
import type { AnyDocument } from '../types/schema'

export interface DurableWrite {
  indexName: string
  partitionId: number
  seqNo: number
}

export interface DurabilityIntegration {
  manager: DurabilityManager
  recordInsertOrUpdate(indexName: string, docId: string, document: AnyDocument): Promise<DurableWrite>
  recordRemove(indexName: string, docId: string): Promise<DurableWrite>
  confirmApplied(write: DurableWrite): void
}

export interface DurabilityIntegrationHooks {
  getManager: IndexDurabilityHooks['getManager']
  getVectorFieldPaths: IndexDurabilityHooks['getVectorFieldPaths']
  getVectorIndexes: IndexDurabilityHooks['getVectorIndexes']
  getIndexConfig: (
    indexName: string,
  ) => { schema: Record<string, string>; language: string; k1: number; b: number } | undefined
  createIndexFromMetadata: IndexDurabilityHooks['createIndexFromMetadata']
  onFatalError: IndexDurabilityHooks['onFatalError']
}

function buildMetadata(indexName: string, hooks: DurabilityIntegrationHooks): IndexMetadata | undefined {
  const config = hooks.getIndexConfig(indexName)
  const manager = hooks.getManager(indexName)
  if (config === undefined || manager === undefined) {
    return undefined
  }
  return {
    indexName,
    schema: config.schema,
    language: config.language,
    partitionCount: manager.partitionCount,
    bm25Params: { k1: config.k1, b: config.b },
    createdAt: Date.now(),
    engineVersion: VERSION,
  }
}

export function createDurabilityIntegration(
  config: DurabilityConfig,
  hooks: DurabilityIntegrationHooks,
): DurabilityIntegration {
  const managerHooks: IndexDurabilityHooks = {
    getManager: hooks.getManager,
    getVectorFieldPaths: hooks.getVectorFieldPaths,
    getVectorIndexes: hooks.getVectorIndexes,
    buildMetadata: indexName => buildMetadata(indexName, hooks),
    createIndexFromMetadata: hooks.createIndexFromMetadata,
    onFatalError: hooks.onFatalError,
  }

  const manager = createDurabilityManager(config, managerHooks)

  function partitionFor(indexName: string, docId: string): number {
    const partitionManager = hooks.getManager(indexName)
    const partitionCount = partitionManager?.partitionCount ?? 1
    return fnv1a(docId) % Math.max(1, partitionCount)
  }

  async function recordMutation(
    indexName: string,
    docId: string,
    operation: ReplicationOperation,
    document: Uint8Array | null,
  ): Promise<DurableWrite> {
    const partitionId = partitionFor(indexName, docId)
    const seqNo = await manager.recordMutation({
      indexName,
      partitionId,
      operation,
      documentId: docId,
      document,
    })
    return { indexName, partitionId, seqNo }
  }

  return {
    manager,
    recordInsertOrUpdate(indexName: string, docId: string, document: AnyDocument): Promise<DurableWrite> {
      return recordMutation(indexName, docId, 'INDEX', encode(document))
    },
    recordRemove(indexName: string, docId: string): Promise<DurableWrite> {
      return recordMutation(indexName, docId, 'DELETE', null)
    },
    confirmApplied(write: DurableWrite): void {
      manager.markApplied(write.indexName, write.partitionId, write.seqNo)
    },
  }
}
