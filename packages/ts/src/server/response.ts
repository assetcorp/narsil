import { encodeJson } from '../json-encoding'
import { RESPONSE_STREAM_THRESHOLD_BYTES } from './constants'
import type { ResponseAbort } from './request'
import type { ErrorEnvelope } from './types'

/**
 * The part of a uWebSockets.js response the handlers write to, which the main
 * thread also satisfies with a capturing object when it answers a request a
 * request thread sent it.
 *
 * @internal
 */
export interface ResponseSink {
  cork(callback: () => void): ResponseSink
  writeStatus(status: string): ResponseSink
  writeHeader(key: string, value: string): ResponseSink
  end(body?: string | Uint8Array): ResponseSink
  endWithoutBody(): ResponseSink
  tryEnd(body: Uint8Array, totalSize: number): [boolean, boolean]
  getWriteOffset(): number
  onWritable(handler: (offset: number) => boolean): ResponseSink
  onAborted(handler: () => void): ResponseSink
  onData(handler: (chunk: ArrayBuffer, isLast: boolean) => void): ResponseSink
  getRemoteAddressAsText(): ArrayBuffer
}

const STATUS_TEXT: Record<number, string> = {
  200: '200 OK',
  201: '201 Created',
  202: '202 Accepted',
  204: '204 No Content',
  400: '400 Bad Request',
  401: '401 Unauthorized',
  403: '403 Forbidden',
  404: '404 Not Found',
  405: '405 Method Not Allowed',
  409: '409 Conflict',
  413: '413 Payload Too Large',
  415: '415 Unsupported Media Type',
  429: '429 Too Many Requests',
  500: '500 Internal Server Error',
  503: '503 Service Unavailable',
}

function statusLine(status: number): string {
  return STATUS_TEXT[status] ?? `${status}`
}

function streamBody(
  res: ResponseSink,
  abort: ResponseAbort,
  body: Uint8Array,
  status: number,
  headers: Array<[string, string]>,
): void {
  if (abort.aborted) return
  const totalSize = body.byteLength
  res.cork(() => {
    res.writeStatus(statusLine(status))
    for (const [key, value] of headers) res.writeHeader(key, value)
    const startOffset = res.getWriteOffset()
    const [, done] = res.tryEnd(body, totalSize)
    if (done) return
    res.onWritable(offset => {
      if (abort.aborted) return true
      const [retryOk] = res.tryEnd(body.subarray(offset - startOffset), totalSize)
      return retryOk
    })
  })
}

/** Writes a JSON body atomically. uWebSockets.js requires header and body
 * writes to share a single cork so the two reach the kernel as one syscall. Bodies at or
 * above {@link RESPONSE_STREAM_THRESHOLD_BYTES} are streamed so a slow reader cannot pin the
 * whole payload in native memory; this needs the request's abort handle. */
export function sendJson(res: ResponseSink, data: unknown, status = 200, abort?: ResponseAbort): void {
  const payload = encodeJson(data)
  if (abort && payload !== undefined && Buffer.byteLength(payload) >= RESPONSE_STREAM_THRESHOLD_BYTES) {
    streamBody(res, abort, Buffer.from(payload, 'utf8'), status, [['Content-Type', 'application/json']])
    return
  }
  res.cork(() => {
    res.writeStatus(statusLine(status)).writeHeader('Content-Type', 'application/json').end(payload)
  })
}

export function sendError(
  res: ResponseSink,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const body: ErrorEnvelope = { error: details ? { code, message, details } : { code, message } }
  const payload = encodeJson(body)
  res.cork(() => {
    res.writeStatus(statusLine(status)).writeHeader('Content-Type', 'application/json').end(payload)
  })
}

/** Streams a binary body with backpressure handling. The snapshot body is the
 * whole serialized index, so it is always streamed rather than copied into
 * native memory for a slow reader. */
export function sendBinary(res: ResponseSink, data: Uint8Array, abort: ResponseAbort, status = 200): void {
  streamBody(res, abort, data, status, [['Content-Type', 'application/octet-stream']])
}

export function sendEmpty(res: ResponseSink, status: number): void {
  res.cork(() => {
    res.writeStatus(statusLine(status)).endWithoutBody()
  })
}

/**
 * Writes a response the main thread produced for a request thread, as one
 * corked write for a small body and as a stream for a large one.
 *
 * @param res The response to write to.
 * @param abort The request's abort handle.
 * @param status The HTTP status to answer with.
 * @param headers Every header the main thread wrote.
 * @param body The body bytes.
 *
 * @internal
 */
export function sendRelayed(
  res: ResponseSink,
  abort: ResponseAbort,
  status: number,
  headers: Array<[string, string]>,
  body: Uint8Array,
): void {
  if (abort.aborted) return
  if (body.byteLength >= RESPONSE_STREAM_THRESHOLD_BYTES) {
    streamBody(res, abort, body, status, headers)
    return
  }
  res.cork(() => {
    res.writeStatus(statusLine(status))
    for (const [key, value] of headers) res.writeHeader(key, value)
    res.end(body)
  })
}
