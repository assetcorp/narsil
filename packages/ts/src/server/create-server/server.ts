import type { TemplatedApp, us_listen_socket, us_socket } from 'uWebSockets.js'
import { randomUUID } from 'node:crypto'
import { startIdleHeapCleanup } from '#platform/idle-heap-cleanup'
import type { EngineCore } from '../../engine/core'
import { readMemoryFigures } from '../../engine/memory/measure'
import type { Narsil } from '../../narsil'
import { engineCoreOf, rerankWindowCapOf } from '../../narsil/internals'
import { detectRuntime } from '../../runtime/detect'
import { createBodyBudgetBuffer, createSharedBodyBudget } from '../body-budget'
import { type ClosingRequests, watchClosingRequests } from '../closing-requests'
import {
  createSharedGateBuffer,
  createSharedRequestGate,
  gateSlotOfWorker,
  MAIN_THREAD_GATE_SLOT,
} from '../concurrency-gate'
import {
  DEFAULT_IMPORT_BATCH_SIZE,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_BODY_BYTES_IN_FLIGHT_FRACTION,
  DEFAULT_MAX_CONCURRENT_REQUESTS,
  DEFAULT_MAX_CONCURRENT_TASKS,
  DEFAULT_MAX_FETCH_DOCUMENTS,
  DEFAULT_MAX_IMPORT_BYTES,
  DEFAULT_MAX_IMPORT_ERRORS,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_RERANK_WINDOW,
  DEFAULT_MAX_RESTORE_BYTES,
  DEFAULT_MAX_RESULT_WINDOW,
  DEFAULT_MAX_TASK_PAGE_SIZE,
  SERVER_CLOSE_DRAIN_DEADLINE_MS,
} from '../constants'
import { corsHeaderReader, resolveCors } from '../cors'
import type { HandlerDeps, ResolvedBuild, ResolvedLimits } from '../deps'
import { startFeeds } from '../feeds'
import {
  assertAllowRegex,
  assertQuerySuggestionsOptions,
  assertSecureBinding,
  assertServerEngine,
  assertServerLimits,
} from '../options-validation'
import { publishedPackageVersion } from '../package-version'
import { type Authorizer, authorizerFor, createRouteRunner } from '../request'
import { type RequestThreadHost, startRequestThreads } from '../request-threads/host'
import { registerServerRoutes } from '../routes'
import { loadUWebSockets, type UWebSockets } from '../runtime'
import type { FeedHost } from '../sync/feed-host'
import { CHANGES_FEED_ROUTE, registerFeedRoute, SYNC_FEED_ROUTE } from '../sync/feed-route'
import { assertFeedHasAuthentication, type ResolvedFeedOptions, resolveFeedOptions } from '../sync/options'
import type { SyncServing } from '../sync/serving'
import { InMemoryTaskStore } from '../task-store'
import { TaskRegistry } from '../tasks'
import type { NarsilServer, ServerLimits, ServerOptions } from '../types'
import { mainThreadHandlers } from './handlers'

function bodyBytesInFlightOf(fraction: number): number {
  const processLimitBytes = readMemoryFigures()?.processLimitBytes
  if (fraction === 0 || processLimitBytes === undefined) return Number.POSITIVE_INFINITY
  return Math.floor(fraction * processLimitBytes)
}

function resolveLimits(limits: ServerLimits | undefined, engineRerankWindow: number | undefined): ResolvedLimits {
  return {
    maxBodyBytesInFlight: bodyBytesInFlightOf(
      limits?.maxBodyBytesInFlightFraction ?? DEFAULT_MAX_BODY_BYTES_IN_FLIGHT_FRACTION,
    ),
    maxBodyBytes: limits?.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    maxImportBytes: limits?.maxImportBytes ?? DEFAULT_MAX_IMPORT_BYTES,
    maxRestoreBytes: limits?.maxRestoreBytes ?? DEFAULT_MAX_RESTORE_BYTES,
    maxLineBytes: limits?.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
    importBatchSize: limits?.importBatchSize ?? DEFAULT_IMPORT_BATCH_SIZE,
    maxConcurrentRequests: limits?.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS,
    maxResultWindow: limits?.maxResultWindow ?? DEFAULT_MAX_RESULT_WINDOW,
    maxRerankWindow:
      limits?.maxRerankWindow ?? Math.min(DEFAULT_MAX_RERANK_WINDOW, engineRerankWindow ?? DEFAULT_MAX_RERANK_WINDOW),
    maxFetchDocuments: limits?.maxFetchDocuments ?? DEFAULT_MAX_FETCH_DOCUMENTS,
    maxImportErrors: limits?.maxImportErrors ?? DEFAULT_MAX_IMPORT_ERRORS,
    maxTaskPageSize: limits?.maxTaskPageSize ?? DEFAULT_MAX_TASK_PAGE_SIZE,
    maxConcurrentTasks: limits?.maxConcurrentTasks ?? DEFAULT_MAX_CONCURRENT_TASKS,
  }
}

