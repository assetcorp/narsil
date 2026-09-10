import { projectionKeepsField, resolveProjection } from '../../core/projection'
import { executeListDocuments } from '../../engine/list-documents'
import { executePreflight, executeQuery } from '../../engine/query'
import { executeSuggest } from '../../engine/suggest'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { extractVectorFieldsFromSchema } from '../../schema/validator'
import { queryBindingOf } from '../../search/cursor-binding'
import type { ListResult, PreflightResult, QueryResult, SuggestResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../../types/search'
import type { DirectExecutorExtensions, IndexQueryContext } from '../../workers/direct-executor'
import type { ReadEngine } from '../handlers/document-reads'
import { managerWithHeldVectors } from './held-vectors'
import type { RelayClient } from './relay-client'

/**
 * A request thread answers these reads from its own copy, and the tests here
 * say whether a request stays on the thread at all.
 *
 * @internal
 */
export interface ThreadReadEngine extends ReadEngine {
  holdsCopyOf(indexName: string): boolean
  /** Reports whether the thread holds every vector field of the index, so that a document it reads comes back whole. */
  holdsDocumentsOf(indexName: string): boolean
  /** Reports whether the thread answers a query from its own copy, which it does once it holds every vector field the response includes. */
  canAnswer(indexName: string, params: QueryParams): boolean
  /** Reports whether the thread counts a query's matches from its own copy, which it does while it holds no vector field, since a count includes no document. */
  canCount(indexName: string, params: QueryParams): boolean
}

export interface ThreadReadEngineOptions {
  executor: DirectExecutorExtensions
  relay: RelayClient
  /** A plugin observes searches on the main thread when this reads true, so every search goes to the main thread. */
  searchHooks: boolean
}

export function createThreadReadEngine(options: ThreadReadEngineOptions): ThreadReadEngine {
  const { executor, relay, searchHooks } = options

  function vectorFieldsOf(context: IndexQueryContext): string[] {
    return [...extractVectorFieldsFromSchema(context.config.schema).keys()]
  }

  function holdsEveryVectorField(indexName: string, context: IndexQueryContext): boolean {
    return vectorFieldsOf(context).every(fieldPath => executor.holdsVectorField(indexName, fieldPath))
  }

  function holdsEveryVectorFieldRead(indexName: string, context: IndexQueryContext, params: QueryParams): boolean {
    if (params.document === false) return true
    const projection = resolveProjection(params.document === true ? undefined : params.document)
    return vectorFieldsOf(context).every(
      fieldPath => !projectionKeepsField(projection, fieldPath) || executor.holdsVectorField(indexName, fieldPath),
    )
  }

  function managerOf(indexName: string, context: IndexQueryContext): PartitionManager {
    const fieldPaths = vectorFieldsOf(context)
    if (fieldPaths.length === 0) return context.manager
    return managerWithHeldVectors(context.manager, fieldPaths, (fieldPath, docId) =>
      executor.heldVectorOf(indexName, fieldPath, docId),
    )
  }

  function requireContext(indexName: string): IndexQueryContext {
    const context = executor.queryContextOf(indexName)
    if (context === undefined) {
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `This thread holds no copy of index "${indexName}"`, {
        indexName,
      })
    }
    relay.touch(indexName)
    return context
  }

  function requireWholeDocuments(indexName: string): { context: IndexQueryContext; manager: PartitionManager } {
    const context = requireContext(indexName)
    if (!holdsEveryVectorField(indexName, context)) {
      throw new NarsilError(ErrorCodes.INDEX_NOT_FOUND, `This thread holds no vectors of index "${indexName}" yet`, {
        indexName,
      })
    }
    return { context, manager: managerOf(indexName, context) }
  }

  async function resolvedParams(indexName: string, params: QueryParams): Promise<QueryParams> {
    if (params.vector?.text === undefined) return params
    const value = await relay.embed(indexName, params.vector)
    const { text: _text, ...vector } = params.vector
    return { ...params, vector: { ...vector, value } }
  }

  function holdsDocumentsOf(indexName: string): boolean {
    const context = executor.queryContextOf(indexName)
    return context !== undefined && holdsEveryVectorField(indexName, context)
  }

  function searchableContext(indexName: string, params: QueryParams): IndexQueryContext | null {
    if (searchHooks) return null
    const context = executor.queryContextOf(indexName)
    if (context === undefined) return null
    const field = params.vector?.field
    if (field === undefined) return context
    const vectorFields = extractVectorFieldsFromSchema(context.config.schema)
    if (!vectorFields.has(field)) return context
    return context.vectorSearchers.has(field) ? context : null
  }

  function canAnswer(indexName: string, params: QueryParams): boolean {
    const context = searchableContext(indexName, params)
    return context !== null && holdsEveryVectorFieldRead(indexName, context, params)
  }

  function canCount(indexName: string, params: QueryParams): boolean {
    return searchableContext(indexName, params) !== null
  }

  return {
    holdsCopyOf: indexName => executor.queryContextOf(indexName) !== undefined,
    holdsDocumentsOf,
    canAnswer,
    canCount,
    async query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>> {
      const { context, manager } = requireWholeDocuments(indexName)
      const result = await executeQuery<T>(await resolvedParams(indexName, params), {
        manager,
        language: context.language,
        config: context.config,
        indexName,
        cursorBinding: queryBindingOf(params),
        vectorSearchers: context.vectorSearchers,
      })
      if (context.analysisStale) result.analysisStale = true
      return result
    },
    async preflight(indexName: string, params: QueryParams): Promise<PreflightResult> {
      const context = requireContext(indexName)
      const result = await executePreflight(await resolvedParams(indexName, params), {
        manager: context.manager,
        language: context.language,
        config: context.config,
        indexName,
        cursorBinding: queryBindingOf(params),
        vectorSearchers: context.vectorSearchers,
      })
      if (context.analysisStale) result.analysisStale = true
      return result
    },
    async suggest(indexName: string, params: SuggestParams): Promise<SuggestResult> {
      const context = requireContext(indexName)
      const result = executeSuggest(context.manager, context.language, params)
      if (context.analysisStale) result.analysisStale = true
      return result
    },
    async get(indexName: string, docId: string): Promise<AnyDocument | undefined> {
      return requireWholeDocuments(indexName).manager.get(docId)
    },
    async getMultiple(indexName: string, docIds: string[]): Promise<Map<string, AnyDocument>> {
      const { manager } = requireWholeDocuments(indexName)
      const found = new Map<string, AnyDocument>()
      for (const docId of docIds) {
        const document = manager.get(docId)
        if (document !== undefined) found.set(docId, document)
      }
      return found
    },
    async has(indexName: string, docId: string): Promise<boolean> {
      return requireContext(indexName).manager.has(docId)
    },
    async countDocuments(indexName: string): Promise<number> {
      return requireContext(indexName).manager.countDocuments()
    },
    async listDocuments<T = AnyDocument>(indexName: string, params?: ListParams): Promise<ListResult<T>> {
      const { context, manager } = requireWholeDocuments(indexName)
      return executeListDocuments<T>(params ?? {}, { manager, schema: context.config.schema })
    },
  }
}
