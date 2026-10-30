import type { TemplatedApp } from 'uWebSockets.js'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import type { EngineCore } from '../../engine/core'
import type { RequestThreadListener } from '../../engine/orchestration'
import { resolveVectorText } from '../../engine/resolve-vector-text'
import { isNarsilError } from '../../errors'
import { rerankOnHost } from '../../rerank/call'
import type { Executor } from '../../workers/executor'
import { clearBodyBudgetSlot } from '../body-budget'
import { clearGateSlot, gateSlotOfWorker } from '../concurrency-gate'
import {
  INDEX_TOUCH_INTERVALS_PER_IDLE_TIMEOUT,
  MAX_INDEX_TOUCH_INTERVAL_MS,
  REQUEST_THREAD_CLOSE_AT_EXIT_MS,
} from '../constants'
import type { ResolvedCors } from '../cors'
import type { ResolvedBuild, ResolvedLimits } from '../deps'
import { toHttpError } from '../errors'
import type { Authorizer } from '../request'
import type { ServerHandlers } from '../routes'
import { type AcceptorApp, acceptorOf } from './acceptor'
import { answerRequest } from './answer-request'
import type { CapturingResponse } from './captured-response'
import { closeEveryThreadAtExit, createCloseAtExitWords } from './close-at-exit'
import { confirmDeparture, createDepartureWord, departureConfirmed } from './departure'
import type {
  AuthorizeRequest,
  AwaitWritesRequest,
  EmbedQueryRequest,
  RelayReply,
  RelayRequest,
  RerankQueryRequest,
  ServeRequestsResult,
} from './messages'

export interface RequestThreadHostOptions {
  core: EngineCore
  app: TemplatedApp
  handlers: ServerHandlers
  authorize: Authorizer | undefined
  gate: SharedArrayBuffer
  bodyBudget: SharedArrayBuffer
  limits: ResolvedLimits
  allowRegex: boolean
  build: ResolvedBuild
  cors: ResolvedCors | null
}

export interface RequestThreadHost {
  readonly threadCount: number
  /** Stops every thread taking requests, closing the connections each holds, and releases the ports. */
  stop(): Promise<void>
}

interface ServingThread {
  descriptor: unknown
  port: MessagePort
  executor: Executor
  departure: Int32Array<SharedArrayBuffer>
  closeAtExit: Int32Array<SharedArrayBuffer>
}

const RELAYED_TYPES: ReadonlySet<string> = new Set([
  'request',
  'authorize',
  'embed',
  'rerank',
  'await-writes',
  'stream-credit',
  'stream-cancel',
])

function isRelayRequest(message: unknown): message is RelayRequest {
  if (typeof message !== 'object' || message === null) return false
  const { type, requestId } = message as { type?: unknown; requestId?: unknown }
  if (type === 'touch' || type === 'leaving') return true
  return typeof requestId === 'number' && typeof type === 'string' && RELAYED_TYPES.has(type)
}

async function answerAuthorize(authorize: Authorizer | undefined, request: AuthorizeRequest): Promise<RelayReply> {
  if (authorize === undefined) {
    return { type: 'authorized', requestId: request.requestId, denial: null, hookError: false }
  }
  const authorization = await authorize(request.context)
  if (authorization.allowed) {
    return { type: 'authorized', requestId: request.requestId, denial: null, hookError: false }
  }
  return {
    type: 'authorized',
    requestId: request.requestId,
    denial: authorization.denial,
    hookError: authorization.denial === null,
  }
}