function resolveBuild(build: ServerOptions['build']): ResolvedBuild {
  return {
    version: build?.version ?? publishedPackageVersion(),
    gitSha: build?.gitSha ?? null,
    dirty: build?.dirty ?? false,
  }
}

class NarsilHttpServer implements NarsilServer {
  private readonly host: string
  private readonly port: number
  private readonly options: ServerOptions
  private readonly engine: Narsil
  private readonly deps: HandlerDeps
  private uws: UWebSockets | null = null
  private app: TemplatedApp | null = null
  private closingRequests: ClosingRequests | null = null
  private listenSocket: us_listen_socket | null = null
  private ready = false
  private threads: RequestThreadHost | null = null
  private readonly sync: ResolvedFeedOptions | null
  private readonly changes: ResolvedFeedOptions | null
  private syncServing: SyncServing | null = null
  private feeds: FeedHost | null = null
  private stopIdleHeapCleanup: () => void = () => undefined
  private listening: Promise<void> | null = null
  private closing: Promise<void> | null = null

  constructor(engine: Narsil, options: ServerOptions = {}) {
    assertServerEngine(engine)
    const engineRerankWindow = rerankWindowCapOf(engine)
    assertServerLimits(options.limits, engineRerankWindow)
    assertAllowRegex(options.allowRegex)
    assertQuerySuggestionsOptions(options.querySuggestions)
    this.sync = resolveFeedOptions('sync', options.sync)
    this.changes = resolveFeedOptions('changes', options.changes)
    this.host = options.host ?? '127.0.0.1'
    this.port = options.port ?? 9876
    this.options = options
    this.engine = engine
    for (const [name, adapter] of Object.entries(options.embeddingAdapters ?? {})) {
      engine.registerEmbeddingAdapter(name, adapter)
    }
    for (const [name, adapter] of Object.entries(options.rerankAdapters ?? {})) {
      engine.registerRerankAdapter(name, adapter)
    }
    engineCoreOf(engine)?.orchestrator.shareMainThread()
    const taskStore = options.taskStore ?? new InMemoryTaskStore()
    const instanceId = options.instanceId ?? randomUUID()
    const limits = resolveLimits(options.limits, engineRerankWindow)
    this.deps = {
      engine,
      tasks: new TaskRegistry(taskStore, instanceId, limits.maxConcurrentTasks),
      limits,
      allowRegex: options.allowRegex ?? true,
      isReady: () => this.ready,
      build: resolveBuild(options.build),
      cluster: options.cluster,
      requestThreadCount: () => this.requestThreadCount,
      querySuggestions: options.querySuggestions,
    }
  }

  listen(): Promise<void> {
    if (this.listening !== null) return this.listening
    const closing = this.closing
    this.listening = (async () => {
      if (closing !== null) await closing
      if (this.listenSocket !== null) return
      await this.startListening()
    })().finally(() => {
      this.listening = null
    })
    return this.listening
  }

  private async startListening(): Promise<void> {
    assertFeedHasAuthentication('sync', this.sync, this.options)
    assertFeedHasAuthentication('changes', this.changes, this.options)
    assertSecureBinding(this.host, this.options)
    const uws = await loadUWebSockets()
    this.uws = uws
    const app = uws.App()
    this.app = app
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
    this.stopIdleHeapCleanup = startIdleHeapCleanup()
    this.ready = true
  }

