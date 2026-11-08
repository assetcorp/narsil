import { ErrorCodes, NarsilError } from '../../errors'
import type { HitReads } from '../../partitioning/manager/state-pins'
import type { RuntimeHost } from '../../rerank/host'
import { rerankTextOf } from '../../rerank/params'
import { runRerankedQuery } from '../../rerank/pipeline'
import type { QueryResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { QueryParams } from '../../types/search'
import { applyHighlights } from './highlight'
import type { PinnedQueryContext } from './shared'

type FirstStage<T> = (params: QueryParams, context: PinnedQueryContext) => Promise<QueryResult<T>>

export async function executeRerankedQuery<T = AnyDocument>(
  request: QueryParams,
  context: PinnedQueryContext,
  firstStage: FirstStage<T>,
  host: RuntimeHost,
): Promise<QueryResult<T>> {
  const startTime = host.now()
  const runner = context.rerank
  if (runner === undefined) {
    throw new NarsilError(ErrorCodes.RERANK_CONFIG_INVALID, 'This search path holds no rerank adapters')
  }
  const { manager } = context
  const reads: HitReads = context.pin ?? manager
  const { analysis, schema, synonyms } = manager
  const result = await runRerankedQuery<T>(request, {
    host,
    schema: context.config.schema,
    maxWindow: runner.maxWindow,
    binding: context.cursorBinding,
    clampsPins: true,
    fusesRankings: params =>
      params.vector !== undefined &&
      (params.mode === 'hybrid' || (params.term !== undefined && params.term.trim().length > 0)),
    firstStage: params => firstStage(params, context),
    async texts(docIds, fields) {
      return docIds.map(docId => rerankTextOf(reads.fieldValues(docId, fields)))
    },
    async storedPins(docIds) {
      return new Set(docIds.filter(docId => reads.getRef(docId) !== undefined))
    },
    score: (adapter, query, documents) => {
      context.releaseRetrieval?.()
      return runner.score(adapter, query, documents)
    },
    async fillDocuments(hits, groups, projection) {
      const read = (docId: string): AnyDocument =>
        projection.kind === 'none' ? {} : (reads.get(docId, projection) ?? {})
      for (const hit of hits) hit.document = read(hit.id) as T
      for (const group of groups ?? []) {
        for (const hit of group.hits) hit.document = read(hit.id)
      }
    },
    highlight(page, projection) {
      const fields = request.highlight?.fields ?? []
      const dropped = fields.some(field => !host.projectionKeepsField(projection, field))
      const readStoredDocument = dropped
        ? (docId: string): Record<string, unknown> | undefined => reads.get(docId, { kind: 'full' })
        : undefined
      applyHighlights(page, request, context.language, analysis, schema, readStoredDocument, synonyms)
    },
  })
  result.elapsed = host.now() - startTime
  return result
}
