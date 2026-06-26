import type { TemplatedApp, us_listen_socket, us_socket } from 'uWebSockets.js'
import { randomUUID } from 'node:crypto'
import { ErrorCodes, NarsilError } from '../errors'
import type { Narsil } from '../narsil'
import type { EmbeddingAdapter } from '../types/adapters'
import { corsWriter, resolveCors, writeCorsOrigin } from './cors'
import type { HandlerDeps, ResolvedLimits } from './deps'
import { ServerErrorCodes } from './errors'
import { createAdminHandlers } from './handlers/admin'
import { createDocumentHandlers } from './handlers/documents'
import { createHealthHandlers } from './handlers/health'
import { createImportHandler } from './handlers/import'
import { createIndexHandlers } from './handlers/indexes'
import { createSearchHandlers } from './handlers/search'
import { createRouteRunner, type RouteHandler, type RouteOptions } from './request'
import { sendError } from './response'
import { loadUWebSockets, type UWebSockets } from './runtime'
import { InMemoryTaskStore } from './task-store'
import { TaskRegistry } from './tasks'
import type { NarsilServer, ServerLimits, ServerOptions } from './types'

const MB = 1024 * 1024

function resolveLimits(limits: ServerLimits | undefined): ResolvedLimits {
  return {
    maxBodyBytes: limits?.maxBodyBytes ?? 16 * MB,
    maxImportBytes: limits?.maxImportBytes ?? 100 * MB,
    maxLineBytes: limits?.maxLineBytes ?? 4 * MB,
    importBatchSize: limits?.importBatchSize ?? 1000,
    maxConcurrentRequests: limits?.maxConcurrentRequests ?? 0,
  }
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.')
}

/** Refuses to expose destructive admin endpoints on a public interface without
 * authentication. An unauthenticated non-loopback bind turns restore/drop/clear
 * into a one-request data-wipe, so the server fails fast unless the operator
 * authenticates requests or explicitly accepts the risk on a trusted network. */
function assertSecureBinding(host: string, options: ServerOptions): void {
  if (isLoopback(host) || options.onRequest || options.allowInsecure) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `Refusing to start: bound to a non-loopback address ("${host}") with no onRequest auth hook. The server exposes destructive admin endpoints (restore, drop, clear, rebalance, optimize). Resolve one of: (1) set options.onRequest to authenticate requests, (2) bind to 127.0.0.1, or (3) set options.allowInsecure: true if this address is on a trusted private network.`,
    { host },
  )
}

class NarsilHttpServer implements NarsilServer {
  private readonly host: string
  private readonly port: number
  private readonly options: ServerOptions
  private readonly deps: HandlerDeps
  private uws: UWebSockets | null = null
  private listenSocket: us_listen_socket | null = null
  private ready = false

  constructor(engine: Narsil, options: ServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 9876
    this.options = options
    const adapters: Record<string, EmbeddingAdapter> = options.embeddingAdapters ?? {}
    const taskStore = options.taskStore ?? new InMemoryTaskStore()
    const instanceId = options.instanceId ?? randomUUID()
    this.deps = {
      engine,
      tasks: new TaskRegistry(taskStore, instanceId),
      adapters,
      limits: resolveLimits(options.limits),
      isReady: () => this.ready,
    }
  }

  async listen(): Promise<void> {
    assertSecureBinding(this.host, this.options)
    const uws = await loadUWebSockets()
    this.uws = uws
    const app = uws.App()
    this.registerRoutes(app)
    await new Promise<void>((resolve, reject) => {
      app.listen(this.host, this.port, socket => {
        if (socket) {
          this.listenSocket = socket
          resolve()
        } else {
          reject(new Error(`Failed to listen on ${this.host}:${this.port}`))
        }
      })
    })
    await this.deps.tasks.reconcile()
    this.ready = true
  }

  async close(): Promise<void> {
    this.ready = false
    if (this.listenSocket && this.uws) {
      this.uws.us_listen_socket_close(this.listenSocket)
      this.listenSocket = null
    }
  }

  get listeningPort(): number {
    if (!this.listenSocket || !this.uws) return -1
    return this.uws.us_socket_local_port(this.listenSocket as unknown as us_socket)
  }

