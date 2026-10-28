import { projectionKeepsField } from '../../core/projection'
import { ErrorCodes, NarsilError } from '../../errors'
import { rerankTextOf } from '../../rerank/params'
import { runRerankedQuery } from '../../rerank/pipeline'
import type { QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import { now } from '../validation'
import { applyHighlights } from './highlight'
import type { QueryContext } from './shared'

type FirstStage<T> = (params: QueryParams, context: QueryContext) => Promise<QueryResult<T>>

export async function executeRerankedQuery<T = AnyDocument>(
  request: QueryParams,
  context: QueryContext,
  firstStage: FirstStage<T>,
): Promise<QueryResult<T>> {
  const startTime = now()
  const runner = context.rerank
  if (runner === undefined) {
    throw new NarsilError(ErrorCodes.RERANK_CONFIG_INVALID, 'This search path holds no rerank adapters')
  }
  const { manager } = context
  const result = await runRerankedQuery<T>(request, {
    schema: context.config.schema,
    maxWindow: runner.maxWindow,
    binding: context.cursorBinding,
    clampsPins: true,
    fusesRankings: params =>
      params.vector !== undefined &&
      (params.mode === 'hybrid' || (params.term !== undefined && params.term.trim().length > 0)),
    firstStage: params => firstStage(params, context),
    async texts(docIds, fields) {
      return docIds.map(docId => rerankTextOf(manager.fieldValues(docId, fields)))
    },
    async storedPins(docIds) {
      return new Set(docIds.filter(docId => manager.getRef(docId) !== undefined))
    },
    score: (adapter, query, documents) => runner.score(adapter, query, documents),
    async fillDocuments(hits, groups, projection) {
      const read = (docId: string): AnyDocument =>
        projection.kind === 'none' ? {} : (manager.get(docId, projection) ?? {})
      for (const hit of hits) hit.document = read(hit.id) as T
      for (const group of groups ?? []) {
        for (const hit of group.hits) hit.document = read(hit.id)
      }
    },
    highlight(page, projection) {
      const fields = request.highlight?.fields ?? []
      const dropped = fields.some(field => !projectionKeepsField(projection, field))
      const readStoredDocument = dropped
        ? (docId: string): Record<string, unknown> | undefined => manager.get(docId, { kind: 'full' })
        : undefined
      applyHighlights(page, request, context.language, manager.analysis, manager.schema, readStoredDocument)
    },
  })
  result.elapsed = now() - startTime
  return result
}
