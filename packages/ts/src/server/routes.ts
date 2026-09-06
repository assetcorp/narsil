import type { HttpRequest, HttpResponse, TemplatedApp } from 'uWebSockets.js'
import { type ResolvedCors, writeCorsOrigin } from './cors'
import type { ResolvedLimits } from './deps'
import { ServerErrorCodes } from './errors'
import type { RouteHandler, RouteOptions } from './request'
import { sendError } from './response'

/**
 * Every route handler the server registers, by name, so that the main thread
 * and a request thread register the same routes while each supplies its own
 * handler behind a name.
 *
 * @internal
 */
export interface ServerHandlers {
  livez: RouteHandler
  readyz: RouteHandler
  version: RouteHandler
  capabilities: RouteHandler
  clusterTopology: RouteHandler
  clusterAllocation: RouteHandler
  memory: RouteHandler
  listTasks: RouteHandler
  getTask: RouteHandler
  cancelTask: RouteHandler
  createIndex: RouteHandler
  listIndexes: RouteHandler
  dropIndex: RouteHandler
  indexStats: RouteHandler
  indexPartitions: RouteHandler
  clearIndex: RouteHandler
  openIndex: RouteHandler
  closeIndex: RouteHandler
  insert: RouteHandler
  batch: RouteHandler
  importNdjson: RouteHandler
  put: RouteHandler
  patch: RouteHandler
  remove: RouteHandler
  waitForWrites: RouteHandler
  search: RouteHandler
  preflight: RouteHandler
  suggest: RouteHandler
  get: RouteHandler
  exists: RouteHandler
  count: RouteHandler
  list: RouteHandler
  multiGet: RouteHandler
  checkpoint: RouteHandler
  rebuildAnalysis: RouteHandler
  snapshot: RouteHandler
  vectorMaintenance: RouteHandler
  compact: RouteHandler
  optimize: RouteHandler
  rebalance: RouteHandler
  partitionConfig: RouteHandler
  restore: RouteHandler
}

export type RouteMethod = 'get' | 'post' | 'put' | 'patch' | 'del'

export interface RouteSpec {
  method: RouteMethod
  path: string
  handler: keyof ServerHandlers
  options: RouteOptions
}

/**
 * Lists every route with its method, path, handler name, and options, which
 * is the one table both thread kinds register from.
 *
 * @param limits The body ceilings the routes carry.
 * @returns The routes in registration order.
 *
 * @internal
 */
