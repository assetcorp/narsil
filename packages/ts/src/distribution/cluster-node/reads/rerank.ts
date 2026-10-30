import type { getNestedValue } from '../../../core/partition/utils'
import type { applyProjection } from '../../../core/projection'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { engineCoreOf } from '../../../narsil/internals'
import { rerankOnHost } from '../../../rerank/call'
import type { RuntimeHost } from '../../../rerank/host'
import { rerankTextOf } from '../../../rerank/params'
import { runRerankedQuery } from '../../../rerank/pipeline'
import type { queryBindingOf } from '../../../search/cursor-binding'
import type { QueryResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import type { ClusterReadDeps } from './scatter'

export interface ClusterRerankHost extends RuntimeHost {
  engineCoreOf: typeof engineCoreOf
  queryBindingOf: typeof queryBindingOf
  getNestedValue: typeof getNestedValue
  applyProjection: typeof applyProjection
}

type ReadDocuments = (docIds: string[], last: boolean) => Promise<Map<string, AnyDocument>>

export async function rerankClusterQuery<T>(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
  firstStage: (params: QueryParams) => Promise<QueryResult<T>>,
  readDocuments: ReadDocuments,
  host: ClusterRerankHost,
): Promise<QueryResult<T>> {
  const startTime = host.now()
  const core = host.engineCoreOf(deps.engine)
  if (core === undefined) {
    throw new NarsilError(ErrorCodes.RERANK_CONFIG_INVALID, 'This cluster node holds no rerank adapters')
  }
  const schema = await deps.config.coordinator.getSchema(indexName)
  if (schema === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" does not exist`, { indexName })
  }
  const result = await runRerankedQuery<T>(params, {
    host,
    schema,
    maxWindow: core.rerankSettings.maxWindow,
    binding: () => host.queryBindingOf(params),
    clampsPins: false,
    fusesRankings: request => request.vector !== undefined && (request.term !== undefined || request.mode === 'hybrid'),
    firstStage,
    async texts(docIds, fields) {
      const documents = await readDocuments(docIds, false)
      return docIds.map(docId => {
        const document = documents.get(docId)
        return document === undefined ? '' : rerankTextOf(fields.map(field => host.getNestedValue(document, field)))
      })
    },
    async storedPins(docIds) {
      return new Set((await readDocuments(docIds, false)).keys())
    },
    score: (adapter, query, documents) => rerankOnHost(core, adapter, query, documents),
    async fillDocuments(hits, groups, projection) {
      const grouped = (groups ?? []).flatMap(group => group.hits)
      if (projection.kind === 'none') {
        for (const hit of hits) hit.document = {} as T
        for (const hit of grouped) hit.document = {}
        return
      }
      const documents = await readDocuments([...hits.map(hit => hit.id), ...grouped.map(hit => hit.id)], true)
      const read = (docId: string): AnyDocument => {
        const document = documents.get(docId)
        return document === undefined ? {} : host.applyProjection(document, projection)
      }
      for (const hit of hits) hit.document = read(hit.id) as T
      for (const hit of grouped) hit.document = read(hit.id)
    },
  })
  result.elapsed = host.now() - startTime
  return result
}