  close(): Promise<void> {
    if (this.closing !== null) return this.closing
    const listening = this.listening
    this.closing = (async () => {
      if (listening !== null) await listening.catch(() => undefined)
      await this.stopListening()
    })().finally(() => {
      this.closing = null
    })
    return this.closing
  }

  private async stopListening(): Promise<void> {
    this.ready = false
    this.stopIdleHeapCleanup()
    this.stopIdleHeapCleanup = () => undefined
    if (this.listenSocket && this.uws) {
      this.uws.us_listen_socket_close(this.listenSocket)
      this.listenSocket = null
    }
    this.feeds?.close()
    this.feeds = null
    this.syncServing = null
    const app = this.app
    const closingRequests = this.closingRequests
    const threads = this.threads
    this.app = null
    this.closingRequests = null
    this.threads = null
    try {
      await Promise.all([closingRequests?.close(SERVER_CLOSE_DRAIN_DEADLINE_MS), threads?.stop()])
    } finally {
      await new Promise<void>(resolve => setImmediate(resolve))
      app?.close()
    }
  }

  async shutdown(): Promise<void> {
    await this.close()
    await this.engine.shutdown()
  }

  get listeningPort(): number {
    if (!this.listenSocket || !this.uws) return -1
    return this.uws.us_socket_local_port(this.listenSocket as unknown as us_socket)
  }

  get requestThreadCount(): number {
    return this.threads?.threadCount ?? 0
  }

  private startFeeds(app: TemplatedApp, authorize: Authorizer | undefined, core: EngineCore | undefined): void {
    const started = startFeeds(this.engine, core, {
      sync: this.sync,
      changes: this.changes,
      allowRegex: this.deps.allowRegex,
      authorize,
    })
    if (started === null) return
    this.syncServing = started.syncServing
    this.feeds = started.host
    const { sync, changes } = started.host.gateways
    const accept = this.closingRequests?.accept
    if (sync !== undefined) registerFeedRoute(app, sync, SYNC_FEED_ROUTE, accept)
    if (changes !== undefined) registerFeedRoute(app, changes, CHANGES_FEED_ROUTE, accept)
  }

  private async registerRoutes(app: TemplatedApp): Promise<void> {
    const cors = resolveCors(this.options.cors)
    const authorize = this.options.onRequest ? authorizerFor(this.options.onRequest) : undefined
    const core = engineCoreOf(this.engine)
    const threadCount = core === undefined ? 0 : core.orchestrator.requestThreadCount()
    const gate = createSharedGateBuffer(gateSlotOfWorker(threadCount))
    const bodyBudget = createBodyBudgetBuffer(gateSlotOfWorker(threadCount))
    const { limits, build, allowRegex } = this.deps
    const handlers = mainThreadHandlers(this.deps, () => this.syncServing)
    const closingRequests = watchClosingRequests()
    this.closingRequests = closingRequests
    this.startFeeds(app, authorize, core)
    const run = createRouteRunner({
      accept: closingRequests.accept,
      authorize,
      gate: createSharedRequestGate(gate, limits.maxConcurrentRequests, MAIN_THREAD_GATE_SLOT),
      bodyBudget: createSharedBodyBudget(bodyBudget, limits.maxBodyBytesInFlight, MAIN_THREAD_GATE_SLOT),
      corsHeaders: cors ? corsHeaderReader(cors) : undefined,
      respondThrough: closingRequests.respondThrough,
      track: closingRequests.track,
    })

    registerServerRoutes(app, run, handlers, limits, cors, closingRequests.accept)

    if (core === undefined || threadCount === 0 || !detectRuntime().supportsWorkerThreads) return
    try {
      this.threads = await startRequestThreads({
        core,
        app,
        handlers,
        authorize,
        gate,
        bodyBudget,
        limits,
        allowRegex,
        build,
        cors,
        feeds: this.feeds,
      })
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
 * @throws A `NarsilError` with `CONFIG_INVALID` where the first argument is
 * some value other than an engine, and where a field of `options.limits` holds
 * a value outside its range.
 *
 * @public
 */
export function createServer(engine: Narsil, options?: ServerOptions): NarsilServer {
  return new NarsilHttpServer(engine, options)
}