export function serverRoutes(limits: ResolvedLimits): RouteSpec[] {
  const { maxBodyBytes, maxImportBytes } = limits
  const probe: RouteOptions = { maxBytes: 0, skipHooks: true }
  const bare: RouteOptions = { maxBytes: 0 }
  const named: RouteOptions = { paramCount: 1, maxBytes: 0 }
  const namedBody: RouteOptions = { paramCount: 1, needsBody: true, maxBytes: maxBodyBytes }
  const document: RouteOptions = { paramCount: 2, maxBytes: 0 }
  const documentBody: RouteOptions = { paramCount: 2, needsBody: true, maxBytes: maxBodyBytes }
  return [
    { method: 'get', path: '/livez', handler: 'livez', options: probe },
    { method: 'get', path: '/readyz', handler: 'readyz', options: probe },
    { method: 'get', path: '/health', handler: 'livez', options: probe },
    { method: 'get', path: '/version', handler: 'version', options: probe },
    { method: 'get', path: '/capabilities', handler: 'capabilities', options: probe },
    { method: 'get', path: '/cluster', handler: 'clusterTopology', options: bare },
    { method: 'get', path: '/stats/memory', handler: 'memory', options: bare },
    { method: 'get', path: '/tasks', handler: 'listTasks', options: bare },
    { method: 'get', path: '/tasks/:id', handler: 'getTask', options: named },
    { method: 'post', path: '/tasks/:id/_cancel', handler: 'cancelTask', options: named },
    { method: 'post', path: '/indexes', handler: 'createIndex', options: { needsBody: true, maxBytes: maxBodyBytes } },
    { method: 'get', path: '/indexes', handler: 'listIndexes', options: bare },
    { method: 'del', path: '/indexes/:name', handler: 'dropIndex', options: named },
    { method: 'get', path: '/indexes/:name/stats', handler: 'indexStats', options: named },
    { method: 'get', path: '/indexes/:name/partitions', handler: 'indexPartitions', options: named },
    { method: 'get', path: '/indexes/:name/cluster', handler: 'clusterAllocation', options: named },
    { method: 'post', path: '/indexes/:name/_clear', handler: 'clearIndex', options: named },
    { method: 'post', path: '/indexes/:name/_open', handler: 'openIndex', options: named },
    { method: 'post', path: '/indexes/:name/_close', handler: 'closeIndex', options: named },
    { method: 'get', path: '/indexes/:name/count', handler: 'count', options: named },
    { method: 'post', path: '/indexes/:name/documents', handler: 'insert', options: namedBody },
    { method: 'post', path: '/indexes/:name/documents/_batch', handler: 'batch', options: namedBody },
    { method: 'post', path: '/indexes/:name/documents/_list', handler: 'list', options: namedBody },
    { method: 'post', path: '/indexes/:name/documents/_multi-get', handler: 'multiGet', options: namedBody },
    {
      method: 'post',
      path: '/indexes/:name/documents/_import',
      handler: 'importNdjson',
      options: { paramCount: 1, needsBody: true, maxBytes: maxImportBytes },
    },
    { method: 'post', path: '/indexes/:name/_wait-for-writes', handler: 'waitForWrites', options: named },
    { method: 'get', path: '/indexes/:name/documents/:id', handler: 'get', options: document },
    { method: 'get', path: '/indexes/:name/documents/:id/_exists', handler: 'exists', options: document },
    { method: 'put', path: '/indexes/:name/documents/:id', handler: 'put', options: documentBody },
    { method: 'patch', path: '/indexes/:name/documents/:id', handler: 'patch', options: documentBody },
    { method: 'del', path: '/indexes/:name/documents/:id', handler: 'remove', options: document },
    { method: 'post', path: '/indexes/:name/search', handler: 'search', options: namedBody },
    { method: 'post', path: '/indexes/:name/search/preflight', handler: 'preflight', options: namedBody },
    { method: 'post', path: '/indexes/:name/suggest', handler: 'suggest', options: namedBody },
    { method: 'post', path: '/indexes/:name/_checkpoint', handler: 'checkpoint', options: named },
    { method: 'post', path: '/indexes/:name/_rebuild-analysis', handler: 'rebuildAnalysis', options: named },
    { method: 'get', path: '/indexes/:name/snapshot', handler: 'snapshot', options: named },
    { method: 'get', path: '/indexes/:name/vector-maintenance', handler: 'vectorMaintenance', options: named },
    { method: 'post', path: '/indexes/:name/vectors/_compact', handler: 'compact', options: namedBody },
    { method: 'post', path: '/indexes/:name/vectors/_optimize', handler: 'optimize', options: namedBody },
    { method: 'post', path: '/indexes/:name/_rebalance', handler: 'rebalance', options: namedBody },
    { method: 'post', path: '/indexes/:name/partition-config', handler: 'partitionConfig', options: namedBody },
    {
      method: 'post',
      path: '/indexes/:name/restore',
      handler: 'restore',
      options: { paramCount: 1, needsBody: true, maxBytes: maxImportBytes },
    },
  ]
}

export type RouteRunner = (
  handler: RouteHandler,
  options: RouteOptions,
) => (res: HttpResponse, req: HttpRequest) => void

/**
 * Registers every route on an app, with the preflight route and the catch-all
 * the server answers itself.
 *
 * @param app The app to register on.
 * @param run The adapter that wraps each handler.
 * @param handlers The handler behind each route name.
 * @param limits The body ceilings the routes carry.
 * @param cors The cross-origin rules, or null where the server allows none.
 *
 * @internal
 */
export function registerServerRoutes(
  app: TemplatedApp,
  run: RouteRunner,
  handlers: ServerHandlers,
  limits: ResolvedLimits,
  cors: ResolvedCors | null,
): void {
  if (cors) {
    app.options('/*', (res, req) => {
      const origin = req.getHeader('origin')
      res.cork(() => {
        res.writeStatus('204 No Content')
        writeCorsOrigin(res, cors, origin)
        res
          .writeHeader('Access-Control-Allow-Methods', cors.methods)
          .writeHeader('Access-Control-Allow-Headers', cors.headers)
          .writeHeader('Access-Control-Max-Age', '86400')
          .endWithoutBody()
      })
    })
  }

  for (const route of serverRoutes(limits)) {
    app[route.method](route.path, run(handlers[route.handler], route.options))
  }

  app.any('/*', res => {
    sendError(res, 404, ServerErrorCodes.NOT_FOUND, 'Route not found')
  })
}
