import { createServer, type Server, type Socket } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import { TransportError, TransportErrorCodes, type TransportMessage } from '../types'
import { decodeTransportMessage, encodeFrame, encodeTransportMessage, FrameParser } from './framing'
import {
  FRAME_TYPE_REQUEST,
  FRAME_TYPE_RESPONSE,
  FRAME_TYPE_STREAM_CHUNK,
  FRAME_TYPE_STREAM_END,
  type TcpTransportConfig,
} from './types'

type ListenHandler = (message: TransportMessage, respond: (response: TransportMessage) => void) => void | Promise<void>

export class TcpServer {
  private server: Server | null = null
  private clients = new Set<Socket>()
  private config: TcpTransportConfig
  private handler: ListenHandler | null = null
  private closed = false
  private boundPort = 0

  constructor(config: TcpTransportConfig) {
    this.config = config
  }

  getPort(): number {
    return this.boundPort
  }

  async start(handler: ListenHandler): Promise<() => void> {
    if (this.closed) {
      throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'TCP server has been shut down')
    }

    const previousHandler = this.handler
    this.handler = handler

    if (this.server !== null) {
      return () => {
        if (this.handler === handler) {
          this.handler = previousHandler ?? null
        }
      }
    }

    return new Promise<() => void>((resolve, reject) => {
      const tlsConfig = this.config.tls
      const server: Server =
        tlsConfig !== undefined
          ? createTlsServer(
              {
                cert: tlsConfig.cert,
                key: tlsConfig.key,
                ca: tlsConfig.ca,
                requestCert: true,
                rejectUnauthorized: tlsConfig.rejectUnauthorized ?? true,
              },
              clientSocket => {
                this.handleClient(clientSocket)
              },
            )
          : createServer(clientSocket => {
              this.handleClient(clientSocket)
            })

      server.on('error', err => {
        if (this.server === null) {
          reject(new TransportError(TransportErrorCodes.CONNECT_FAILED, `TCP server failed to start: ${err.message}`))
        }
      })

      server.listen(this.config.port, this.config.host, () => {
        this.server = server
        const addr = server.address()
        if (addr !== null && typeof addr === 'object') {
          this.boundPort = addr.port
        }

        resolve(() => {
          if (this.handler === handler) {
            this.handler = previousHandler ?? null
          }
        })
      })
    })
  }

  private handleClient(socket: Socket): void {
    if (this.clients.size >= this.config.maxConnections) {
      socket.destroy()
      return
    }

    this.clients.add(socket)

    const parser = new FrameParser(frame => {
      if (frame.frameType !== FRAME_TYPE_REQUEST) {
        return
      }

      if (this.handler === null) {
        return
      }

      this.processRequest(socket, frame, this.handler)
    })

    socket.on('data', (data: Buffer) => {
      try {
        parser.feed(new Uint8Array(data))
      } catch (_) {
        socket.destroy()
      }
    })

    socket.on('error', () => {
      socket.destroy()
    })

    socket.on('close', () => {
      this.clients.delete(socket)
    })
  }

  private processRequest(socket: Socket, frame: { requestId: string; data: Uint8Array }, handler: ListenHandler): void {
    try {
      const message = decodeTransportMessage(frame.data)
      let respondCount = 0

      const result = handler(message, (response: TransportMessage) => {
        if (socket.destroyed) {
          return
        }

        respondCount++

        if (respondCount === 1) {
          const responseBytes = encodeTransportMessage(response)
          const responseFrame = encodeFrame(FRAME_TYPE_RESPONSE, frame.requestId, responseBytes)
          socket.write(responseFrame)
          return
        }

        const chunkFrame = encodeFrame(FRAME_TYPE_STREAM_CHUNK, frame.requestId, response.payload)
        socket.write(chunkFrame)
      })

      const finalize = (): void => {
        if (respondCount > 0 && !socket.destroyed) {
          const endFrame = encodeFrame(FRAME_TYPE_STREAM_END, frame.requestId, new Uint8Array(0))
          socket.write(endFrame)
        }
      }

      if (result instanceof Promise) {
        result.then(finalize, (err: unknown) => {
          this.sendErrorResponse(socket, frame.requestId, err)
        })
      } else {
        finalize()
      }
    } catch (err) {
      this.sendErrorResponse(socket, frame.requestId, err)
    }
  }

  private sendErrorResponse(socket: Socket, requestId: string, err: unknown): void {
    if (socket.destroyed) {
      return
    }
    const errorMsg = err instanceof Error ? err.message : String(err)
    const errorResponse: TransportMessage = {
      type: 'error',
      sourceId: '',
      requestId,
      payload: new TextEncoder().encode(errorMsg),
    }
    const responseBytes = encodeTransportMessage(errorResponse)
    const responseFrame = encodeFrame(FRAME_TYPE_RESPONSE, requestId, responseBytes)
    socket.write(responseFrame)
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.handler = null

    for (const client of this.clients) {
      client.destroy()
    }
    this.clients.clear()

    if (this.server !== null) {
      await new Promise<void>(resolve => {
        const server = this.server
        if (server === null) {
          resolve()
          return
        }
        server.close(() => resolve())
      })
      this.server = null
    }
  }
}
