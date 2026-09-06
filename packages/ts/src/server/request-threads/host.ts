import type { TemplatedApp } from 'uWebSockets.js'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import type { EngineCore } from '../../engine/core'
import type { RequestThreadListener } from '../../engine/orchestration'
import { resolveVectorText } from '../../engine/resolve-vector-text'
import { NarsilError } from '../../errors'
import type { Executor } from '../../workers/executor'
import { clearGateSlot, gateSlotOfWorker } from '../concurrency-gate'
import { INDEX_TOUCH_INTERVALS_PER_IDLE_TIMEOUT, MAX_INDEX_TOUCH_INTERVAL_MS } from '../constants'
import type { ResolvedCors } from '../cors'
import type { ResolvedBuild, ResolvedLimits } from '../deps'
import { ServerErrorCodes, serializeNarsilError } from '../errors'
import type { Authorizer, RouteContext } from '../request'
import { sendError } from '../response'
import type { ServerHandlers } from '../routes'
import { type AcceptorApp, acceptorOf } from './acceptor'
import { createCapturingResponse, toRelayedResponse } from './captured-response'
import type {
  AuthorizeRequest,
  EmbedQueryRequest,
  RelayedRequest,
  RelayReply,
  RelayRequest,
  ServeRequestsResult,
} from './messages'

export interface RequestThreadHostOptions {
  core: EngineCore
  app: TemplatedApp
  handlers: ServerHandlers
  authorize: Authorizer | undefined
  gate: SharedArrayBuffer
  limits: ResolvedLimits
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
}

const NO_ABORT = { aborted: false, onAbort: () => undefined }

function isRelayRequest(message: unknown): message is RelayRequest {
  if (typeof message !== 'object' || message === null) return false
  const { type, requestId } = message as { type?: unknown; requestId?: unknown }
  if (type === 'touch') return true
  return typeof requestId === 'number' && (type === 'request' || type === 'authorize' || type === 'embed')
}

async function answerRequest(handlers: ServerHandlers, request: RelayedRequest): Promise<RelayReply> {
  const captured = createCapturingResponse(request.hookContext?.remoteAddress ?? '')
  const ctx: RouteContext = {
    res: captured.sink,
    params: request.params,
    query: new URLSearchParams(request.query),
    contentType: request.contentType,
    rawBody: request.rawBody === null ? null : Buffer.from(request.rawBody),
    abort: NO_ABORT,
    hookContext: request.hookContext,
  }
  try {
    await handlers[request.route](ctx)
  } catch {
    sendError(ctx.res, 500, ServerErrorCodes.INTERNAL_ERROR, 'An unexpected error occurred')
  }
  captured.finishUnanswered()
  return toRelayedResponse(request.requestId, await captured.done)
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
    const error =
      err instanceof NarsilError
        ? serializeNarsilError(err)
        : { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) }
    return { type: 'embedded', requestId: request.requestId, value: null, error }
  }
}

function touchIntervalFor(copyIdleTimeoutMs: number): number {
  return Math.min(MAX_INDEX_TOUCH_INTERVAL_MS, Math.floor(copyIdleTimeoutMs / INDEX_TOUCH_INTERVALS_PER_IDLE_TIMEOUT))
}

/**
 * Turns the workers holding worker copies into request threads: each gets
 * its own port to the main thread, registers its app with the acceptor, and
 * from then on the acceptor moves every new connection to one of them in turn.
 *
 * @param options The engine, the acceptor app, the main thread's handlers, and the settings every thread copies.
 * @returns The host, which reports how many threads took requests, or null where the runtime offers no acceptor.
 *
 * @internal
 */
export async function startRequestThreads(options: RequestThreadHostOptions): Promise<RequestThreadHost | null> {
  const found: AcceptorApp | null = acceptorOf(options.app)
  if (found === null) return null
  const acceptor: AcceptorApp = found
  const { core, handlers, authorize } = options
  const searchHooks = core.pluginRegistry.hasHooks('beforeSearch') || core.pluginRegistry.hasHooks('afterSearch')
  const touchIntervalMs = touchIntervalFor(core.orchestrator.copyIdleTimeoutMs())
  const threads = new Map<number, ServingThread>()
  let stopped = false

  function relayFrom(port: MessagePort): void {
    port.on('message', (message: unknown) => {
      if (!isRelayRequest(message)) return
      if (message.type === 'touch') {
        core.orchestrator.noteAccess(message.indexName)
        return
      }
      const reply =
        message.type === 'request'
          ? answerRequest(handlers, message)
          : message.type === 'authorize'
            ? answerAuthorize(authorize, message)
            : answerEmbed(core, message)
      void reply.then(answer => port.postMessage(answer))
    })
  }

  async function stopThread(workerId: number, thread: ServingThread): Promise<void> {
    try {
      acceptor.removeChildAppDescriptor(thread.descriptor)
    } catch {}
    thread.port.close()
    clearGateSlot(options.gate, gateSlotOfWorker(workerId))
    await thread.executor.execute({ type: 'stopServing', requestId: `stop-serving-${workerId}` }).catch(() => undefined)
  }

  const listener: RequestThreadListener = {
    async onWorkerReady(workerId: number, executor: Executor): Promise<void> {
      if (stopped) return
      const channel = new MessageChannel()
      relayFrom(channel.port2)
      let result: ServeRequestsResult
      try {
        result = await executor.execute<ServeRequestsResult>(
          {
            type: 'serveRequests',
            requestId: `serve-${workerId}`,
            settings: {
              port: channel.port1,
              gate: options.gate,
              gateSlot: gateSlotOfWorker(workerId),
              maxConcurrentRequests: options.limits.maxConcurrentRequests,
              touchIntervalMs,
              cors: options.cors,
              limits: options.limits,
              build: options.build,
              authorizes: authorize !== undefined,
              searchHooks,
            },
          },
          [channel.port1],
        )
      } catch (err) {
        channel.port2.close()
        console.warn(`Worker ${workerId} could not start taking requests:`, err)
        return
      }
      const thread: ServingThread = { descriptor: result.descriptor, port: channel.port2, executor }
      if (stopped) {
        await stopThread(workerId, thread)
        return
      }
      acceptor.addChildAppDescriptor(result.descriptor)
      threads.set(workerId, thread)
    },
    onWorkerGone(workerId: number): void {
      const thread = threads.get(workerId)
      if (thread === undefined) return
      threads.delete(workerId)
      try {
        acceptor.removeChildAppDescriptor(thread.descriptor)
      } catch {}
      thread.port.close()
      clearGateSlot(options.gate, gateSlotOfWorker(workerId))
    },
  }

  await core.orchestrator.serveRequestsOnWorkers(listener)
  return {
    get threadCount() {
      return threads.size
    },
    async stop(): Promise<void> {
      stopped = true
      core.orchestrator.stopRequestThreads()
      const stopping = [...threads.entries()].map(([workerId, thread]) => {
        threads.delete(workerId)
        return stopThread(workerId, thread)
      })
      await Promise.all(stopping)
    },
  }
}
