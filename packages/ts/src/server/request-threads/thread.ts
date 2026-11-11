import { ErrorCodes, isNarsilError } from '../../errors'
import type { PreflightResult, QueryResult } from '../../types/results'
import type { QueryParams, SuggestParams } from '../../types/search'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import { createSharedBodyBudget } from '../body-budget'
import { SERVER_CAPABILITIES } from '../capabilities'
import { createSharedRequestGate } from '../concurrency-gate'
import { corsHeaderReader } from '../cors'
import type { ResolvedLimits } from '../deps'
import { parseJson, rejectInvalid, respondError, respondJson } from '../handler-utils'
import { createDocumentReadHandlers } from '../handlers/document-reads'
import { versionReport } from '../handlers/version'
import { encodeQueryResult } from '../query-response'
import { refuseRegex } from '../regex-policy'
import { createRouteRunner, type RouteContext, type RouteHandler } from '../request'
import { requestSignal } from '../request-signal'
import { registerServerRoutes, type ServerHandlers, serverRoutes } from '../routes'
import { loadUWebSockets } from '../runtime'
import { CHANGES_FEED_ROUTE, registerFeedRoute, SYNC_FEED_ROUTE } from '../sync/feed-route'
import type { CapabilitiesResponse, LivenessResponse } from '../types'
import { type QueryLimits, validateQuery, validateSuggest, withServerRerankWindow } from '../validation'
import { type ChildApp, childAppOf } from './acceptor'
import { closeWhenTheProcessExits } from './close-at-exit'
import { type ThreadFeedGateway, threadFeedGateway } from './feed-relay'
import { type LongQueryRoute, routeLongQueries } from './long-query-route'
import type { RelayedRoute, RequestThreadSettings, ServeRequestsResult, ThreadOnlyRoute } from './messages'
import { SearchMoved } from './move-clock'
import { createThreadReadEngine, type ThreadReadEngine } from './read-engine'
import { createRelayClient, type RelayClient } from './relay-client'
import { leaveWithoutDeparture, type ThreadDeparture, watchForDeparture } from './thread-departure'

let servingApp: {
  app: ChildApp
  relay: RelayClient
  longQueries: LongQueryRoute
  feeds: ThreadFeedGateway[]
} | null = null

function guardEveryRoute(handlers: ServerHandlers, departure: ThreadDeparture): ServerHandlers {
  const guarded = { ...handlers }
  for (const route of Object.keys(guarded) as Array<keyof ServerHandlers>) {
    guarded[route] = departure.guardRoute(handlers[route])
  }
  return guarded
}

function relayed(relay: RelayClient, route: RelayedRoute): RouteHandler {
  return ctx => relay.request(route, ctx)
}

function onHeldIndex(local: ThreadReadEngine, handler: RouteHandler, fallback: RouteHandler): RouteHandler {
  return ctx => (local.holdsCopyOf(ctx.params[0]) ? handler(ctx) : fallback(ctx))
}

function onWholeDocuments(local: ThreadReadEngine, handler: RouteHandler, fallback: RouteHandler): RouteHandler {
  return ctx => (local.holdsDocumentsOf(ctx.params[0]) ? handler(ctx) : fallback(ctx))
}

export interface SearchHandlerOptions {
  fallback: RouteHandler
  limits: QueryLimits
  allowRegex: boolean
  staysOnThread: (indexName: string, params: QueryParams) => boolean
  answer: (indexName: string, params: QueryParams, signal: AbortSignal) => Promise<QueryResult | PreflightResult>
  answerHere: (indexName: string, params: QueryParams, signal: AbortSignal) => Promise<QueryResult | PreflightResult>
  move: (ctx: RouteContext) => Promise<boolean>
}

function mainThreadAnswersInstead(err: unknown): boolean {
  return isNarsilError(err) && err.code === ErrorCodes.WORKER_BUSY
}

async function answerMoved(
  ctx: RouteContext,
  params: QueryParams,
  limits: QueryLimits,
  options: SearchHandlerOptions,
): Promise<void> {
  if (ctx.abort.aborted || (await options.move(ctx)) || ctx.abort.aborted) return
  try {
    const answer = await options.answerHere(
      ctx.params[0],
      withServerRerankWindow(params, limits),
      requestSignal(ctx.abort),
    )
    respondJson(ctx, 'hits' in answer ? encodeQueryResult(answer) : answer)
  } catch (err) {
    if (ctx.abort.aborted) return
    if (mainThreadAnswersInstead(err)) await options.fallback(ctx)
    else respondError(ctx, err)
  }
}

export function searchHandler(options: SearchHandlerOptions): RouteHandler {
  const { fallback, limits, allowRegex, staysOnThread, answer } = options
  return async ctx => {
    const params = parseJson<QueryParams>(ctx)
    if (!params) return
    const failure = validateQuery(params, limits)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    if (refuseRegex(ctx, params.filters, allowRegex)) return
    if (!staysOnThread(ctx.params[0], params)) {
      await fallback(ctx)
      return
    }
    try {
      const result = await answer(ctx.params[0], withServerRerankWindow(params, limits), requestSignal(ctx.abort))
      respondJson(ctx, 'hits' in result ? encodeQueryResult(result) : result)
    } catch (err) {
      if (ctx.abort.aborted) return
      if (err instanceof SearchMoved) await answerMoved(ctx, params, limits, options)
      else if (staysOnThread(ctx.params[0], params) && !mainThreadAnswersInstead(err)) respondError(ctx, err)
      else await fallback(ctx)
    }
  }
}

