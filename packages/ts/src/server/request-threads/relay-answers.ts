import type { EngineCore } from '../../engine/core'
import { loadRerankRuntime } from '../../engine/query/fixed-depth-code'
import { resolveVectorText } from '../../engine/resolve-vector-text'
import { isNarsilError } from '../../errors'
import { ServerErrorCodes, toHttpError } from '../errors'
import type { Authorizer } from '../request'
import type { ThreadFeeds } from '../sync/feed-host'
import type { FeedAdmitRequest, FeedAdmittedReply } from '../sync/feed-messages'
import type {
  AuthorizeRequest,
  AwaitWritesRequest,
  EmbedQueryRequest,
  RelayReply,
  RerankQueryRequest,
} from './messages'

export async function answerAuthorize(
  authorize: Authorizer | undefined,
  request: AuthorizeRequest,
): Promise<RelayReply> {
  if (authorize === undefined) {
    return { type: 'authorized', requestId: request.requestId, denial: null, hookError: false, expiresAt: null }
  }
  const authorization = await authorize(request.context)
  if (authorization.allowed) {
    return {
      type: 'authorized',
      requestId: request.requestId,
      denial: null,
      hookError: false,
      expiresAt: authorization.expiresAt,
    }
  }
  return {
    type: 'authorized',
    requestId: request.requestId,
    denial: authorization.denial,
    hookError: authorization.denial === null,
    expiresAt: null,
  }
}

export async function answerEmbed(
  core: EngineCore,
  request: EmbedQueryRequest,
  signal?: AbortSignal,
): Promise<RelayReply> {
  try {
    const entry = core.requireIndex(request.indexName)
    const resolved = await resolveVectorText(
      { vector: request.vector },
      entry.embeddingAdapter,
      signal === undefined ? core.abortController.signal : AbortSignal.any([core.abortController.signal, signal]),
      entry.embeddingAdapterName,
    )
    const value = resolved.vector?.value
    return {
      type: 'embedded',
      requestId: request.requestId,
      value: value === undefined ? null : Array.from(value),
      error: null,
    }
  } catch (err) {
    if (!isNarsilError(err)) console.warn('Embedding a query for a request thread failed:', err)
    return { type: 'embedded', requestId: request.requestId, value: null, error: toHttpError(err).body }
  }
}

export async function answerRerank(
  core: EngineCore,
  request: RerankQueryRequest,
  signal?: AbortSignal,
): Promise<RelayReply> {
  try {
    const { rerankOnHost } = await loadRerankRuntime()
    const scores = await rerankOnHost(core, request.adapter, request.query, request.documents, signal)
    return { type: 'reranked', requestId: request.requestId, scores, error: null }
  } catch (err) {
    if (!isNarsilError(err)) console.warn('Reranking a query for a request thread failed:', err)
    return { type: 'reranked', requestId: request.requestId, scores: null, error: toHttpError(err).body }
  }
}

export async function answerAwaitWrites(core: EngineCore, request: AwaitWritesRequest): Promise<RelayReply> {
  await core.orchestrator.awaitWrites(request.indexName).catch(() => undefined)
  return { type: 'writes-applied', requestId: request.requestId }
}

export async function answerFeedAdmit(
  feeds: ThreadFeeds | null,
  request: FeedAdmitRequest,
): Promise<FeedAdmittedReply> {
  if (feeds !== null) return feeds.admit(request)
  return {
    type: 'feed-admitted',
    requestId: request.requestId,
    feedId: null,
    error: { code: ServerErrorCodes.NOT_FOUND, message: 'Route not found' },
  }
}
