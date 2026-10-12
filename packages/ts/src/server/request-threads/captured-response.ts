import { RELAY_STREAM_CHUNKS_IN_FLIGHT } from '../constants'
import type { ResponseAbort } from '../request'
import type { ResponseSink } from '../response'
import type { RelayedResponse, RelayedStreamPart } from './messages'

export interface CapturedResponse {
  status: number
  headers: Array<[string, string]>
  body: Uint8Array
}

const DEFAULT_STATUS = 200
const NO_RESPONSE_STATUS = 500

function statusOf(line: string): number {
  const parsed = Number.parseInt(line, 10)
  return Number.isFinite(parsed) ? parsed : DEFAULT_STATUS
}

function bodyBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0)
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  return body
}

export type StreamPartSender = (part: RelayedStreamPart, transfer: ArrayBuffer[]) => void

export interface CapturingResponse {
  sink: ResponseSink
  abort: ResponseAbort
  done: Promise<CapturedResponse | null>
  credit(): void
  cancel(): void
  finishUnanswered(): void
}

function createRelayAbort(): ResponseAbort & { trigger(): void } {
  const listeners: Array<() => void> = []
  let aborted = false
  return {
    get aborted() {
      return aborted
    },
    onAbort(fn) {
      if (aborted) fn()
      else listeners.push(fn)
    },
    trigger() {
      if (aborted) return
      aborted = true
      for (const fn of listeners) fn()
    },
  }
}

export function createCapturingResponse(
  remoteAddress: string,
  requestId: number,
  sendPart: StreamPartSender,
): CapturingResponse {
  let status = DEFAULT_STATUS
  const headers: Array<[string, string]> = []
  let finished = false
  let streaming = false
  let inFlight = 0
  let writable: ((offset: number) => boolean) | null = null
  const abort = createRelayAbort()
  let resolveDone: (captured: CapturedResponse | null) => void = () => undefined
  const done = new Promise<CapturedResponse | null>(resolve => {
    resolveDone = resolve
  })

  function finish(body: Uint8Array): void {
    if (finished) return
    finished = true
    if (streaming) {
      sendPart({ type: 'stream-end', requestId, failed: false }, [])
      resolveDone(null)
      return
    }
    resolveDone({ status, headers, body })
  }

  function startStreaming(): void {
    if (streaming) return
    streaming = true
    sendPart({ type: 'stream-start', requestId, status, headers }, [])
  }

  const sink: ResponseSink = {
    cork(callback) {
      callback()
      return sink
    },
    writeStatus(line) {
      if (!finished && !streaming) status = statusOf(line)
      return sink
    },
    writeHeader(key, value) {
      if (!finished && !streaming) headers.push([key, value])
      return sink
    },
    end(body) {
      finish(bodyBytes(body))
      return sink
    },
    write(chunk) {
      if (finished || abort.aborted) return true
      startStreaming()
      const copy = chunk.slice()
      inFlight += 1
      sendPart({ type: 'stream-chunk', requestId, chunk: copy }, [copy.buffer as ArrayBuffer])
      return inFlight < RELAY_STREAM_CHUNKS_IN_FLIGHT
    },
    pause: () => undefined,
    resume: () => undefined,
    close() {
      if (finished) return sink
      finished = true
      if (streaming) {
        sendPart({ type: 'stream-end', requestId, failed: true }, [])
        resolveDone(null)
      } else {
        status = NO_RESPONSE_STATUS
        resolveDone({ status, headers, body: new Uint8Array(0) })
      }
      return sink
    },
    endWithoutBody() {
      finish(new Uint8Array(0))
      return sink
    },
    tryEnd(body) {
      finish(body)
      return [true, true]
    },
    getWriteOffset: () => 0,
    onWritable(handler) {
      writable = handler
      return sink
    },
    onAborted: () => sink,
    onData: () => sink,
    getRemoteAddressAsText: () => new TextEncoder().encode(remoteAddress).buffer,
  }

  return {
    sink,
    abort,
    done,
    credit(): void {
      inFlight = Math.max(0, inFlight - 1)
      if (inFlight >= RELAY_STREAM_CHUNKS_IN_FLIGHT || writable === null) return
      const handler = writable
      writable = null
      handler(0)
    },
    cancel(): void {
      abort.trigger()
      if (writable !== null) {
        const handler = writable
        writable = null
        handler(0)
      }
      if (!finished) {
        finished = true
        resolveDone(null)
      }
    },
    finishUnanswered(): void {
      if (finished) return
      if (streaming) {
        finished = true
        sendPart({ type: 'stream-end', requestId, failed: true }, [])
        resolveDone(null)
        return
      }
      status = NO_RESPONSE_STATUS
      finish(new Uint8Array(0))
    },
  }
}

export function toRelayedResponse(requestId: number, captured: CapturedResponse): RelayedResponse {
  return { type: 'response', requestId, status: captured.status, headers: captured.headers, body: captured.body }
}
