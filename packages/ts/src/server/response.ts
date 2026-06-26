import type { HttpResponse } from 'uWebSockets.js'
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

function statusLine(status: number): string {
  return STATUS_TEXT[status] ?? `${status}`
}

/** Writes a JSON body atomically. uWebSockets.js requires header and body
 * writes to share a single cork so the kernel sees one syscall. */
export function sendJson(res: HttpResponse, data: unknown, status = 200): void {
  const payload = JSON.stringify(data)
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
  const payload = JSON.stringify(body)
  res.cork(() => {
    res.writeStatus(statusLine(status)).writeHeader('Content-Type', 'application/json').end(payload)
  })
}

export function sendBinary(res: HttpResponse, data: Uint8Array, status = 200): void {
  res.cork(() => {
    res.writeStatus(statusLine(status)).writeHeader('Content-Type', 'application/octet-stream').end(data)
  })
}

export function sendEmpty(res: HttpResponse, status: number): void {
  res.cork(() => {
    res.writeStatus(statusLine(status)).endWithoutBody()
  })
}
