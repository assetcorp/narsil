import type { QueryParams, SuggestParams } from '../../types/search'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import { SERVER_CAPABILITIES } from '../capabilities'
import { createSharedRequestGate } from '../concurrency-gate'
import { corsWriter } from '../cors'
import type { ResolvedLimits } from '../deps'
import { parseJson, rejectInvalid, respondError, respondJson } from '../handler-utils'
import { createDocumentReadHandlers } from '../handlers/document-reads'
import { createRouteRunner, type RouteContext, type RouteHandler } from '../request'
import { registerServerRoutes, type ServerHandlers, serverRoutes } from '../routes'
import { loadUWebSockets } from '../runtime'
import { validateQuery, validateSuggest } from '../validation'
import { type ChildApp, childAppOf } from './acceptor'
import type { RelayedRoute, RequestThreadSettings, ServeRequestsResult, ThreadOnlyRoute } from './messages'
import { createThreadReadEngine, type ThreadReadEngine } from './read-engine'
import { createRelayClient, type RelayClient } from './relay-client'

let servingApp: { app: ChildApp; relay: RelayClient } | null = null

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
  maxResultWindow: number
  staysOnThread: (indexName: string, params: QueryParams) => boolean
  answer: (indexName: string, params: QueryParams) => Promise<unknown>
}

function searchHandler(options: SearchHandlerOptions): RouteHandler {
  const { fallback, maxResultWindow, staysOnThread, answer } = options
  return async ctx => {
    const params = parseJson<QueryParams>(ctx)
    if (!params) return
    const failure = validateQuery(params, maxResultWindow)
    if (failure) {
      rejectInvalid(ctx, failure)
      return
    }
    if (!staysOnThread(ctx.params[0], params)) {
      await fallback(ctx)
      return
    }
    try {
      respondJson(ctx, await answer(ctx.params[0], params))
    } catch (err) {
      respondError(ctx, err)
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
  const reads = createDocumentReadHandlers({ engine: local, limits: settings.limits })
  const forwarded = relayedHandlers(relay, settings.limits)
  const { maxResultWindow } = settings.limits
  return {
    ...forwarded,
    livez: (ctx: RouteContext) => respondJson(ctx, { status: 'ok' }),
    version: (ctx: RouteContext) => respondJson(ctx, { name: 'narsil', ...settings.build }),
    capabilities: (ctx: RouteContext) => respondJson(ctx, { capabilities: [...SERVER_CAPABILITIES] }),
    search: searchHandler({
      fallback: forwarded.search,
      maxResultWindow,
      staysOnThread: (name, params) => local.canAnswer(name, params),
      answer: (name, params) => local.query(name, params),
    }),
    preflight: searchHandler({
      fallback: forwarded.preflight,
      maxResultWindow,
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

/**
 * Starts receiving HTTP requests on this worker: it opens the port to the main
 * thread, registers every route on an app of its own, and returns the
 * descriptor the acceptor on the main thread moves connections to.
 *
 * @param executor The executor holding this worker's copies.
 * @param settings The settings the main thread sent.
 * @returns The app descriptor to register with the acceptor.
 *
 * @internal
 */
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
  const local = createThreadReadEngine({ executor, relay, searchHooks: settings.searchHooks })
  const run = createRouteRunner({
    authorize: settings.authorizes ? context => relay.authorize(context) : undefined,
    gate: createSharedRequestGate(settings.gate, settings.maxConcurrentRequests, settings.gateSlot),
    writeCors: settings.cors ? corsWriter(settings.cors) : undefined,
  })
  registerServerRoutes(app, run, threadHandlers(local, relay, settings), settings.limits, settings.cors)

  servingApp = { app: child, relay }
  return { descriptor: child.getDescriptor() }
}

/**
 * Stops receiving requests on this worker, closing every connection it holds
 * and the port to the main thread, so that the thread can exit.
 *
 * @internal
 */
export function closeRequestThread(): void {
  if (servingApp === null) return
  const { app, relay } = servingApp
  servingApp = null
  app.close()
  relay.close()
}
