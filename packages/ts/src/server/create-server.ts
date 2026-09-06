import type { TemplatedApp, us_listen_socket, us_socket } from 'uWebSockets.js'
import { randomUUID } from 'node:crypto'
import { ErrorCodes, NarsilError } from '../errors'
import type { Narsil } from '../narsil'
import { engineCoreOf } from '../narsil/internals'
import { detectRuntime } from '../runtime/detect'
import {
  createSharedGateBuffer,
  createSharedRequestGate,
  gateSlotOfWorker,
  MAIN_THREAD_GATE_SLOT,
} from './concurrency-gate'
import {
  DEFAULT_IMPORT_BATCH_SIZE,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MAX_FETCH_DOCUMENTS,
  DEFAULT_MAX_IMPORT_BYTES,
  DEFAULT_MAX_IMPORT_ERRORS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_RESULT_WINDOW,
  DEFAULT_MAX_TASK_PAGE_SIZE,
} from './constants'
import { corsWriter, resolveCors } from './cors'
import type { HandlerDeps, ResolvedBuild, ResolvedLimits } from './deps'
import { createAdminHandlers } from './handlers/admin'
import { createCapabilitiesHandler } from './handlers/capabilities'
import { createClusterHandlers } from './handlers/cluster'
import { createDocumentHandlers } from './handlers/documents'
import { createHealthHandlers } from './handlers/health'
import { createImportHandler } from './handlers/import'
import { createIndexHandlers } from './handlers/indexes'
import { createSearchHandlers } from './handlers/search'
import { createVersionHandler } from './handlers/version'
import { authorizerFor, createRouteRunner } from './request'
import { type RequestThreadHost, startRequestThreads } from './request-threads/host'
import { registerServerRoutes, type ServerHandlers } from './routes'
import { loadUWebSockets, type UWebSockets } from './runtime'
import { InMemoryTaskStore } from './task-store'
import { TaskRegistry } from './tasks'
import type { NarsilServer, ServerLimits, ServerOptions } from './types'

function resolveLimits(limits: ServerLimits | undefined): ResolvedLimits {
  return {
    maxBodyBytes: limits?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    maxImportBytes: limits?.maxImportBytes ?? DEFAULT_MAX_IMPORT_BYTES,
    maxLineBytes: limits?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
    importBatchSize: limits?.importBatchSize ?? DEFAULT_IMPORT_BATCH_SIZE,
    maxConcurrentRequests: limits?.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
    maxResultWindow: limits?.maxResultWindow ?? DEFAULT_MAX_RESULT_WINDOW,
    maxFetchDocuments: limits?.maxFetchDocuments ?? DEFAULT_MAX_FETCH_DOCUMENTS,
    maxImportErrors: limits?.maxImportErrors ?? DEFAULT_MAX_IMPORT_ERRORS,
    maxTaskPageSize: limits?.maxTaskPageSize ?? DEFAULT_MAX_TASK_PAGE_SIZE,
    maxConcurrentTasks: limits?.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS,
  }
}

function resolveBuild(build: ServerOptions['build']): ResolvedBuild {
  return {
    version: build?.version ?? null,
    gitSha: build?.gitSha ?? null,
    dirty: build?.dirty ?? false,
  }
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.')
}

function assertSecureBinding(host: string, options: ServerOptions): void {
  if (isLoopback(host) || options.onRequest || options.allowInsecure) return
  throw new NarsilError(
    ErrorCodes.CONFIG_INVALID,
    `Refusing to start: bound to a non-loopback address ("${host}") with no onRequest auth hook. The server exposes destructive admin endpoints (restore, drop, clear, rebalance, optimize). Resolve one of: (1) set options.onRequest to authenticate requests, (2) bind to 127.0.0.1, or (3) set options.allowInsecure: true if this address is on a trusted private network.`,
    { host },
  )
}

