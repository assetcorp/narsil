import type { HttpResponse } from 'uWebSockets.js'
import { encodeJson } from '../json-encoding'
import type { ResponseAbort } from './request'
import type { ErrorEnvelope } from './types'

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

const STREAM_THRESHOLD = 64 * 1024

function statusLine(status: number): string {
  return STATUS_TEXT[status] ?? `${status}`
}

function streamBody(
  res: HttpResponse,
  abort: ResponseAbort,
  body: Uint8Array,
  status: number,
  contentType: string,
): void {
  if (abort.aborted) return
  const totalSize = body.byteLength
  res.cork(() => {
    res.writeStatus(statusLine(status)).writeHeader('Content-Type', contentType)
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
 * above {@link STREAM_THRESHOLD} are streamed so a slow reader cannot pin the
 * whole payload in native memory; this needs the request's abort handle. */
export function sendJson(res: HttpResponse, data: unknown, status = 200, abort?: ResponseAbort): void {
  const payload = encodeJson(data)
  if (abort && payload !== undefined && Buffer.byteLength(payload) >= STREAM_THRESHOLD) {
    streamBody(res, abort, Buffer.from(payload, 'utf8'), status, 'application/json')
    return
  }
  res.cork(() => {
    res.writeStatus(statusLine(status)).writeHeader('Content-Type', 'application/json').end(payload)
  })
}

export function sendError(
  res: HttpResponse,
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
export function sendBinary(res: HttpResponse, data: Uint8Array, abort: ResponseAbort, status = 200): void {
  streamBody(res, abort, data, status, 'application/octet-stream')
}

export function sendEmpty(res: HttpResponse, status: number): void {
  res.cork(() => {
    res.writeStatus(statusLine(status)).endWithoutBody()
  })
}
