import type { QueryParams, SuggestParams } from '../../types/search'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import { SERVER_CAPABILITIES } from '../capabilities'
import { createSharedRequestGate } from '../concurrency-gate'
import { corsHeaderReader } from '../cors'
import type { ResolvedLimits } from '../deps'
import { parseJson, rejectInvalid, respondError, respondJson } from '../handler-utils'
import { createDocumentReadHandlers } from '../handlers/document-reads'
import { versionReport } from '../handlers/version'
import { refuseRegex } from '../regex-policy'
import { createRouteRunner, type RouteContext, type RouteHandler } from '../request'
import { registerServerRoutes, type ServerHandlers, serverRoutes } from '../routes'
import { loadUWebSockets } from '../runtime'
import { type QueryLimits, validateQuery, validateSuggest } from '../validation'
import { type ChildApp, childAppOf } from './acceptor'
import type { RelayedRoute, RequestThreadSettings, ServeRequestsResult, ThreadOnlyRoute } from './messages'
import { createThreadReadEngine, type ThreadReadEngine } from './read-engine'
import { createRelayClient, type RelayClient } from './relay-client'
import { leaveWithoutDeparture, type ThreadDeparture, watchForDeparture } from './thread-departure'

let servingApp: { app: ChildApp; relay: RelayClient } | null = null

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

interface SearchHandlerOptions {
  fallback: RouteHandler
  limits: QueryLimits
  allowRegex: boolean
  staysOnThread: (indexName: string, params: QueryParams) => boolean
  answer: (indexName: string, params: QueryParams) => Promise<unknown>
}

function searchHandler(options: SearchHandlerOptions): RouteHandler {
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
      respondJson(ctx, await answer(ctx.params[0], params))
    } catch (err) {
      if (staysOnThread(ctx.params[0], params)) respondError(ctx, err)
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

function threadHandlers(local: ThreadReadEngine, relay: RelayClient, settings: RequestThreadSettings): ServerHandlers {
  const { allowRegex } = settings
  const reads = createDocumentReadHandlers({ engine: local, limits: settings.limits, allowRegex })
  const forwarded = relayedHandlers(relay, settings.limits)
  return {
    ...forwarded,
    livez: (ctx: RouteContext) => respondJson(ctx, { status: 'ok' }),
    version: (ctx: RouteContext) => respondJson(ctx, versionReport(settings.build)),
    capabilities: (ctx: RouteContext) => respondJson(ctx, { capabilities: [...SERVER_CAPABILITIES] }),
    search: searchHandler({
      fallback: forwarded.search,
      limits: settings.limits,
      allowRegex,
      staysOnThread: (name, params) => local.canAnswer(name, params),
      answer: (name, params) => local.query(name, params),
    }),
    preflight: searchHandler({
      fallback: forwarded.preflight,
      limits: settings.limits,
      allowRegex,
      staysOnThread: (name, params) => local.canCount(name, params),
      answer: (name, params) => local.preflight(name, params),
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
  })
  const run = createRouteRunner({
    authorize: settings.authorizes ? context => relay.authorize(context) : undefined,
    gate: createSharedRequestGate(settings.gate, settings.maxConcurrentRequests, settings.gateSlot),
    corsHeaders: settings.cors ? corsHeaderReader(settings.cors) : undefined,
    track: departure.track,
  })
  const handlers = guardEveryRoute(threadHandlers(local, relay, settings), departure)
  registerServerRoutes(app, run, handlers, settings.limits, settings.cors)

  servingApp = { app: child, relay }
  return { descriptor: child.getDescriptor() }
}

export function closeRequestThread(): void {
  leaveWithoutDeparture()
  if (servingApp === null) return
  const { app, relay } = servingApp
  servingApp = null
  app.close()
  relay.close()
}