function mainThreadHandlers(deps: HandlerDeps): ServerHandlers {
  const idx = createIndexHandlers(deps)
  const doc = createDocumentHandlers(deps)
  const search = createSearchHandlers(deps)
  const admin = createAdminHandlers(deps)
  const health = createHealthHandlers(deps)
  const cluster = createClusterHandlers(deps)
  const version = createVersionHandler(deps)
  const capabilities = createCapabilitiesHandler()

  return {
    livez: health.livez,
    readyz: health.readyz,
    version: version.report,
    capabilities: capabilities.report,
    clusterTopology: cluster.topology,
    clusterAllocation: cluster.allocation,
    memory: admin.memory,
    listTasks: admin.listTasks,
    getTask: admin.getTask,
    cancelTask: admin.cancelTask,
    createIndex: idx.create,
    listIndexes: idx.list,
    dropIndex: idx.drop,
    indexStats: idx.stats,
    indexPartitions: idx.partitions,
    clearIndex: idx.clear,
    openIndex: idx.open,
    closeIndex: idx.close,
    insert: doc.insert,
    batch: doc.batch,
    importNdjson: createImportHandler(deps),
    put: doc.put,
    patch: doc.patch,
    remove: doc.remove,
    waitForWrites: doc.waitForWrites,
    search: search.search,
    preflight: search.preflight,
    suggest: search.suggest,
    get: doc.get,
    exists: doc.exists,
    count: doc.count,
    list: doc.list,
    multiGet: doc.multiGet,
    checkpoint: admin.checkpoint,
    rebuildAnalysis: admin.rebuildAnalysis,
    snapshot: admin.snapshot,
    vectorMaintenance: admin.vectorMaintenance,
    compact: admin.compact,
    optimize: admin.optimize,
    rebalance: admin.rebalance,
    partitionConfig: admin.partitionConfig,
    restore: admin.restore,
  }
}

class NarsilHttpServer implements NarsilServer {
  private readonly host: string
  private readonly port: number
  private readonly options: ServerOptions
  private readonly engine: Narsil
  private readonly deps: HandlerDeps
  private uws: UWebSockets | null = null
  private listenSocket: us_listen_socket | null = null
  private ready = false
  private threads: RequestThreadHost | null = null

  constructor(engine: Narsil, options: ServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 9876
    this.options = options
    this.engine = engine
    for (const [name, adapter] of Object.entries(options.embeddingAdapters ?? {})) {
      engine.registerEmbeddingAdapter(name, adapter)
    }
    engineCoreOf(engine)?.orchestrator.shareMainThread()
    const taskStore = options.taskStore ?? new InMemoryTaskStore()
    const instanceId = options.instanceId ?? randomUUID()
    const limits = resolveLimits(options.limits)
    this.deps = {
      engine,
      tasks: new TaskRegistry(taskStore, instanceId, limits.maxConcurrentTasks),
      limits,
      isReady: () => this.ready,
      build: resolveBuild(options.build),
      cluster: options.cluster,
    }
  }

  async listen(): Promise<void> {
    assertSecureBinding(this.host, this.options)
    const uws = await loadUWebSockets()
    this.uws = uws
    const app = uws.App()
    await this.registerRoutes(app)
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
    if (this.threads !== null) {
      const threads = this.threads
      this.threads = null
      await threads.stop()
    }
  }

  get listeningPort(): number {
    if (!this.listenSocket || !this.uws) return -1
    return this.uws.us_socket_local_port(this.listenSocket as unknown as us_socket)
  }

  get requestThreadCount(): number {
    return this.threads?.threadCount ?? 0
  }

  private async registerRoutes(app: TemplatedApp): Promise<void> {
    const cors = resolveCors(this.options.cors)
    const authorize = this.options.onRequest ? authorizerFor(this.options.onRequest) : undefined
    const core = engineCoreOf(this.engine)
    const threadCount = core === undefined ? 0 : core.orchestrator.requestThreadCount()
    const gate = createSharedGateBuffer(gateSlotOfWorker(threadCount))
    const { limits, build } = this.deps
    const handlers = mainThreadHandlers(this.deps)
    const run = createRouteRunner({
      authorize,
      gate: createSharedRequestGate(gate, limits.maxConcurrentRequests, MAIN_THREAD_GATE_SLOT),
      writeCors: cors ? corsWriter(cors) : undefined,
    })

    registerServerRoutes(app, run, handlers, limits, cors)

    if (core === undefined || !detectRuntime().supportsWorkerThreads) return
    try {
      this.threads = await startRequestThreads({ core, app, handlers, authorize, gate, limits, build, cors })
    } catch (err) {
      console.warn('The server could not start request threads, so the main thread answers every request:', err)
    }
  }
}

/**
 * Wraps a Narsil engine in an HTTP server. The caller builds and owns the engine
 * (durability, embedding, workers) and hands the live instance in; the server
 * shares it across requests and never constructs or shuts it down. Start with
 * `.listen()` and stop with `.close()`; the engine is shut down separately.
 *
 * On Node.js the server receives requests on the engine's worker threads, which
 * hold the worker copies. A query on an index that holds copies answers on the
 * thread that received it, and every write goes to the main thread. Read
 * {@link NarsilServer.requestThreadCount} for how many threads took requests.
 *
 * @param engine - The live engine every request runs against.
 * @param options - Address, CORS, request limits, the authentication hook, and
 * the task store. Omit it to bind to loopback with the default limits.
 * @returns The server, ready for {@link NarsilServer.listen}.
 *
 * @public
 */
export function createServer(engine: Narsil, options?: ServerOptions): NarsilServer {
  return new NarsilHttpServer(engine, options)
}
