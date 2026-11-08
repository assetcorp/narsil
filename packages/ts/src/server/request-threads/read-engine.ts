import { projectionKeepsField, resolveProjection } from '../../core/projection'
import { importOptionalReads } from '../../engine/optional-reads-code'
import { executePreflight, executeQuery, loadQueryCode } from '../../engine/query'
import { loadRerankRuntime } from '../../engine/query/fixed-depth-code'
import type { RerankRunner } from '../../engine/query/shared'
import { answerFromOneState } from '../../engine/query/state'
import { ErrorCodes, NarsilError } from '../../errors'
import type { PartitionManager } from '../../partitioning/manager'
import { extractVectorFieldsFromSchema } from '../../schema/validator'
import { lazyQueryBinding } from '../../search/cursor-binding'
import { holdsQuotedText } from '../../search/quotes'
import { loadSortingFor } from '../../search/sorting-code'
import { loadedMessagePack, loadMessagePack } from '../../serialization/msgpack-code'
import type { ListResult, PreflightResult, QueryResult, SuggestResult } from '../../types/results'
import type { AnyDocument } from '../../types/schema'
import type { ListParams, QueryParams, SuggestParams } from '../../types/search'
import type { OrdinalAdmission } from '../../vector/admission'
import type { DirectExecutorExtensions, IndexQueryContext } from '../../workers/direct-executor'
import type { HeldFieldPin } from '../../workers/vector-copies'
import type { ReadEngine } from '../handlers/document-reads'
import { admittedSearchers, managerWithHeldVectors } from './held-vectors'
import { moveClock } from './move-clock'
import type { RelayClient } from './relay-client'

export interface ThreadReadEngine extends ReadEngine {
  query<T = AnyDocument>(indexName: string, params: QueryParams, signal?: AbortSignal): Promise<QueryResult<T>>
  preflight(indexName: string, params: QueryParams, signal?: AbortSignal): Promise<PreflightResult>
  holdsCopyOf(indexName: string): boolean
  /** Reports whether the thread holds every vector field of the index, so that a document it reads comes back whole. */
  holdsDocumentsOf(indexName: string): boolean
  /** Reports whether the thread answers a query from its own copy, which it does once it holds every vector field the response includes. */
  canAnswer(indexName: string, params: QueryParams): boolean
  /** Reports whether the thread counts a query's matches from its own copy, which it does while it holds no vector field, since a count includes no document. */
  canCount(indexName: string, params: QueryParams): boolean
  /** Answers a query from the thread's own copy however long it runs. */
  queryHere<T = AnyDocument>(indexName: string, params: QueryParams, signal?: AbortSignal): Promise<QueryResult<T>>
  /** Counts a query's matches from the thread's own copy however long it runs. */
  preflightHere(indexName: string, params: QueryParams, signal?: AbortSignal): Promise<PreflightResult>
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

