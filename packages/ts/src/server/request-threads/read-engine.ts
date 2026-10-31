import { projectionKeepsField, resolveProjection } from '../../core/projection'
import { executeListDocuments } from '../../engine/list-documents'
import { executePreflight, executeQuery } from '../../engine/query'
import type { RerankRunner } from '../../engine/query/shared'
import { executeSuggest } from '../../engine/suggest'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { withRerankQueryText } from '../../rerank/query-text'
import { extractVectorFieldsFromSchema } from '../../schema/validator'
import { lazyQueryBinding } from '../../search/cursor-binding'
import { holdsQuotedText } from '../../search/phrases'
import type { ListResult, PreflightResult, QueryResult, SuggestResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../../types/search'
import type { DirectExecutorExtensions, IndexQueryContext } from '../../workers/direct-executor'
import type { ReadEngine } from '../handlers/document-reads'
import { managerWithHeldVectors } from './held-vectors'
import { moveClock } from './move-clock'
import type { RelayClient } from './relay-client'

export interface ThreadReadEngine extends ReadEngine {
  holdsCopyOf(indexName: string): boolean
  /** Reports whether the thread holds every vector field of the index, so that a document it reads comes back whole. */
  holdsDocumentsOf(indexName: string): boolean
  /** Reports whether the thread answers a query from its own copy, which it does once it holds every vector field the response includes. */
  canAnswer(indexName: string, params: QueryParams): boolean
  /** Reports whether the thread counts a query's matches from its own copy, which it does while it holds no vector field, since a count includes no document. */
  canCount(indexName: string, params: QueryParams): boolean
  /** Answers a query from the thread's own copy however long it runs. */
  queryHere<T = AnyDocument>(indexName: string, params: QueryParams): Promise<QueryResult<T>>
  /** Counts a query's matches from the thread's own copy however long it runs. */
  preflightHere(indexName: string, params: QueryParams): Promise<PreflightResult>
}

export interface ThreadReadEngineOptions {
  executor: DirectExecutorExtensions
  relay: RelayClient
  /** A plugin observes searches on the main thread when this reads true, so every search goes to the main thread. */
  searchHooks: boolean
  patternWorkCap: number
  maxRerankWindow: number
  /** A search stops once it has run for this many milliseconds, so that its thread can hand it on, or never where it reads undefined. */
  moveAfterMs?: () => number | undefined
}

export function createThreadReadEngine(options: ThreadReadEngineOptions): ThreadReadEngine {
  const { executor, relay, searchHooks, patternWorkCap, maxRerankWindow, moveAfterMs } = options

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

  function heldContext(indexName: string): IndexQueryContext | null {
    return executor.queryContextOf(indexName) ?? null
  }

  function wholeDocumentsContext(indexName: string): IndexQueryContext | null {
    const context = heldContext(indexName)
    return context !== null && holdsEveryVectorField(indexName, context) ? context : null
  }

  function requireAnswerable(indexName: string, context: IndexQueryContext | null): IndexQueryContext {
    if (context === null) {
      throw new NarsilError(
        ErrorCodes.INDEX_NOT_FOUND,
        `This thread holds no copy of index "${indexName}" that answers this request yet`,
        { indexName },
      )
    }
    relay.touch(indexName)
    return context
  }

  function requireWholeDocuments(indexName: string): { context: IndexQueryContext; manager: PartitionManager } {
    const context = requireAnswerable(indexName, wholeDocumentsContext(indexName))
    return { context, manager: managerOf(indexName, context) }
  }

  function rerankRunnerFor(params: QueryParams): RerankRunner | undefined {
    if (params.rerank === undefined) return undefined
    return {
      maxWindow: maxRerankWindow,
      score: (adapter, query, documents) => relay.rerank(adapter, query, documents),
    }
  }

  async function resolvedParams(indexName: string, request: QueryParams): Promise<QueryParams> {
    const params = withRerankQueryText(request)
    if (params.vector?.text === undefined) return params
    const value = await relay.embed(indexName, params.vector)
    const { text: _text, ...vector } = params.vector
    return { ...params, vector: { ...vector, value } }
  }

  function searchableContext(indexName: string, params: QueryParams): IndexQueryContext | null {
    if (searchHooks) return null
    const context = executor.queryContextOf(indexName)
    if (context === undefined) return null
    if (context.analysisStale && params.term !== undefined && holdsQuotedText(params.term)) return null
    const field = params.vector?.field
    if (field === undefined) return context
    const vectorFields = extractVectorFieldsFromSchema(context.config.schema)
    if (!vectorFields.has(field)) return context
    return context.vectorSearchers.has(field) && executor.holdsVectorField(indexName, field) ? context : null
  }

  function answerableContext(indexName: string, params: QueryParams): IndexQueryContext | null {
    const context = searchableContext(indexName, params)
    return context !== null && holdsEveryVectorFieldRead(indexName, context, params) ? context : null
  }

  async function query<T>(
    indexName: string,
    params: QueryParams,
    moveAfter: number | undefined,
  ): Promise<QueryResult<T>> {
    const resolved = await resolvedParams(indexName, params)
    const context = requireAnswerable(indexName, answerableContext(indexName, params))
    const clock = moveAfter === undefined ? undefined : moveClock(moveAfter)
    const result = await executeQuery<T>(resolved, {
      manager: managerOf(indexName, context),
      language: context.language,
      config: context.config,
      indexName,
      cursorBinding: lazyQueryBinding(params, clock),
      vectorSearchers: context.vectorSearchers,
      patternWorkCap,
      clock,
      rerank: rerankRunnerFor(params),
    })
    if (context.analysisStale) result.analysisStale = true
    return result
  }

  async function preflight(
    indexName: string,
    params: QueryParams,
    moveAfter: number | undefined,
  ): Promise<PreflightResult> {
    const resolved = await resolvedParams(indexName, params)
    const context = requireAnswerable(indexName, searchableContext(indexName, params))
    const clock = moveAfter === undefined ? undefined : moveClock(moveAfter)
    const result = await executePreflight(resolved, {
      manager: context.manager,
      language: context.language,
      config: context.config,
      indexName,
      cursorBinding: lazyQueryBinding(params, clock),
      vectorSearchers: context.vectorSearchers,
      patternWorkCap,
      clock,
    })
    if (context.analysisStale) result.analysisStale = true
    return result
  }

  return {
    holdsCopyOf: indexName => heldContext(indexName) !== null,
    holdsDocumentsOf: indexName => wholeDocumentsContext(indexName) !== null,
    canAnswer: (indexName, params) => answerableContext(indexName, params) !== null,
    canCount: (indexName, params) => searchableContext(indexName, params) !== null,
    query: <T = AnyDocument>(indexName: string, params: QueryParams) => query<T>(indexName, params, moveAfterMs?.()),
    queryHere: <T = AnyDocument>(indexName: string, params: QueryParams) => query<T>(indexName, params, undefined),
    preflight: (indexName: string, params: QueryParams) => preflight(indexName, params, moveAfterMs?.()),
    preflightHere: (indexName: string, params: QueryParams) => preflight(indexName, params, undefined),
    async suggest(indexName: string, params: SuggestParams): Promise<SuggestResult> {
      const context = requireAnswerable(indexName, heldContext(indexName))
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
      return requireAnswerable(indexName, heldContext(indexName)).manager.has(docId)
    },
    async countDocuments(indexName: string): Promise<number> {
      return requireAnswerable(indexName, heldContext(indexName)).manager.countDocuments()
    },
    async listDocuments<T = AnyDocument>(indexName: string, params?: ListParams): Promise<ListResult<T>> {
      const { context, manager } = requireWholeDocuments(indexName)
      return executeListDocuments<T>(params ?? {}, {
        manager,
        schema: context.config.schema,
        strict: context.config.strict,
        patternWorkCap,
      })
    },
  }
}
