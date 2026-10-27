import { ErrorCodes, NarsilError } from '../../errors'
import { encodeJson } from '../../json-encoding'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import { REQUEST_THREAD_DEPARTURE_DRAIN_MS } from '../constants'
import type { ResponseAbort, RouteHandler } from '../request'
import { type ResponseSink, statusLine } from '../response'
import type { ErrorEnvelope } from '../types'
import { awaitDepartureConfirmation, departureConfirmation, departureConfirmed } from './departure'
import type { RelayClient } from './relay-client'

const DEPARTURE_REFUSAL: ErrorEnvelope = {
  error: {
    code: ErrorCodes.WORKER_CRASHED,
    message: 'The request thread that held this connection failed, so retry the request on a new connection',
  },
}

interface RunningRequest {
  res: ResponseSink
  abort: ResponseAbort
}

interface Departure {
  begin(): void
  finish(exit: () => void): void
  leaveAtExit(): void
}

type ThreadExit = (code: unknown) => void

export interface ThreadDeparture {
  track(res: ResponseSink, abort: ResponseAbort): () => void
  guardRoute(handler: RouteHandler): RouteHandler
  guardExecutor(executor: DirectExecutorExtensions): DirectExecutorExtensions
}

export interface ThreadDepartureOptions {
  relay: RelayClient
  departure: Int32Array<SharedArrayBuffer>
  close: () => void
}

class ThreadDepartureSignal extends Error {}

const exitThread = process.exit.bind(process)
const endThread = threadEndOf(process)
let active: Departure | null = null
let installed = false

function threadEndOf(target: object): ThreadExit | null {
  const found: unknown = Reflect.get(target, 'reallyExit')
  if (typeof found !== 'function') return null
  return code => {
    Reflect.apply(found, target, [code])
  }
}

function refuse(request: RunningRequest): void {
  if (request.abort.aborted) return
  const payload = encodeJson(DEPARTURE_REFUSAL)
  try {
    request.res.cork(() => {
      request.res
        .writeStatus(statusLine(503))
        .writeHeader('Content-Type', 'application/json')
        .writeHeader('Connection', 'close')
        .end(payload, true)
    })
  } catch {}
}

function departedError(): NarsilError {
  return new NarsilError(ErrorCodes.WORKER_CRASHED, 'This request thread is leaving after a failure')
}

function crashWith(error: unknown): void {
  process.off('uncaughtException', leaveOnUncaughtError)
  setImmediate(() => {
    throw error
  })
}

function leaveOnUncaughtError(error: unknown): void {
  if (error instanceof ThreadDepartureSignal) return
  if (process.listenerCount('uncaughtException') > 1) return
  const leaving = active
  if (leaving === null) {
    crashWith(error)
    return
  }
  leaving.begin()
  leaving.finish(() => crashWith(error))
}

function exitAfterDeparture(code?: number | string | null): never {
  const leaving = active
  if (leaving === null) return exitThread(code)
  leaving.begin()
  leaving.finish(() => exitThread(code))
  throw new ThreadDepartureSignal('This request thread is leaving through process.exit')
}

function endAfterDeparture(end: ThreadExit): ThreadExit {
  return code => {
    const leaving = active
    if (leaving === null) {
      end(code)
      return
    }
    leaving.begin()
    leaving.finish(() => end(code))
    throw new ThreadDepartureSignal('This request thread is leaving through an exit that it held before it served')
  }
}

function leaveAtExit(): void {
  active?.leaveAtExit()
}

function install(): void {
  if (installed) return
  installed = true
  process.exit = exitAfterDeparture
  if (endThread !== null) Reflect.set(process, 'reallyExit', endAfterDeparture(endThread))
  process.on('uncaughtException', leaveOnUncaughtError)
  process.on('exit', leaveAtExit)
}

export function watchForDeparture(options: ThreadDepartureOptions): ThreadDeparture {
  const { relay, departure, close } = options
  const running = new Set<RunningRequest>()
  let departing = false
  let finishing = false

  function closeOnce(): void {
    if (active === state) active = null
    close()
  }

  const state: Departure = {
    begin() {
      if (departing) return
      departing = true
      for (const request of running) refuse(request)
      if (!departureConfirmed(departure)) relay.announceDeparture()
    },
    finish(exit) {
      if (finishing) return
      finishing = true
      departureConfirmation(departure)
        .then(() => new Promise<void>(resolve => setTimeout(resolve, REQUEST_THREAD_DEPARTURE_DRAIN_MS)))
        .catch(() => undefined)
        .then(() => {
          closeOnce()
          exit()
        })
    },
    leaveAtExit() {
      state.begin()
      if (endThread !== null) return
      awaitDepartureConfirmation(departure)
      closeOnce()
    },
  }

  active = state
  install()

  function refusingOnceDeparting<A extends unknown[], R>(call: (...args: A) => R): (...args: A) => R {
    return (...args) => {
      if (departing) throw departedError()
      return call(...args)
    }
  }

  return {
    track(res, abort) {
      const request: RunningRequest = { res, abort }
      if (departing) {
        refuse(request)
        return () => undefined
      }
      running.add(request)
      return () => {
        running.delete(request)
      }
    },
    guardRoute(handler) {
      return async ctx => {
        if (departing) {
          refuse(ctx)
          return
        }
        try {
          await handler(ctx)
        } catch (err) {
          if (!departing) throw err
        }
      }
    },
    guardExecutor(executor) {
      return {
        getManager: refusingOnceDeparting(indexName => executor.getManager(indexName)),
        queryContextOf: refusingOnceDeparting(indexName => executor.queryContextOf(indexName)),
        holdsVectorField: refusingOnceDeparting((indexName, fieldName) =>
          executor.holdsVectorField(indexName, fieldName),
        ),
        heldVectorOf: refusingOnceDeparting((indexName, fieldName, docId) =>
          executor.heldVectorOf(indexName, fieldName, docId),
        ),
        createIndex: refusingOnceDeparting((indexName, config, language, analysisStale) =>
          executor.createIndex(indexName, config, language, analysisStale),
        ),
        dropIndex: refusingOnceDeparting(indexName => executor.dropIndex(indexName)),
        listIndexes: refusingOnceDeparting(() => executor.listIndexes()),
      }
    },
  }
}

export function leaveWithoutDeparture(): void {
  active = null
}
