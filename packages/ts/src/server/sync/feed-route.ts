import type { HttpRequest, HttpResponse, TemplatedApp, us_socket_context_t, WebSocket } from 'uWebSockets.js'
import { CHANGES_SUBPROTOCOL } from '../../changes/wire'
import { FEED_SOCKET_MAX_BACKPRESSURE_BYTES, FEED_SOCKET_MAX_PAYLOAD_BYTES } from '../../sync/feed/constants'
import type { FeedSocket } from '../../sync/feed/session'
import { SYNC_CLOSE_SERVER_ERROR, SYNC_SUBPROTOCOL } from '../../sync/protocol'
import { ServerErrorCodes, toHttpError } from '../errors'
import { type Authorization, initAbortHandler } from '../request'
import { sendError } from '../response'
import type { RequestContext } from '../types'

export interface FeedRoute {
  path: string
  subprotocol: string
}

export const SYNC_FEED_ROUTE: FeedRoute = { path: '/indexes/:name/sync/feed', subprotocol: SYNC_SUBPROTOCOL }

export const CHANGES_FEED_ROUTE: FeedRoute = {
  path: '/indexes/:name/changes/feed',
  subprotocol: CHANGES_SUBPROTOCOL,
}

export interface FeedEndpoint {
  receive(bytes: Uint8Array, binary: boolean): void
  drained(): void
  closedByPeer(): void
}

export interface FeedTicket {
  open(socket: FeedSocket): FeedEndpoint
  cancel(): void
}

export interface FeedGateway {
  authorize(context: RequestContext): Promise<Authorization>
  admit(indexName: string, expiresAt: number | null): Promise<FeedTicket>
}

interface FeedUserData {
  ticket: FeedTicket
  endpoint: FeedEndpoint | null
  closed: boolean
}

function offersSubprotocol(header: string, subprotocol: string): boolean {
  return header.split(',').some(value => value.trim() === subprotocol)
}

function indexNameOf(raw: string): string | null {
  if (!raw.includes('%')) return raw
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

function socketOf(ws: WebSocket<FeedUserData>): FeedSocket {
  const data = ws.getUserData()
  return {
    send(bytes) {
      if (data.closed) return
      ws.cork(() => {
        ws.send(bytes, true)
      })
    },
    bufferedAmount: () => (data.closed ? 0 : ws.getBufferedAmount()),
    close(code, reason) {
      if (data.closed) return
      data.closed = true
      ws.end(code, reason)
    },
  }
}

function refuse(res: HttpResponse, err: unknown): void {
  const { status, body } = toHttpError(err)
  sendError(res, status, body.code, body.message, body.details)
}

async function upgradeFeed(
  gateway: FeedGateway,
  subprotocol: string,
  res: HttpResponse,
  context: RequestContext,
  indexName: string,
  handshake: { key: string; extensions: string; socketContext: us_socket_context_t },
): Promise<void> {
  const abort = initAbortHandler(res)
  let authorization: Authorization
  try {
    authorization = await gateway.authorize(context)
  } catch {
    authorization = { allowed: false, denial: null }
  }
  if (abort.aborted) return
  if (!authorization.allowed) {
    const { denial } = authorization
    if (denial === null) sendError(res, 500, ServerErrorCodes.HOOK_ERROR, 'The onRequest hook threw an error')
    else sendError(res, denial.status, denial.code, denial.message)
    return
  }
  let ticket: FeedTicket
  try {
    ticket = await gateway.admit(indexName, authorization.expiresAt)
  } catch (err) {
    if (!abort.aborted) refuse(res, err)
    return
  }
  if (abort.aborted) {
    ticket.cancel()
    return
  }
  const userData: FeedUserData = { ticket, endpoint: null, closed: false }
  res.cork(() => {
    res.upgrade(userData, handshake.key, subprotocol, handshake.extensions, handshake.socketContext)
  })
}

export function registerFeedRoute(app: TemplatedApp, gateway: FeedGateway, route: FeedRoute): void {
  const { path, subprotocol } = route
  app.ws<FeedUserData>(path, {
    maxPayloadLength: FEED_SOCKET_MAX_PAYLOAD_BYTES,
    maxBackpressure: FEED_SOCKET_MAX_BACKPRESSURE_BYTES,
    upgrade(res: HttpResponse, req: HttpRequest, socketContext: us_socket_context_t) {
      const rawName = req.getParameter(0) ?? ''
      const protocols = req.getHeader('sec-websocket-protocol')
      const handshake = {
        key: req.getHeader('sec-websocket-key'),
        extensions: req.getHeader('sec-websocket-extensions'),
        socketContext,
      }
      const headers: Record<string, string> = {}
      req.forEach((key, value) => {
        headers[key] = value
      })
      const context: RequestContext = {
        method: req.getMethod().toUpperCase(),
        path: req.getUrl(),
        headers,
        remoteAddress: Buffer.from(res.getRemoteAddressAsText()).toString(),
      }
      const indexName = indexNameOf(rawName)
      if (indexName === null || !offersSubprotocol(protocols, subprotocol)) {
        res.onAborted(() => undefined)
        sendError(
          res,
          400,
          ServerErrorCodes.INVALID_REQUEST,
          indexName === null
            ? 'A path segment holds a percent-escape the server cannot decode'
            : `The upgrade must offer the subprotocol ${subprotocol}`,
        )
        return
      }
      void upgradeFeed(gateway, subprotocol, res, context, indexName, handshake).catch(() => undefined)
    },
    open(ws) {
      const data = ws.getUserData()
      try {
        data.endpoint = data.ticket.open(socketOf(ws))
      } catch {
        data.closed = true
        ws.end(SYNC_CLOSE_SERVER_ERROR, 'feed unavailable')
      }
    },
    message(ws, message, isBinary) {
      ws.getUserData().endpoint?.receive(new Uint8Array(message.slice(0)), isBinary)
    },
    drain(ws) {
      ws.getUserData().endpoint?.drained()
    },
    close(ws) {
      const data = ws.getUserData()
      data.closed = true
      data.endpoint?.closedByPeer()
    },
  })
}