  function managerOf(
    indexName: string,
    context: IndexQueryContext,
    pins?: ReadonlyMap<string, HeldFieldPin>,
  ): PartitionManager {
    const fieldPaths = vectorFieldsOf(context)
    if (fieldPaths.length === 0) return context.manager
    return managerWithHeldVectors(context.manager, fieldPaths, (fieldPath, docId) => {
      const pin = pins?.get(fieldPath)
      return pin === undefined ? executor.heldVectorOf(indexName, fieldPath, docId) : pin.vectorOf(docId)
    })
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

  function readCopy<T>(
    indexName: string,
    wholeDocuments: boolean,
    read: (manager: PartitionManager, context: IndexQueryContext) => T,
  ): Promise<T> {
    const context = requireAnswerable(
      indexName,
      wholeDocuments ? wholeDocumentsContext(indexName) : heldContext(indexName),
    )
    return context.manager.publication.read(() => {
      const current = currentContext(indexName, context)
      return read(wholeDocuments ? managerOf(indexName, current) : current.manager, current)
    })
  }

  function currentContext(indexName: string, earlier: IndexQueryContext): IndexQueryContext {
    const current = executor.queryContextOf(indexName)
    if (current === undefined || current.manager !== earlier.manager) return requireAnswerable(indexName, null)
    return current
  }

  function rerankRunnerFor(params: QueryParams, signal?: AbortSignal): RerankRunner | undefined {
    if (params.rerank === undefined) return undefined
    return {
      maxWindow: maxRerankWindow,
      score: (adapter, query, documents) => relay.rerank(adapter, query, documents, signal),
    }
  }

  async function resolvedParams(indexName: string, request: QueryParams, signal?: AbortSignal): Promise<QueryParams> {
    signal?.throwIfAborted()
    const params = request.rerank === undefined ? request : (await loadRerankRuntime()).withRerankQueryText(request)
    if (params.vector?.text === undefined) return params
    const value = await relay.embed(indexName, params.vector, signal)
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
    signal?: AbortSignal,
  ): Promise<QueryResult<T>> {
    const resolved = await resolvedParams(indexName, params, signal)
    const loading = loadQueryCode(resolved)
    if (loading !== null) await loading
    const context = requireAnswerable(indexName, answerableContext(indexName, params))
    const clock = moveAfter === undefined ? undefined : moveClock(moveAfter)
    const pins = new Map<string, HeldFieldPin>()
    const manager = managerOf(indexName, context, pins)
    return answerFromOneState(
      manager,
      async attempt => {
        const current = currentContext(indexName, context)
        try {
          for (const fieldPath of current.vectorSearchers.keys()) {
            const pin = executor.pinVectorField(indexName, fieldPath)
            if (pin !== undefined) pins.set(fieldPath, pin)
          }
          const admissions = new Map<string, OrdinalAdmission>()
          for (const [fieldPath, pin] of pins) admissions.set(fieldPath, pin.admission)
          const result = await executeQuery<T>(resolved, {
            manager,
            pin: attempt.pin,
            turns: attempt,
            releaseRetrieval: attempt.releaseRetrieval,
            language: current.language,
            config: current.config,
            indexName,
            cursorBinding: lazyQueryBinding(params, clock),
            vectorSearchers: admittedSearchers(current.vectorSearchers, admissions),
            patternWorkCap,
            clock,
            rerank: rerankRunnerFor(params, signal),
          })
          if (current.analysisStale) result.analysisStale = true
          return result
        } finally {
          for (const pin of pins.values()) pin.release()
        }
      },
      signal,
    )
  }

  async function preflight(
    indexName: string,
    params: QueryParams,
    moveAfter: number | undefined,
    signal?: AbortSignal,
  ): Promise<PreflightResult> {
    const resolved = await resolvedParams(indexName, params, signal)
    const loading = loadQueryCode(resolved)
    if (loading !== null) await loading
    const context = requireAnswerable(indexName, searchableContext(indexName, params))
    const clock = moveAfter === undefined ? undefined : moveClock(moveAfter)
    return answerFromOneState(
      context.manager,
      async attempt => {
        const current = currentContext(indexName, context)
        const pins = new Map<string, HeldFieldPin>()
        try {
          for (const fieldPath of current.vectorSearchers.keys()) {
            const pin = executor.pinVectorField(indexName, fieldPath)
            if (pin !== undefined) pins.set(fieldPath, pin)
          }
          const admissions = new Map<string, OrdinalAdmission>()
          for (const [fieldPath, pin] of pins) admissions.set(fieldPath, pin.admission)
          const result = await executePreflight(resolved, {
            manager: context.manager,
            pin: attempt.pin,
            turns: attempt,
            releaseRetrieval: attempt.releaseRetrieval,
            language: current.language,
            config: current.config,
            indexName,
            cursorBinding: lazyQueryBinding(params, clock),
            vectorSearchers: admittedSearchers(current.vectorSearchers, admissions),
            patternWorkCap,
            clock,
          })
          if (current.analysisStale) result.analysisStale = true
          return result
        } finally {
          for (const pin of pins.values()) pin.release()
        }
      },
      signal,
    )
  }

  return {
    holdsCopyOf: indexName => heldContext(indexName) !== null,
    holdsDocumentsOf: indexName => wholeDocumentsContext(indexName) !== null,
    canAnswer: (indexName, params) => answerableContext(indexName, params) !== null,
    canCount: (indexName, params) => searchableContext(indexName, params) !== null,
    query: <T = AnyDocument>(indexName: string, params: QueryParams, signal?: AbortSignal) =>
      query<T>(indexName, params, moveAfterMs?.(), signal),
    queryHere: <T = AnyDocument>(indexName: string, params: QueryParams, signal?: AbortSignal) =>
      query<T>(indexName, params, undefined, signal),
    preflight: (indexName: string, params: QueryParams, signal?: AbortSignal) =>
      preflight(indexName, params, moveAfterMs?.(), signal),
    preflightHere: (indexName: string, params: QueryParams, signal?: AbortSignal) =>
      preflight(indexName, params, undefined, signal),
    async suggest(indexName: string, params: SuggestParams): Promise<SuggestResult> {
      const { executeSuggest } = await importOptionalReads()
      return readCopy(indexName, false, async (manager, context) => {
        const result = await executeSuggest(manager, context.language, params)
        if (context.analysisStale) result.analysisStale = true
        return result
      })
    },
    async get(indexName: string, docId: string): Promise<AnyDocument | undefined> {
      return readCopy(indexName, true, manager => manager.get(docId))
    },
    async getMultiple(indexName: string, docIds: string[]): Promise<Map<string, AnyDocument>> {
      return readCopy(indexName, true, manager => {
        const found = new Map<string, AnyDocument>()
        for (const docId of docIds) {
          const document = manager.get(docId)
          if (document !== undefined) found.set(docId, document)
        }
        return found
      })
    },
    async has(indexName: string, docId: string): Promise<boolean> {
      return readCopy(indexName, false, manager => manager.has(docId))
    },
    async countDocuments(indexName: string): Promise<number> {
      return readCopy(indexName, false, manager => manager.countDocuments())
    },
    async listDocuments<T = AnyDocument>(indexName: string, params?: ListParams): Promise<ListResult<T>> {
      const { executeListDocuments } = await importOptionalReads()
      const loading = loadSortingFor(params?.sort, params?.filters)
      if (loading !== null) await loading
      if (loading !== null && loadedMessagePack() === null) await loadMessagePack()
      return readCopy(indexName, true, (manager, context) =>
        executeListDocuments<T>(params ?? {}, {
          manager,
          schema: context.config.schema,
          strict: context.config.strict,
          patternWorkCap,
        }),
      )
    },
  }
}
