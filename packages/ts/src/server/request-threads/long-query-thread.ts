import type { MessagePort } from 'node:worker_threads'
import type { QueryParams } from '../../types/search'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import type { RouteHandler } from '../request'
import { answerRequest } from './answer-request'
import type { CapturingResponse } from './captured-response'
import { isLongQueryPortNote, type LongQueryThreadSettings, type RelayedRequest } from './messages'
import { createThreadReadEngine } from './read-engine'
import { createRelayClient, type RelayClient } from './relay-client'
import { searchHandler } from './thread'

interface LongQueryThread {
  relay: RelayClient
  ports: Set<MessagePort>
}

let serving: LongQueryThread | null = null

function isMovedRequest(message: unknown): message is RelayedRequest {
  if (typeof message !== 'object' || message === null) return false
  const { type, requestId } = message as { type?: unknown; requestId?: unknown }
  return type === 'request' && typeof requestId === 'number'
}

function streamNote(message: unknown): { type: 'stream-credit' | 'stream-cancel'; requestId: number } | null {
  if (typeof message !== 'object' || message === null) return null
  const { type, requestId } = message as { type?: unknown; requestId?: unknown }
  if (typeof requestId !== 'number') return null
  return type === 'stream-credit' || type === 'stream-cancel' ? { type, requestId } : null
}

function answerMovesOn(
  port: MessagePort,
  handlers: Record<'search' | 'preflight', RouteHandler>,
  enqueue: (work: () => Promise<void>) => () => void,
): void {
  const streams = new Map<number, CapturingResponse>()
  const waiting = new Map<number, () => void>()
  port.on('close', () => {
    for (const cancel of waiting.values()) cancel()
    waiting.clear()
    for (const stream of streams.values()) stream.cancel()
  })
  port.on('message', (message: unknown) => {
    const note = streamNote(message)
    if (note !== null) {
      if (note.type === 'stream-credit') streams.get(note.requestId)?.credit()
      else {
        waiting.get(note.requestId)?.()
        waiting.delete(note.requestId)
        streams.get(note.requestId)?.cancel()
      }
      return
    }
    if (!isMovedRequest(message)) return
    const handler = message.route === 'search' || message.route === 'preflight' ? handlers[message.route] : null
    if (handler === null) return
    const cancel = enqueue(async () => {
      waiting.delete(message.requestId)
      const answer = await answerRequest(handler, message, port, streams)
      if (answer !== null) port.postMessage(answer)
    })
    waiting.set(message.requestId, cancel)
  })
}

export function serveLongQueries(executor: DirectExecutorExtensions, settings: LongQueryThreadSettings): void {
  if (serving !== null) throw new Error('This worker already answers long queries')
  const relay = createRelayClient(settings.port, settings.touchIntervalMs)
  const local = createThreadReadEngine({
    executor,
    relay,
    searchHooks: false,
    patternWorkCap: settings.patternWorkCap,
    maxRerankWindow: settings.maxRerankWindow,
  })
  const afterWrites =
    <R>(answer: (indexName: string, params: QueryParams, signal: AbortSignal) => Promise<R>) =>
    async (indexName: string, params: QueryParams, signal: AbortSignal): Promise<R> => {
      await relay.awaitWrites(indexName, signal)
      return answer(indexName, params, signal)
    }
  const shared = {
    limits: settings.limits,
    allowRegex: settings.allowRegex,
    move: async () => false,
  }
  const query = afterWrites((name, params, signal) => local.queryHere(name, params, signal))
  const preflight = afterWrites((name, params, signal) => local.preflightHere(name, params, signal))
  const handlers = {
    search: searchHandler({
      ...shared,
      fallback: ctx => relay.request('search', ctx),
      staysOnThread: (name, params) => local.canAnswer(name, params),
      answer: query,
      answerHere: query,
    }),
    preflight: searchHandler({
      ...shared,
      fallback: ctx => relay.request('preflight', ctx),
      staysOnThread: (name, params) => local.canCount(name, params),
      answer: preflight,
      answerHere: preflight,
    }),
  }
  const thread: LongQueryThread = { relay, ports: new Set() }
  const pending = new Map<symbol, () => Promise<void>>()
  let draining = false
  async function drain(): Promise<void> {
    try {
      for (const [id, work] of pending) {
        pending.delete(id)
        await work().catch(() => undefined)
      }
    } finally {
      draining = false
    }
  }
  function enqueue(work: () => Promise<void>): () => void {
    const id = Symbol()
    pending.set(id, work)
    if (!draining) {
      draining = true
      queueMicrotask(() => void drain())
    }
    return () => {
      pending.delete(id)
    }
  }
  settings.port.on('message', (message: unknown) => {
    if (!isLongQueryPortNote(message) || serving !== thread) return
    thread.ports.add(message.port)
    message.port.on('close', () => thread.ports.delete(message.port))
    answerMovesOn(message.port, handlers, enqueue)
  })
  serving = thread
}

export function closeLongQueryThread(): void {
  if (serving === null) return
  const { relay, ports } = serving
  serving = null
  for (const port of ports) port.close()
  relay.close()
}
