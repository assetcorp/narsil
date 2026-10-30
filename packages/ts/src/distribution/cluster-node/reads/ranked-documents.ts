import { decode } from '@msgpack/msgpack'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { AnyDocument } from '../../../types/schema'
import type { AllocationTable } from '../../coordinator/types'
import { createFetchMessage, validateFetchResultPayload } from '../../query/codec'
import { type RankingContext, releaseSearchContexts, type SearchContextSet } from '../../query/search-contexts'
import { TransportErrorCodes } from '../../transport/types'
import { FETCH_GROUP_DOCUMENT_IDS } from '../constants'
import { readDocumentsFromCopies, readRejectionOf, refuseDecodeWithoutRoom, sendToNode } from '../node-messaging'
import { documentOfSnapshot } from '../search-contexts'
import { restoreVectorValues } from '../vector-bytes'
import { resolvePartitionId } from '../write-routing'
import type { ClusterReadDeps } from './scatter'

export interface RankedRead {
  last: boolean
  fields: string[] | null
  requireEveryPartition: boolean
}

export interface RankedDocumentReader {
  adopt(contexts: SearchContextSet | undefined): void
  read(docIds: readonly string[], options: RankedRead): Promise<Map<string, AnyDocument>>
  release(): void
}

const NODE_LOSS_CODES: ReadonlySet<unknown> = new Set([
  TransportErrorCodes.CONNECT_FAILED,
  TransportErrorCodes.PEER_UNAVAILABLE,
  TransportErrorCodes.TIMEOUT,
])

function contextLost(context: RankingContext, indexName: string, cause?: NarsilError): NarsilError {
  return new NarsilError(
    ErrorCodes.SEARCH_CONTEXT_MISSING,
    `Node '${context.nodeId}' no longer holds the documents it ranked for a search of index '${indexName}'`,
    { indexName, nodeId: context.nodeId, contextId: context.contextId, ...(cause ? { cause: cause.code } : {}) },
  )
}

function lostContextOf(error: unknown, context: RankingContext, indexName: string): NarsilError | null {
  if (!(error instanceof NarsilError)) return null
  if (error.code === ErrorCodes.SEARCH_CONTEXT_MISSING) return contextLost(context, indexName, error)
  if (NODE_LOSS_CODES.has(error.details.transportCode)) return contextLost(context, indexName, error)
  return null
}

export function createRankedDocumentReader(
  deps: ClusterReadDeps,
  indexName: string,
  allocation: AllocationTable,
): RankedDocumentReader {
  const sources = new Map<string, RankingContext>()
  const open = new Map<string, RankingContext>()
  const partitionCount = allocation.assignments.size

  function releaseQuietly(contexts: readonly RankingContext[]): void {
    const remote: RankingContext[] = []
    for (const context of contexts) {
      open.delete(context.contextId)
      if (context.nodeId === deps.nodeId && deps.searchContexts !== undefined) {
        deps.searchContexts.release(context.contextId)
      } else {
        remote.push(context)
      }
    }
    releaseSearchContexts(indexName, remote, {
      transport: deps.config.transport,
      sourceNodeId: deps.nodeId,
      resolveNodeTargets: deps.resolveNodeTargets,
    })
  }

  function readOwnContext(context: RankingContext, docIds: readonly string[], last: boolean): Map<string, AnyDocument> {
    const registry = deps.searchContexts
    const found = registry?.read(context.contextId, docIds) ?? null
    if (last) {
      registry?.release(context.contextId)
      open.delete(context.contextId)
    }
    if (found === null) throw contextLost(context, indexName)
    const documents = new Map<string, AnyDocument>()
    for (const [docId, snapshot] of found) documents.set(docId, documentOfSnapshot(snapshot))
    return documents
  }

  async function readRemoteContext(
    context: RankingContext,
    docIds: readonly string[],
    last: boolean,
    fields: string[] | null,
  ): Promise<Map<string, AnyDocument>> {
    const documents = new Map<string, AnyDocument>()
    for (let start = 0; start < docIds.length; start += FETCH_GROUP_DOCUMENT_IDS) {
      const chunk = docIds.slice(start, start + FETCH_GROUP_DOCUMENT_IDS)
      const releaseContext = last && start + FETCH_GROUP_DOCUMENT_IDS >= docIds.length
      const message = createFetchMessage(
        {
          indexName,
          documentIds: chunk.map(docId => ({ docId, partitionId: resolvePartitionId(docId, partitionCount) })),
          fields,
          highlight: null,
          contextId: context.contextId,
          releaseContext,
        },
        deps.nodeId,
      )
      let response: Awaited<ReturnType<typeof sendToNode>>
      try {
        response = await sendToNode(deps.config, context.nodeId, message, {
          message: `Node '${context.nodeId}' did not answer a document fetch for index '${indexName}'`,
          details: { indexName },
        })
      } catch (error) {
        throw lostContextOf(error, context, indexName) ?? error
      }
      if (releaseContext) open.delete(context.contextId)
      refuseDecodeWithoutRoom(response.payload)
      const decoded = decode(response.payload) as Record<string, unknown>
      if (response.type.endsWith('.error') || decoded.error === true) {
        const rejection = readRejectionOf(decoded, context.nodeId, indexName)
        throw lostContextOf(rejection, context, indexName) ?? rejection
      }
      for (const fetched of validateFetchResultPayload(decoded).documents) {
        documents.set(fetched.docId, restoreVectorValues(fetched.document) as AnyDocument)
      }
    }
    return documents
  }

  return {
    adopt(contexts) {
      if (contexts === undefined) return
      for (const context of contexts.opened) open.set(context.contextId, context)
      for (const [docId, context] of contexts.sources) if (!sources.has(docId)) sources.set(docId, context)
    },

    async read(docIds, options) {
      const byContext = new Map<string, { context: RankingContext; docIds: string[] }>()
      const unsourced: string[] = []
      for (const docId of new Set(docIds)) {
        const context = sources.get(docId)
        if (context === undefined || !open.has(context.contextId)) {
          unsourced.push(docId)
          continue
        }
        const group = byContext.get(context.contextId)
        if (group === undefined) byContext.set(context.contextId, { context, docIds: [docId] })
        else group.docIds.push(docId)
      }
      if (options.last) {
        releaseQuietly([...open.values()].filter(context => !byContext.has(context.contextId)))
      }

      const reads: Array<Promise<Map<string, AnyDocument>>> = []
      for (const { context, docIds: contextIds } of byContext.values()) {
        reads.push(
          context.nodeId === deps.nodeId && deps.searchContexts !== undefined
            ? Promise.resolve().then(() => readOwnContext(context, contextIds, options.last))
            : readRemoteContext(context, contextIds, options.last, options.fields),
        )
      }
      if (unsourced.length > 0) {
        reads.push(
          readDocumentsFromCopies(
            deps.config,
            deps.nodeId,
            deps.engine,
            indexName,
            unsourced,
            allocation,
            options.fields,
            options.requireEveryPartition,
          ),
        )
      }
      const documents = new Map<string, AnyDocument>()
      for (const found of await Promise.all(reads)) {
        for (const [docId, document] of found) documents.set(docId, document)
      }
      return documents
    },

    release() {
      releaseQuietly([...open.values()])
    },
  }
}