function suggestHandler(local: ThreadReadEngine, fallback: RouteHandler): RouteHandler {
  return async ctx => {
    const params = parseJson<SuggestParams>(ctx)
    if (!params) return
    const failure = validateSuggest(params)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    if (!local.holdsCopyOf(ctx.params[0])) {
      await fallback(ctx)
      return
    }
    try {
      respondJson(ctx, await local.suggest(ctx.params[0], params))
    } catch (err) {
      respondError(ctx, err)
    }
  }
}

const THREAD_ONLY_ROUTES: ReadonlySet<ThreadOnlyRoute> = new Set(['livez', 'version', 'capabilities'])

function isRelayedRoute(handler: keyof ServerHandlers): handler is RelayedRoute {
  return !(THREAD_ONLY_ROUTES as ReadonlySet<string>).has(handler)
}

function relayedHandlers(relay: RelayClient, limits: ResolvedLimits): Record<RelayedRoute, RouteHandler> {
  const forwarded: Partial<Record<RelayedRoute, RouteHandler>> = {}
  for (const route of serverRoutes(limits)) {
    if (isRelayedRoute(route.handler)) forwarded[route.handler] = relayed(relay, route.handler)
  }
  return forwarded as Record<RelayedRoute, RouteHandler>
}

function threadHandlers(
  local: ThreadReadEngine,
  relay: RelayClient,
  longQueries: LongQueryRoute,
  settings: RequestThreadSettings,
): ServerHandlers {
  const { allowRegex } = settings
  const reads = createDocumentReadHandlers({ engine: local, limits: settings.limits, allowRegex })
  const forwarded = relayedHandlers(relay, settings.limits)
  return {
    ...forwarded,
    livez: (ctx: RouteContext) => respondJson(ctx, { status: 'ok' } satisfies LivenessResponse),
    version: (ctx: RouteContext) => respondJson(ctx, versionReport(settings.build)),
    capabilities: (ctx: RouteContext) =>
      respondJson(ctx, { capabilities: [...SERVER_CAPABILITIES] } satisfies CapabilitiesResponse),
    search: searchHandler({
      fallback: forwarded.search,
      limits: settings.limits,
      allowRegex,
      staysOnThread: (name, params) => local.canAnswer(name, params),
      answer: (name, params, signal) => local.query(name, params, signal),
      answerHere: (name, params, signal) => local.queryHere(name, params, signal),
      move: ctx => longQueries.move('search', ctx),
    }),
    preflight: searchHandler({
      fallback: forwarded.preflight,
      limits: settings.limits,
      allowRegex,
      staysOnThread: (name, params) => local.canCount(name, params),
      answer: (name, params, signal) => local.preflight(name, params, signal),
      answerHere: (name, params, signal) => local.preflightHere(name, params, signal),
      move: ctx => longQueries.move('preflight', ctx),
    }),
    suggest: suggestHandler(local, forwarded.suggest),
    get: onWholeDocuments(local, reads.get, forwarded.get),
    exists: onHeldIndex(local, reads.exists, forwarded.exists),
    count: onHeldIndex(local, reads.count, forwarded.count),
    list: onWholeDocuments(local, reads.list, forwarded.list),
    multiGet: onWholeDocuments(local, reads.multiGet, forwarded.multiGet),
  }
}

export async function serveRequests(
  executor: DirectExecutorExtensions,
  settings: RequestThreadSettings,
): Promise<ServeRequestsResult> {
  if (servingApp !== null) throw new Error('This worker already serves requests')
  const uws = await loadUWebSockets()
  const app = uws.App()
  const child = childAppOf(app)
  if (child === null) throw new Error('This uWebSockets.js build offers no child apps')

  const relay = createRelayClient(settings.port, settings.touchIntervalMs)
  const longQueries = routeLongQueries(
    settings.port,
    settings.longQueriesInFlight,
    settings.touchIntervalMs,
    settings.longQueryPort,
  )
  const departure = watchForDeparture({
    relay,
    departure: new Int32Array(settings.departure),
    close: closeRequestThread,
  })
  const local = createThreadReadEngine({
    executor: departure.guardExecutor(executor),
    relay,
    searchHooks: settings.searchHooks,
    patternWorkCap: settings.patternWorkCap,
    maxRerankWindow: settings.maxRerankWindow,
    moveAfterMs: () => longQueries.moveAfterMs(),
  })
  const run = createRouteRunner({
    authorize: settings.authorizes ? context => relay.authorize(context) : undefined,
    gate: createSharedRequestGate(settings.gate, settings.maxConcurrentRequests, settings.gateSlot),
    bodyBudget: createSharedBodyBudget(settings.bodyBudget, settings.limits.maxBodyBytesInFlight, settings.gateSlot),
    corsHeaders: settings.cors ? corsHeaderReader(settings.cors) : undefined,
    track: departure.track,
  })
  const handlers = guardEveryRoute(threadHandlers(local, relay, longQueries, settings), departure)
  const feeds = settings.feeds.map(feed => {
    const gateway = threadFeedGateway(settings.port, relay, feed)
    registerFeedRoute(app, gateway, feed === 'sync' ? SYNC_FEED_ROUTE : CHANGES_FEED_ROUTE)
    return gateway
  })
  registerServerRoutes(app, run, handlers, settings.limits, settings.cors)

  servingApp = { app: child, relay, longQueries, feeds }
  void closeWhenTheProcessExits(new Int32Array(settings.closeAtExit), closeRequestThread)
  return { descriptor: child.getDescriptor() }
}

export function closeRequestThread(): void {
  leaveWithoutDeparture()
  if (servingApp === null) return
  const { app, relay, longQueries, feeds } = servingApp
  servingApp = null
  for (const gateway of feeds) gateway.close()
  app.close()
  longQueries.close()
  relay.close()
}
