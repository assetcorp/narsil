import type { QueryResult } from './results'
import type { AnyDocument, IndexConfig } from './schema'
import type { QueryParams } from './search'

export interface NarsilPlugin {
  name: string
  beforeInsert?(ctx: InsertContext): void | Promise<void>
  afterInsert?(ctx: InsertContext): void | Promise<void>
  beforeRemove?(ctx: RemoveContext): void | Promise<void>
  afterRemove?(ctx: RemoveContext): void | Promise<void>
  beforeUpdate?(ctx: UpdateContext): void | Promise<void>
  afterUpdate?(ctx: UpdateContext): void | Promise<void>
  beforeSearch?(ctx: SearchContext): void | Promise<void>
  afterSearch?(ctx: SearchContext): void | Promise<void>
  onIndexCreate?(ctx: IndexContext): void | Promise<void>
  onIndexDrop?(ctx: IndexContext): void | Promise<void>
  onPartitionSplit?(ctx: PartitionContext): void | Promise<void>
  onWorkerPromote?(ctx: WorkerContext): void | Promise<void>
}

export interface InsertContext {
  indexName: string
  docId: string
  document: AnyDocument
}

export interface RemoveContext {
  indexName: string
  docId: string
}

export interface UpdateContext {
  indexName: string
  docId: string
  oldDocument: AnyDocument
  newDocument: AnyDocument
}

export interface SearchContext {
  indexName: string
  params: QueryParams
  results?: QueryResult
}

export interface IndexContext {
  indexName: string
  config: IndexConfig
}

export interface PartitionContext {
  indexName: string
  oldPartitionCount: number
  newPartitionCount: number
}

export interface WorkerContext {
  workerCount: number
  reason: string
}
