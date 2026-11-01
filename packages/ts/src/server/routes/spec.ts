import type { RouteHandler, RouteOptions } from '../request'
import type { HttpWireTypeName } from '../types'

export interface ServerHandlers {
  livez: RouteHandler
  readyz: RouteHandler
  version: RouteHandler
  capabilities: RouteHandler
  clusterTopology: RouteHandler
  clusterAllocation: RouteHandler
  clusterReplicationFactor: RouteHandler
  clusterHealth: RouteHandler
  metrics: RouteHandler
  memory: RouteHandler
  listTasks: RouteHandler
  getTask: RouteHandler
  cancelTask: RouteHandler
  createIndex: RouteHandler
  listIndexes: RouteHandler
  dropIndex: RouteHandler
  indexStats: RouteHandler
  indexPartitions: RouteHandler
  clearIndex: RouteHandler
  openIndex: RouteHandler
  closeIndex: RouteHandler
  insert: RouteHandler
  batch: RouteHandler
  importNdjson: RouteHandler
  put: RouteHandler
  patch: RouteHandler
  remove: RouteHandler
  waitForWrites: RouteHandler
  search: RouteHandler
  preflight: RouteHandler
  suggest: RouteHandler
  get: RouteHandler
  exists: RouteHandler
  count: RouteHandler
  list: RouteHandler
  multiGet: RouteHandler
  checkpoint: RouteHandler
  rebuildAnalysis: RouteHandler
  changeAnalysis: RouteHandler
  snapshot: RouteHandler
  vectorMaintenance: RouteHandler
  compact: RouteHandler
  optimize: RouteHandler
  rebalance: RouteHandler
  partitionConfig: RouteHandler
  readSynonyms: RouteHandler
  replaceSynonyms: RouteHandler
  updateBm25: RouteHandler
  restore: RouteHandler
  exportDocuments: RouteHandler
  importExport: RouteHandler
}

export type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'del'

export type RouteTag = 'Server' | 'Cluster' | 'Tasks' | 'Indexes' | 'Documents' | 'Search' | 'Maintenance'

export interface RawContent {
  contentType: string
}

export interface OptionalJsonBody {
  optional: HttpWireTypeName
}

export type RouteRequestBody = HttpWireTypeName | OptionalJsonBody | RawContent | null

export type RouteResponseBody = HttpWireTypeName | RawContent

export interface RouteSpec {
  method: RouteMethod
  path: string
  handler: keyof ServerHandlers
  options: RouteOptions
  operationId: string
  summary: string
  tags: readonly [RouteTag, ...RouteTag[]]
  request: RouteRequestBody
  query?: HttpWireTypeName
  responses: Readonly<Record<number, RouteResponseBody>>
  repeatable?: true
}