async function answerEmbed(core: EngineCore, request: EmbedQueryRequest): Promise<RelayReply> {
  try {
    const entry = core.requireIndex(request.indexName)
    const resolved = await resolveVectorText(
      { vector: request.vector },
      entry.embeddingAdapter,
      core.abortController.signal,
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

async function answerRerank(core: EngineCore, request: RerankQueryRequest): Promise<RelayReply> {
  try {
    const scores = await rerankOnHost(core, request.adapter, request.query, request.documents)
    return { type: 'reranked', requestId: request.requestId, scores, error: null }
  } catch (err) {
    if (!isNarsilError(err)) console.warn('Reranking a query for a request thread failed:', err)
    return { type: 'reranked', requestId: request.requestId, scores: null, error: toHttpError(err).body }
  }
}

async function answerAwaitWrites(core: EngineCore, request: AwaitWritesRequest): Promise<RelayReply> {
  await core.orchestrator.awaitWrites(request.indexName).catch(() => undefined)
  return { type: 'writes-applied', requestId: request.requestId }
}

function touchIntervalFor(copyIdleTimeoutMs: number): number {
  return Math.min(MAX_INDEX_TOUCH_INTERVAL_MS, Math.floor(copyIdleTimeoutMs / INDEX_TOUCH_INTERVALS_PER_IDLE_TIMEOUT))
}

export async function startRequestThreads(options: RequestThreadHostOptions): Promise<RequestThreadHost | null> {
  const found: AcceptorApp | null = acceptorOf(options.app)
  if (found === null) return null
  const acceptor: AcceptorApp = found
  const { core, handlers, authorize } = options
  const searchHooks = core.pluginRegistry.hasHooks('beforeSearch') || core.pluginRegistry.hasHooks('afterSearch')
  const touchIntervalMs = touchIntervalFor(core.orchestrator.copyIdleTimeoutMs())
  const threads = new Map<number, ServingThread>()
  const longQueriesInFlight = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  let longQueryThread: { workerId: number; port: MessagePort; executor: Executor } | null = null
  const closeAtExit = new Set<Int32Array<SharedArrayBuffer>>()
  let stopped = false

  function closeThreadsAtExit(): void {
    closeEveryThreadAtExit(closeAtExit, REQUEST_THREAD_CLOSE_AT_EXIT_MS)
  }

  function releaseDescriptor(thread: ServingThread): void {
    closeAtExit.delete(thread.closeAtExit)
    if (thread.descriptor !== null) {
      try {
        acceptor.removeChildAppDescriptor(thread.descriptor)
      } catch {}
    }
    confirmDeparture(thread.departure)
  }

  function relayFrom(thread: ServingThread): void {
    const { port } = thread
    const streams = new Map<number, CapturingResponse>()
    port.on('message', (message: unknown) => {
      if (!isRelayRequest(message)) return
      if (message.type === 'leaving') {
        releaseDescriptor(thread)
        return
      }
      if (message.type === 'touch') {
        core.orchestrator.noteAccess(message.indexName)
        return
      }
      if (message.type === 'stream-credit') {
        streams.get(message.requestId)?.credit()
        return
      }
      if (message.type === 'stream-cancel') {
        streams.get(message.requestId)?.cancel()
        return
      }
      const reply =
        message.type === 'request'
          ? answerRequest(handlers[message.route], message, port, streams)
          : message.type === 'authorize'
            ? answerAuthorize(authorize, message)
            : message.type === 'embed'
              ? answerEmbed(core, message)
              : message.type === 'await-writes'
                ? answerAwaitWrites(core, message)
                : answerRerank(core, message)
      void reply.then(answer => {
        if (answer !== null) port.postMessage(answer)
      })
    })
  }

  function connectToLongQueries(thread: ServingThread): void {
    if (longQueryThread === null) return
    const channel = new MessageChannel()
    thread.port.postMessage({ type: 'long-query-port', port: channel.port1 }, [channel.port1])
    longQueryThread.port.postMessage({ type: 'long-query-port', port: channel.port2 }, [channel.port2])
  }

  function dropLongQueryThread(): void {
    if (longQueryThread === null) return
    longQueryThread.port.close()
    longQueryThread = null
  }

  async function stopThread(workerId: number, thread: ServingThread): Promise<void> {
    releaseDescriptor(thread)
    thread.port.close()
    clearGateSlot(options.gate, gateSlotOfWorker(workerId))
    clearBodyBudgetSlot(options.bodyBudget, gateSlotOfWorker(workerId))
    await thread.executor.execute({ type: 'stopServing', requestId: `stop-serving-${workerId}` }).catch(() => undefined)
  }

  const listener: RequestThreadListener = {
    async onLongQueryWorkerReady(workerId: number, executor: Executor): Promise<void> {
      if (stopped) return
      dropLongQueryThread()
      const channel = new MessageChannel()
      const relaying: ServingThread = {
        descriptor: null,
        port: channel.port2,
        executor,
        departure: createDepartureWord(),
        closeAtExit: createCloseAtExitWords(),
      }
      relayFrom(relaying)
      try {
        await executor.execute(
          {
            type: 'serveLongQueries',
            requestId: `serve-long-queries-${workerId}`,
            settings: {
              port: channel.port1,
              touchIntervalMs,
              limits: options.limits,
              patternWorkCap: options.core.patternWorkCap,
              maxRerankWindow: options.core.rerankSettings.maxWindow,
              allowRegex: options.allowRegex,
            },
          },
          [channel.port1],
        )
      } catch (err) {
        channel.port2.close()
        console.warn(`Worker ${workerId} could not start answering long queries:`, err)
        return
      }
      if (stopped) {
        channel.port2.close()
        return
      }
      longQueryThread = { workerId, port: channel.port2, executor }
      for (const thread of threads.values()) connectToLongQueries(thread)
    },
    async onWorkerReady(workerId: number, executor: Executor): Promise<void> {
      if (stopped) return
      const channel = new MessageChannel()
      const thread: ServingThread = {
        descriptor: null,
        port: channel.port2,
        executor,
        departure: createDepartureWord(),
        closeAtExit: createCloseAtExitWords(),
      }
      relayFrom(thread)
      closeAtExit.add(thread.closeAtExit)
      const longQueries = longQueryThread
      const longQueryChannel = longQueries === null ? null : new MessageChannel()
      const transfer = longQueryChannel === null ? [channel.port1] : [channel.port1, longQueryChannel.port1]
      let result: ServeRequestsResult
      try {
        result = await executor.execute<ServeRequestsResult>(
          {
            type: 'serveRequests',
            requestId: `serve-${workerId}`,
            settings: {
              port: channel.port1,
              departure: thread.departure.buffer,
              closeAtExit: thread.closeAtExit.buffer,
              gate: options.gate,
              gateSlot: gateSlotOfWorker(workerId),
              maxConcurrentRequests: options.limits.maxConcurrentRequests,
              bodyBudget: options.bodyBudget,
              touchIntervalMs,
              cors: options.cors,
              limits: options.limits,
              build: options.build,
              authorizes: authorize !== undefined,
              searchHooks,
              patternWorkCap: options.core.patternWorkCap,
              maxRerankWindow: options.core.rerankSettings.maxWindow,
              allowRegex: options.allowRegex,
              longQueriesInFlight,
              longQueryPort: longQueryChannel?.port1 ?? null,
            },
          },
          transfer,
        )
      } catch (err) {
        closeAtExit.delete(thread.closeAtExit)
        channel.port2.close()
        longQueryChannel?.port2.close()
        console.warn(`Worker ${workerId} could not start taking requests:`, err)
        return
      }
      thread.descriptor = result.descriptor
      if (stopped || departureConfirmed(thread.departure)) {
        longQueryChannel?.port2.close()
        await stopThread(workerId, thread)
        return
      }
      if (longQueryChannel !== null && longQueries !== null && longQueryThread === longQueries) {
        longQueries.port.postMessage({ type: 'long-query-port', port: longQueryChannel.port2 }, [
          longQueryChannel.port2,
        ])
      } else {
        longQueryChannel?.port2.close()
        connectToLongQueries(thread)
      }
      acceptor.addChildAppDescriptor(result.descriptor)
      threads.set(workerId, thread)
    },
    onWorkerGone(workerId: number): void {
      if (longQueryThread?.workerId === workerId) {
        dropLongQueryThread()
        return
      }
      const thread = threads.get(workerId)
      if (thread === undefined) return
      threads.delete(workerId)
      releaseDescriptor(thread)
      thread.port.close()
      clearGateSlot(options.gate, gateSlotOfWorker(workerId))
      clearBodyBudgetSlot(options.bodyBudget, gateSlotOfWorker(workerId))
    },
  }

  process.on('exit', closeThreadsAtExit)
  await core.orchestrator.serveRequestsOnWorkers(listener)
  return {
    get threadCount() {
      return threads.size
    },
    async stop(): Promise<void> {
      stopped = true
      process.off('exit', closeThreadsAtExit)
      core.orchestrator.stopRequestThreads()
      const stopping = [...threads.entries()].map(([workerId, thread]) => {
        threads.delete(workerId)
        return stopThread(workerId, thread)
      })
      const longQueries = longQueryThread
      dropLongQueryThread()
      if (longQueries !== null) {
        stopping.push(
          longQueries.executor
            .execute({ type: 'stopServing', requestId: `stop-long-queries-${longQueries.workerId}` })
            .then(
              () => undefined,
              () => undefined,
            ),
        )
      }
      await Promise.all(stopping)
    },
  }
}
