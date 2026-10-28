import { getNestedValue } from '../../../core/partition/utils'
import { applyProjection } from '../../../core/projection'
import { now } from '../../../engine/validation'
import { ErrorCodes, NarsilError } from '../../../errors'
import { engineCoreOf } from '../../../narsil/internals'
import { rerankOnHost } from '../../../rerank/call'
import { rerankTextOf } from '../../../rerank/params'
import { runRerankedQuery } from '../../../rerank/pipeline'
import { queryBindingOf } from '../../../search/cursor-binding'
import type { QueryResult } from '../../../types/results'
import type { AnyDocument } from '../../../types/schema'
import type { QueryParams } from '../../../types/search'
import type { ClusterReadDeps } from './scatter'

type ReadDocuments = (docIds: string[]) => Promise<Map<string, AnyDocument>>

export async function rerankClusterQuery<T>(
  deps: ClusterReadDeps,
  indexName: string,
  params: QueryParams,
  firstStage: (params: QueryParams) => Promise<QueryResult<T>>,
  readDocuments: ReadDocuments,
): Promise<QueryResult<T>> {
  const startTime = now()
  const core = engineCoreOf(deps.engine)
  if (core === undefined) {
    throw new NarsilError(ErrorCodes.RERANK_CONFIG_INVALID, 'This cluster node holds no rerank adapters')
  }
  const schema = await deps.config.coordinator.getSchema(indexName)
  if (schema === null) {
    throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `Index "${indexName}" does not exist`, { indexName })
  }
  const result = await runRerankedQuery<T>(params, {
    schema,
    maxWindow: core.rerankSettings.maxWindow,
    binding: queryBindingOf(params),
    clampsPins: false,
    fusesRankings: request => request.vector !== undefined && (request.term !== undefined || request.mode === 'hybrid'),
    firstStage,
    async texts(docIds, fields) {
      const documents = await readDocuments(docIds)
      return docIds.map(docId => {
        const document = documents.get(docId)
        return document === undefined ? '' : rerankTextOf(fields.map(field => getNestedValue(document, field)))
      })
    },
    async storedPins(docIds) {
      return new Set((await readDocuments(docIds)).keys())
    },
    score: (adapter, query, documents) => rerankOnHost(core, adapter, query, documents),
    async fillDocuments(hits, groups, projection) {
      const grouped = (groups ?? []).flatMap(group => group.hits)
      if (projection.kind === 'none') {
        for (const hit of hits) hit.document = {} as T
        for (const hit of grouped) hit.document = {}
        return
      }
      const documents = await readDocuments([...hits.map(hit => hit.id), ...grouped.map(hit => hit.id)])
      const read = (docId: string): AnyDocument => {
        const document = documents.get(docId)
        return document === undefined ? {} : applyProjection(document, projection)
      }
      for (const hit of hits) hit.document = read(hit.id) as T
      for (const hit of grouped) hit.document = read(hit.id)
    },
  })
  result.elapsed = now() - startTime
  return result
}
