import { executeListDocuments } from '../../engine/list-documents'
import { executePreflight, executeQuery } from '../../engine/query'
import { executeSuggest } from '../../engine/suggest'
import { ErrorCodes, NarsilError } from '../../errors'
import { extractVectorFieldsFromSchema } from '../../schema/validator'
import { queryBindingOf } from '../../search/cursor-binding'
import type { ListResult, PreflightResult, QueryResult, SuggestResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../../types/search'
import type { DirectExecutorExtensions, IndexQueryContext } from '../../workers/direct-executor'
import type { ReadEngine } from '../handlers/document-reads'
import type { RelayClient } from './relay-client'

/**
 * The reads a request thread answers from its own copy, and the test that
 * says whether a query can stay on this thread at all.
 *
 * @internal
 */
export interface ThreadReadEngine extends ReadEngine {
  holdsCopyOf(indexName: string): boolean
  canAnswer(indexName: string, params: QueryParams): boolean
}

export interface ThreadReadEngineOptions {
  executor: DirectExecutorExtensions
  relay: RelayClient
  /** True where a plugin observes searches on the main thread, so no search may answer here. */
  searchHooks: boolean
}

export function createThreadReadEngine(options: ThreadReadEngineOptions): ThreadReadEngine {
  const { executor, relay, searchHooks } = options

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

  async function resolvedParams(indexName: string, params: QueryParams): Promise<QueryParams> {
    if (params.vector?.text === undefined) return params
    const value = await relay.embed(indexName, params.vector)
    const { text: _text, ...vector } = params.vector
    return { ...params, vector: { ...vector, value } }
  }

  function canAnswer(indexName: string, params: QueryParams): boolean {
    if (searchHooks) return false
    const context = executor.queryContextOf(indexName)
    if (context === undefined) return false
    const field = params.vector?.field
    if (field === undefined) return true
    const vectorFields = extractVectorFieldsFromSchema(context.config.schema)
    if (!vectorFields.has(field)) return true
    return context.vectorSearchers.has(field)
  }

  return {
    holdsCopyOf: indexName => executor.queryContextOf(indexName) !== undefined,
    canAnswer,
    async query<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>> {
      const context = requireContext(indexName)
      const result = await executeQuery<T>(await resolvedParams(indexName, params), {
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
      return requireContext(indexName).manager.get(docId)
    },
    async getMultiple(indexName: string, docIds: string[]): Promise<Map<string, AnyDocument>> {
      const { manager } = requireContext(indexName)
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
      const context = requireContext(indexName)
      return executeListDocuments<T>(params ?? {}, { manager: context.manager, schema: context.config.schema })
    },
  }
}
