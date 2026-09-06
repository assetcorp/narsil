import type { ResponseSink } from '../response'
import type { RelayedResponse } from './messages'

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

/**
 * A response the main thread writes into on behalf of a request thread, which
 * collects the status, the headers, and the body a handler produces so that
 * the request thread can write them to the real connection.
 *
 * @internal
 */
export interface CapturingResponse {
  sink: ResponseSink
  done: Promise<CapturedResponse>
  finishUnanswered(): void
}

export function createCapturingResponse(remoteAddress: string): CapturingResponse {
  let status = DEFAULT_STATUS
  const headers: Array<[string, string]> = []
  let finished = false
  let resolveDone: (captured: CapturedResponse) => void = () => undefined
  const done = new Promise<CapturedResponse>(resolve => {
    resolveDone = resolve
  })

  function finish(body: Uint8Array): void {
    if (finished) return
    finished = true
    resolveDone({ status, headers, body })
  }

  const sink: ResponseSink = {
    cork(callback) {
      callback()
      return sink
    },
    writeStatus(line) {
      if (!finished) status = statusOf(line)
      return sink
    },
    writeHeader(key, value) {
      if (!finished) headers.push([key, value])
      return sink
    },
    end(body) {
      finish(bodyBytes(body))
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
    onWritable: () => sink,
    onAborted: () => sink,
    onData: () => sink,
    getRemoteAddressAsText: () => new TextEncoder().encode(remoteAddress).buffer,
  }

  return {
    sink,
    done,
    finishUnanswered(): void {
      if (finished) return
      status = NO_RESPONSE_STATUS
      finish(new Uint8Array(0))
    },
  }
}

export function toRelayedResponse(requestId: number, captured: CapturedResponse): RelayedResponse {
  return { type: 'response', requestId, status: captured.status, headers: captured.headers, body: captured.body }
}
