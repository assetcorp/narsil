import type { TemplatedApp } from 'uWebSockets.js'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import type { EngineCore } from '../../engine/core'
import type { RequestThreadListener } from '../../engine/orchestration'
import { type Executor, executeUntilAnswered } from '../../workers/executor'
import { clearBodyBudgetSlot } from '../body-budget'
import { clearGateSlot, gateSlotOfWorker } from '../concurrency-gate'
import {
  INDEX_TOUCH_INTERVALS_PER_IDLE_TIMEOUT,
  MAX_INDEX_TOUCH_INTERVAL_MS,
  REQUEST_THREAD_CLOSE_AT_EXIT_MS,
} from '../constants'
import type { ResolvedCors } from '../cors'
import type { ResolvedBuild, ResolvedLimits } from '../deps'
import type { Authorizer } from '../request'
import type { ServerHandlers } from '../routes'
import type { FeedHost, ThreadFeeds } from '../sync/feed-host'
import { type FeedKind, isThreadFeedNote } from '../sync/feed-messages'
import { type AcceptorApp, acceptorOf } from './acceptor'
import { answerRequest } from './answer-request'
import type { CapturingResponse } from './captured-response'
import { closeEveryThreadAtExit, createCloseAtExitWords } from './close-at-exit'
import { confirmDeparture, createDepartureWord, departureConfirmed } from './departure'
import type { RelayRequest, ServeRequestsResult } from './messages'
import { answerAuthorize, answerAwaitWrites, answerEmbed, answerFeedAdmit, answerRerank } from './relay-answers'

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
  feeds: FeedHost | null
}

export interface RequestThreadHost {
  readonly threadCount: number
  /** Stops every thread taking requests, closing the connections each holds, and releases the ports. */
  stop(): Promise<void>
}

interface ServingThread {
  feeds: ThreadFeeds | null
  descriptor: unknown
  port: MessagePort
  executor: Executor
  departure: Int32Array<SharedArrayBuffer>
  closeAtExit: Int32Array<SharedArrayBuffer>
  closed: Promise<void>
}

function threadClosed(port: MessagePort, executor: Executor, clearSlots: () => void): Promise<void> {
  return new Promise(resolve => {
    let leftBehind = false
    port.once('close', () => {
      if (!leftBehind) clearSlots()
      resolve()
    })
    void executor.whenAbandoned?.().then(() => {
      leftBehind = true
      resolve()
    })
  })
}

const RELAYED_TYPES: ReadonlySet<string> = new Set([
  'request',
  'authorize',
  'embed',
  'rerank',
  'await-writes',
  'stream-credit',
  'stream-cancel',
  'feed-admit',
])

function isRelayRequest(message: unknown): message is RelayRequest {
  if (typeof message !== 'object' || message === null) return false
  const { type, requestId } = message as { type?: unknown; requestId?: unknown }
  if (type === 'touch' || type === 'leaving') return true
  return typeof requestId === 'number' && typeof type === 'string' && RELAYED_TYPES.has(type)
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
  const retiring = new Set<Promise<void>>()
  let stopped = false

  function closeThreadsAtExit(): void {
    closeEveryThreadAtExit(closeAtExit, REQUEST_THREAD_CLOSE_AT_EXIT_MS)
  }

  function releaseDescriptor(thread: ServingThread): void {
    thread.feeds?.closeAll()
    closeAtExit.delete(thread.closeAtExit)
    if (thread.descriptor !== null) {
      try {
        acceptor.removeChildAppDescriptor(thread.descriptor)
      } catch {}
      thread.descriptor = null
    }
    confirmDeparture(thread.departure)
  }

  function relayFrom(thread: ServingThread): void {
    const { port } = thread
    const streams = new Map<number, CapturingResponse>()
    const calls = new Map<number, AbortController>()
    port.on('close', () => {
      thread.feeds?.closeAll()
      for (const stream of streams.values()) stream.cancel()
      for (const call of calls.values()) call.abort()
      calls.clear()
    })
    port.on('message', (message: unknown) => {
      if (isThreadFeedNote(message)) {
        thread.feeds?.handle(message)
        return
      }
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
        calls.get(message.requestId)?.abort()
        calls.delete(message.requestId)
        return
      }
      const call = message.type === 'embed' || message.type === 'rerank' ? new AbortController() : undefined
      if (call !== undefined) calls.set(message.requestId, call)
      const reply =
        message.type === 'request'
          ? answerRequest(handlers[message.route], message, port, streams)
          : message.type === 'authorize'
            ? answerAuthorize(authorize, message)
            : message.type === 'feed-admit'
              ? answerFeedAdmit(thread.feeds, message)
              : message.type === 'embed'
                ? answerEmbed(core, message, call?.signal)
                : message.type === 'await-writes'
                  ? answerAwaitWrites(core, message)
                  : answerRerank(core, message, call?.signal)
      void reply.then(
        answer => {
          calls.delete(message.requestId)
          if (answer !== null) port.postMessage(answer)
        },
        () => {
          calls.delete(message.requestId)
        },
      )
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

  function retireThread(workerId: number, thread: ServingThread): Promise<void> {
    releaseDescriptor(thread)
    thread.port.unref()
    retiring.add(thread.closed)
    void thread.closed.then(() => retiring.delete(thread.closed))
    void executeUntilAnswered(thread.executor, { type: 'stopServing', requestId: `stop-serving-${workerId}` }).catch(
      () => undefined,
    )
    return thread.closed
  }

  const listener: RequestThreadListener = {
    async onLongQueryWorkerReady(workerId: number, executor: Executor): Promise<void> {
      if (stopped) return
      dropLongQueryThread()
      const channel = new MessageChannel()
      const relaying: ServingThread = {
        feeds: null,
        descriptor: null,
        port: channel.port2,
        executor,
        departure: createDepartureWord(),
        closeAtExit: createCloseAtExitWords(),
        closed: new Promise(resolve => channel.port2.once('close', resolve)),
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
        feeds: options.feeds?.forThread(channel.port2) ?? null,
        descriptor: null,
        port: channel.port2,
        executor,
        departure: createDepartureWord(),
        closeAtExit: createCloseAtExitWords(),
        closed: threadClosed(channel.port2, executor, () => {
          clearGateSlot(options.gate, gateSlotOfWorker(workerId))
          clearBodyBudgetSlot(options.bodyBudget, gateSlotOfWorker(workerId))
        }),
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
              feeds: Object.keys(options.feeds?.gateways ?? {}) as FeedKind[],
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
        await retireThread(workerId, thread)
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
      void retireThread(workerId, thread)
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
      const stopping = [...threads.entries()].map(([workerId, thread]) => {
        threads.delete(workerId)
        return retireThread(workerId, thread)
      })
      core.orchestrator.stopRequestThreads()
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
      await Promise.all([...stopping, ...retiring])
    },
  }
}