  private registerRoutes(app: TemplatedApp): void {
    const cors = resolveCors(this.options.cors)
    const run = createRouteRunner({
      onRequest: this.options.onRequest,
      maxConcurrentRequests: this.deps.limits.maxConcurrentRequests,
      writeCors: cors ? corsWriter(cors) : undefined,
    })
    const { maxBodyBytes, maxImportBytes } = this.deps.limits

    const idx = createIndexHandlers(this.deps)
    const doc = createDocumentHandlers(this.deps)
    const search = createSearchHandlers(this.deps)
    const admin = createAdminHandlers(this.deps)
    const health = createHealthHandlers(this.deps)
    const importNdjson = createImportHandler(this.deps)

    const json = (handler: RouteHandler, opts: RouteOptions): ReturnType<typeof run> => run(handler, opts)

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

    app.get('/livez', json(health.livez, { maxBytes: 0, skipHooks: true }))
    app.get('/readyz', json(health.readyz, { maxBytes: 0, skipHooks: true }))
    app.get('/health', json(health.livez, { maxBytes: 0, skipHooks: true }))
    app.get('/stats/memory', json(admin.memory, { maxBytes: 0 }))
    app.get('/tasks', json(admin.listTasks, { maxBytes: 0 }))
    app.get('/tasks/:id', json(admin.getTask, { paramCount: 1, maxBytes: 0 }))

    app.post('/indexes', json(idx.create, { needsBody: true, maxBytes: maxBodyBytes }))
    app.get('/indexes', json(idx.list, { maxBytes: 0 }))
    app.del('/indexes/:name', json(idx.drop, { paramCount: 1, maxBytes: 0 }))
    app.get('/indexes/:name/stats', json(idx.stats, { paramCount: 1, maxBytes: 0 }))
    app.get('/indexes/:name/partitions', json(idx.partitions, { paramCount: 1, maxBytes: 0 }))
    app.post('/indexes/:name/_clear', json(idx.clear, { paramCount: 1, maxBytes: 0 }))
    app.get('/indexes/:name/count', json(doc.count, { paramCount: 1, maxBytes: 0 }))

    app.post('/indexes/:name/documents', json(doc.insert, { paramCount: 1, needsBody: true, maxBytes: maxBodyBytes }))
    app.post(
      '/indexes/:name/documents/_batch',
      json(doc.batch, { paramCount: 1, needsBody: true, maxBytes: maxBodyBytes }),
    )
    app.post(
      '/indexes/:name/documents/_multi-get',
      json(doc.multiGet, { paramCount: 1, needsBody: true, maxBytes: maxBodyBytes }),
    )
    app.post(
      '/indexes/:name/documents/_import',
      json(importNdjson, { paramCount: 1, needsBody: true, maxBytes: maxImportBytes }),
    )
    app.get('/indexes/:name/documents/:id', json(doc.get, { paramCount: 2, maxBytes: 0 }))
    app.get('/indexes/:name/documents/:id/_exists', json(doc.exists, { paramCount: 2, maxBytes: 0 }))
    app.put('/indexes/:name/documents/:id', json(doc.put, { paramCount: 2, needsBody: true, maxBytes: maxBodyBytes }))
    app.patch(
      '/indexes/:name/documents/:id',
      json(doc.patch, { paramCount: 2, needsBody: true, maxBytes: maxBodyBytes }),
    )
    app.del('/indexes/:name/documents/:id', json(doc.remove, { paramCount: 2, maxBytes: 0 }))

    app.post('/indexes/:name/search', json(search.search, { paramCount: 1, needsBody: true, maxBytes: maxBodyBytes }))
    app.post(
      '/indexes/:name/search/preflight',
      json(search.preflight, { paramCount: 1, needsBody: true, maxBytes: maxBodyBytes }),
    )
    app.post('/indexes/:name/suggest', json(search.suggest, { paramCount: 1, needsBody: true, maxBytes: maxBodyBytes }))

    app.post('/indexes/:name/_checkpoint', json(admin.checkpoint, { paramCount: 1, maxBytes: 0 }))
    app.get('/indexes/:name/snapshot', json(admin.snapshot, { paramCount: 1, maxBytes: 0 }))
    app.get('/indexes/:name/vector-maintenance', json(admin.vectorMaintenance, { paramCount: 1, maxBytes: 0 }))
    app.post(
      '/indexes/:name/vectors/_compact',
      json(admin.compact, { paramCount: 1, needsBody: true, maxBytes: maxBodyBytes }),
    )
    app.post(
      '/indexes/:name/vectors/_optimize',
      json(admin.optimize, { paramCount: 1, needsBody: true, maxBytes: maxBodyBytes }),
    )
    app.post(
      '/indexes/:name/_rebalance',
      json(admin.rebalance, { paramCount: 1, needsBody: true, maxBytes: maxBodyBytes }),
    )
    app.post(
      '/indexes/:name/partition-config',
      json(admin.partitionConfig, { paramCount: 1, needsBody: true, maxBytes: maxBodyBytes }),
    )
    app.post(
      '/indexes/:name/restore',
      json(admin.restore, { paramCount: 1, needsBody: true, maxBytes: maxImportBytes }),
    )

    app.any('/*', res => {
      sendError(res, 404, ServerErrorCodes.NOT_FOUND, 'Route not found')
    })
  }
}

/**
 * Wraps a Narsil engine in an HTTP server. The caller builds and owns the engine
 * (durability, embedding, workers) and hands the live instance in; the server
 * shares it across requests and never constructs or shuts it down. Start with
 * `.listen()` and stop with `.close()`; the engine is shut down separately.
 */
export function createServer(engine: Narsil, options?: ServerOptions): NarsilServer {
  return new NarsilHttpServer(engine, options)
}
