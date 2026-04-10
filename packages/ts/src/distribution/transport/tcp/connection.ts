import { connect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { MAX_MESSAGE_SIZE_BYTES, TransportError, TransportErrorCodes, type TransportMessage } from '../types'
import { decodeTransportMessage, encodeFrame, encodeTransportMessage, FrameParser, type WireFrame } from './framing'
import {
  FRAME_TYPE_REQUEST,
  FRAME_TYPE_RESPONSE,
  FRAME_TYPE_STREAM_CHUNK,
  FRAME_TYPE_STREAM_END,
  type TcpTransportConfig,
} from './types'

export type { WireFrame } from './framing'
export { decodeTransportMessage, encodeFrame, encodeTransportMessage, FrameParser } from './framing'

interface PendingRequest {
  target: string
  resolve: (message: TransportMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingStream {
  target: string
  handler: (chunk: Uint8Array) => void
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class TcpConnectionPool {
  private connections = new Map<string, Socket>()
  private pendingRequests = new Map<string, PendingRequest>()
  private pendingStreams = new Map<string, PendingStream>()
  private parsers = new Map<string, FrameParser>()
  private config: TcpTransportConfig
  private closed = false

  constructor(config: TcpTransportConfig) {
    this.config = config
  }

  async send(target: string, message: TransportMessage): Promise<TransportMessage> {
    if (this.closed) {
      throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'Connection pool has been shut down')
    }

    const messageBytes = encodeTransportMessage(message)
    if (messageBytes.byteLength > MAX_MESSAGE_SIZE_BYTES) {
      throw new TransportError(
        TransportErrorCodes.MESSAGE_TOO_LARGE,
        `Message payload (${messageBytes.byteLength} bytes) exceeds the ${MAX_MESSAGE_SIZE_BYTES} byte limit`,
        { target, requestId: message.requestId, payloadSize: messageBytes.byteLength },
      )
    }

    const socket = await this.getOrCreateConnection(target)
    const frame = encodeFrame(FRAME_TYPE_REQUEST, message.requestId, messageBytes)
    const pendingKey = `${target}:${message.requestId}`

    return new Promise<TransportMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(pendingKey)
        reject(
          new TransportError(
            TransportErrorCodes.TIMEOUT,
            `Request to '${target}' timed out after ${this.config.requestTimeout}ms`,
            {
              target,
              requestId: message.requestId,
              timeoutMs: this.config.requestTimeout,
            },
          ),
        )
      }, this.config.requestTimeout)

      this.pendingRequests.set(pendingKey, { target, resolve, reject, timer })

      socket.write(frame, err => {
        if (err) {
          clearTimeout(timer)
          this.pendingRequests.delete(pendingKey)
          reject(
            new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, `Failed to write to '${target}': ${err.message}`, {
              target,
              requestId: message.requestId,
            }),
          )
        }
      })
    })
  }

  async stream(target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void): Promise<void> {
    if (this.closed) {
      throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'Connection pool has been shut down')
    }

    const messageBytes = encodeTransportMessage(message)
    const socket = await this.getOrCreateConnection(target)
    const frame = encodeFrame(FRAME_TYPE_REQUEST, message.requestId, messageBytes)
    const pendingKey = `${target}:${message.requestId}`

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingStreams.delete(pendingKey)
        reject(
          new TransportError(
            TransportErrorCodes.TIMEOUT,
            `Stream to '${target}' timed out after ${this.config.snapshotTimeout}ms`,
            {
              target,
              requestId: message.requestId,
              timeoutMs: this.config.snapshotTimeout,
            },
          ),
        )
      }, this.config.snapshotTimeout)

      this.pendingStreams.set(pendingKey, { target, handler, resolve, reject, timer })

      socket.write(frame, err => {
        if (err) {
          clearTimeout(timer)
          this.pendingStreams.delete(pendingKey)
          reject(
            new TransportError(
              TransportErrorCodes.PEER_UNAVAILABLE,
              `Failed to write stream to '${target}': ${err.message}`,
              {
                target,
                requestId: message.requestId,
              },
            ),
          )
        }
      })
    })
  }

  private async getOrCreateConnection(target: string): Promise<Socket> {
    const existing = this.connections.get(target)
    if (existing !== undefined && !existing.destroyed) {
      return existing
    }

    const [host, portStr] = parseAddress(target)
    const port = Number.parseInt(portStr, 10)
    if (Number.isNaN(port) || port < 0 || port > 65535) {
      throw new TransportError(TransportErrorCodes.CONNECT_FAILED, `Invalid port in target address '${target}'`, {
        target,
      })
    }

    return new Promise<Socket>((resolve, reject) => {
      let settled = false
      const tlsConfig = this.config.tls

      const socket: Socket =
        tlsConfig !== undefined
          ? tlsConnect({
              host,
              port,
              cert: tlsConfig.cert,
              key: tlsConfig.key,
              ca: tlsConfig.ca,
              rejectUnauthorized: tlsConfig.rejectUnauthorized ?? true,
            })
          : connect({ host, port })

      const connectEvent = tlsConfig !== undefined ? 'secureConnect' : 'connect'

      const connectTimer = setTimeout(() => {
        if (!settled) {
          settled = true
          socket.destroy()
          reject(
            new TransportError(
              TransportErrorCodes.TIMEOUT,
              `Connection to '${target}' timed out after ${this.config.connectTimeout}ms`,
              { target, timeoutMs: this.config.connectTimeout },
            ),
          )
        }
      }, this.config.connectTimeout)

      socket.once(connectEvent, () => {
        if (settled) {
          socket.destroy()
          return
        }
        settled = true
        clearTimeout(connectTimer)
        this.setupConnection(target, socket)
        resolve(socket)
      })

      socket.once('error', err => {
        if (!settled) {
          settled = true
          clearTimeout(connectTimer)
          reject(
            new TransportError(TransportErrorCodes.CONNECT_FAILED, `Failed to connect to '${target}': ${err.message}`, {
              target,
            }),
          )
        }
      })
    })
  }

  private setupConnection(target: string, socket: Socket): void {
    this.connections.set(target, socket)

    const parser = new FrameParser(frame => {
      this.handleIncomingFrame(target, frame)
    })
    this.parsers.set(target, parser)

    socket.on('data', (data: Buffer) => {
      try {
        parser.feed(new Uint8Array(data))
      } catch (err) {
        this.handleConnectionError(target, err instanceof Error ? err : new Error(String(err)))
      }
    })

    socket.on('error', err => {
      this.handleConnectionError(target, err)
    })

    socket.on('close', () => {
      this.connections.delete(target)
      this.parsers.delete(target)
    })
  }

  private handleIncomingFrame(target: string, frame: WireFrame): void {
    const pendingKey = `${target}:${frame.requestId}`

    if (frame.frameType === FRAME_TYPE_RESPONSE) {
      const pendingReq = this.pendingRequests.get(pendingKey)
      if (pendingReq !== undefined) {
        this.pendingRequests.delete(pendingKey)
        clearTimeout(pendingReq.timer)
        try {
          const message = decodeTransportMessage(frame.data)
          pendingReq.resolve(message)
        } catch (err) {
          pendingReq.reject(
            new TransportError(
              TransportErrorCodes.DECODE_FAILED,
              `Failed to decode response: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
        }
        return
      }

      const pendingStream = this.pendingStreams.get(pendingKey)
      if (pendingStream !== undefined) {
        try {
          const message = decodeTransportMessage(frame.data)
          pendingStream.handler(message.payload)
        } catch (_) {
          /* stream chunk decode failure is non-fatal for the stream */
        }
      }
      return
    }

    if (frame.frameType === FRAME_TYPE_STREAM_CHUNK) {
      const pending = this.pendingStreams.get(pendingKey)
      if (pending !== undefined) {
        pending.handler(frame.data)
      }
      return
    }

    if (frame.frameType === FRAME_TYPE_STREAM_END) {
      const pending = this.pendingStreams.get(pendingKey)
      if (pending !== undefined) {
        this.pendingStreams.delete(pendingKey)
        clearTimeout(pending.timer)
        pending.resolve()
      }
    }
  }

  private handleConnectionError(target: string, err: Error): void {
    const socket = this.connections.get(target)
    this.connections.delete(target)
    this.parsers.delete(target)
    if (socket !== undefined && !socket.destroyed) {
      socket.destroy()
    }

    const error = new TransportError(
      TransportErrorCodes.PEER_UNAVAILABLE,
      `Connection to '${target}' lost: ${err.message}`,
      {
        target,
      },
    )

    for (const [pendingKey, pending] of this.pendingRequests) {
      if (pending.target !== target) {
        continue
      }
      clearTimeout(pending.timer)
      this.pendingRequests.delete(pendingKey)
      pending.reject(error)
    }

    for (const [pendingKey, pending] of this.pendingStreams) {
      if (pending.target !== target) {
        continue
      }
      clearTimeout(pending.timer)
      this.pendingStreams.delete(pendingKey)
      pending.reject(error)
    }
  }

  getConnection(target: string): Socket | undefined {
    const conn = this.connections.get(target)
    if (conn?.destroyed) {
      this.connections.delete(target)
      return undefined
    }
    return conn
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true

    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'Connection pool shutting down'))
    }
    this.pendingRequests.clear()

    for (const [, pending] of this.pendingStreams) {
      clearTimeout(pending.timer)
      pending.reject(new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'Connection pool shutting down'))
    }
    this.pendingStreams.clear()

    const closePromises: Promise<void>[] = []
    for (const [target, socket] of this.connections) {
      closePromises.push(
        new Promise<void>(resolve => {
          socket.once('close', () => resolve())
          socket.destroy()
        }),
      )
      this.connections.delete(target)
    }
    this.parsers.clear()

    await Promise.all(closePromises)
  }
}

export function parseAddress(address: string): [string, string] {
  const lastColon = address.lastIndexOf(':')
  if (lastColon === -1) {
    throw new TransportError(
      TransportErrorCodes.CONNECT_FAILED,
      `Invalid address format '${address}', expected host:port`,
      {
        address,
      },
    )
  }
  const host = address.slice(0, lastColon)
  const port = address.slice(lastColon + 1)
  if (host.length === 0 || host.includes('\0')) {
    throw new TransportError(TransportErrorCodes.CONNECT_FAILED, `Invalid host in address '${address}'`, { address })
  }
  return [host, port]
}
