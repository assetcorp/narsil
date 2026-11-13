import { ErrorCodes, NarsilError } from '../../errors'
import type { DirectExecutorExtensions } from '../../workers/direct-executor'
import { REQUEST_THREAD_DEPARTURE_DRAIN_MS, REQUEST_THREAD_DRAIN_DEADLINE_MS } from '../constants'
import type { ResponseAbort, RouteHandler } from '../request'
import { stopResponse } from '../request-signal'
import type { ResponseSink } from '../response'
import type { ErrorEnvelope } from '../types'
import { awaitDepartureConfirmation, departureConfirmation, departureConfirmed } from './departure'
import { LeavingResponse, refuseAndClose } from './leaving-response'
import type { RelayClient } from './relay-client'

const DEPARTURE_REFUSAL: ErrorEnvelope = {
  error: {
    code: ErrorCodes.WORKER_CRASHED,
    message: 'The request thread that held this connection failed, so retry the request on a new connection',
  },
}

const DRAIN_DEADLINE_REFUSAL: ErrorEnvelope = {
  error: {
    code: ErrorCodes.WORKER_CRASHED,
    message: `The request thread that held this connection stopped after waiting ${REQUEST_THREAD_DRAIN_DEADLINE_MS}ms for this request to finish, so retry the request on a new connection`,
  },
}

const CLOSING_REFUSAL: ErrorEnvelope = {
  error: {
    code: ErrorCodes.WORKER_CRASHED,
    message: 'The request thread that held this connection is closing, so retry the request on a new connection',
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
  respondThrough(res: ResponseSink): ResponseSink
  track(res: ResponseSink, abort: ResponseAbort): () => void
  guardRoute(handler: RouteHandler, onMainThread?: RouteHandler): RouteHandler
  guardExecutor(executor: DirectExecutorExtensions): DirectExecutorExtensions
  drain(): Promise<void>
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

function refuse(request: RunningRequest, envelope: ErrorEnvelope): void {
  stopResponse(request.abort)
  if (request.abort.aborted) return
  const { res } = request
  try {
    if (res instanceof LeavingResponse) res.refuse(503, envelope)
    else refuseAndClose(res, 503, envelope)
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

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function settledBy(work: Promise<void>, deadline: number): Promise<void> {
  return new Promise<void>(resolve => {
    const timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))
    void work.then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      () => {
        clearTimeout(timer)
        resolve()
      },
    )
  })
}

export function watchForDeparture(options: ThreadDepartureOptions): ThreadDeparture {
  const { relay, departure, close } = options
  const running = new Set<RunningRequest>()
  const waitingForIdle: Array<() => void> = []
  let departing = false
  let finishing = false
  let draining = false
  let closing = false
  let drained: Promise<void> | null = null

  function closeOnce(): void {
    if (active === state) active = null
    close()
  }

  function leaving(): boolean {
    return departing || draining || departureConfirmed(departure)
  }

  function untrack(request: RunningRequest): void {
    if (!running.delete(request) || running.size > 0) return
    for (const resume of waitingForIdle.splice(0)) resume()
  }

  function idle(): Promise<void> {
    if (running.size === 0) return Promise.resolve()
    return new Promise<void>(resolve => waitingForIdle.push(resolve))
  }

  async function drainRunning(): Promise<void> {
    draining = true
    if (!departureConfirmed(departure)) relay.announceDeparture()
    const deadline = Date.now() + REQUEST_THREAD_DRAIN_DEADLINE_MS
    await settledBy(departureConfirmation(departure), deadline)
    await settledBy(idle(), deadline)
    closing = true
    for (const request of running) refuse(request, DRAIN_DEADLINE_REFUSAL)
    running.clear()
    await pause(REQUEST_THREAD_DEPARTURE_DRAIN_MS)
  }

  const state: Departure = {
    begin() {
      if (departing) return
      departing = true
      for (const request of running) refuse(request, DEPARTURE_REFUSAL)
      if (!departureConfirmed(departure)) relay.announceDeparture()
    },
    finish(exit) {
      if (finishing) return
      finishing = true
      departureConfirmation(departure)
        .then(() => pause(REQUEST_THREAD_DEPARTURE_DRAIN_MS))
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

  function refusalOnArrival(): ErrorEnvelope | null {
    if (departing) return DEPARTURE_REFUSAL
    return closing ? CLOSING_REFUSAL : null
  }

  function refusingOnceDeparting<A extends unknown[], R>(call: (...args: A) => R): (...args: A) => R {
    return (...args) => {
      if (departing) throw departedError()
      return call(...args)
    }
  }

  return {
    respondThrough(res) {
      return new LeavingResponse(res, leaving)
    },
    track(res, abort) {
      const request: RunningRequest = { res, abort }
      const refusal = refusalOnArrival()
      if (refusal !== null) {
        refuse(request, refusal)
        return () => undefined
      }
      running.add(request)
      let handled = false
      const settle = (): void => {
        if (!handled && !abort.aborted) return
        if (abort.aborted || !(res instanceof LeavingResponse) || res.isFinished) untrack(request)
      }
      if (res instanceof LeavingResponse) res.whenFinished(settle)
      abort.onAbort(settle)
      return () => {
        handled = true
        settle()
      }
    },
    guardRoute(handler, onMainThread) {
      return async ctx => {
        const refusal = refusalOnArrival()
        if (refusal !== null) {
          refuse(ctx, refusal)
          return
        }
        const answer = onMainThread !== undefined && leaving() ? onMainThread : handler
        try {
          await answer(ctx)
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
        pinVectorField: refusingOnceDeparting((indexName, fieldName) => executor.pinVectorField(indexName, fieldName)),
        createIndex: refusingOnceDeparting((indexName, config, language, analysisStale, synonyms, partitionCount) =>
          executor.createIndex(indexName, config, language, analysisStale, synonyms, partitionCount),
        ),
        dropIndex: refusingOnceDeparting(indexName => executor.dropIndex(indexName)),
        listIndexes: refusingOnceDeparting(() => executor.listIndexes()),
      }
    },
    drain() {
      if (departing) return Promise.resolve()
      if (drained === null) drained = drainRunning()
      return drained
    },
  }
}

export function leaveWithoutDeparture(): void {
  active = null
}
