import { createServer, type Server as NetServer, type Socket } from 'node:net'
import type {
  Server,
  ServerCredentials,
  ServerUnaryCall,
  ServerWritableStream,
  ServiceDefinition,
  sendUnaryData,
} from '@grpc/grpc-js'
import { GRPC_INBOUND_CONNECTION_LIMIT } from '../constants'
import { drainedOrClosed } from '../drained-or-closed'
import { decodeTransportMessage, encodeTransportMessage } from '../tcp/framing'
import type { ListenHandler, RespondFn } from '../types'
import { TransportError, TransportErrorCodes, type TransportMessage } from '../types'
import type { GrpcModule } from './loader'
import { nodeTransportService } from './service'
import { channelOptions, type GrpcTransportConfig, toCredentialBuffer } from './types'

function errorEnvelope(requestId: string, err: unknown): TransportMessage {
  const errorMsg = err instanceof Error ? err.message : String(err)
  return {
    type: 'error',
    sourceId: '',
    requestId,
    payload: new TextEncoder().encode(errorMsg),
  }
}

function unbracketedHost(host: string): string {
  if (host.length >= 2 && host.startsWith('[') && host.endsWith(']')) {
    return host.slice(1, -1)
  }
  return host
}

export class GrpcServerHost {
  private readonly grpc: GrpcModule
  private readonly config: GrpcTransportConfig
  private server: Server | null = null
  private listener: NetServer | null = null
  private readonly sockets = new Set<Socket>()
  private handler: ListenHandler | null = null
  private boundPort = 0
  private closed = false

  constructor(grpc: GrpcModule, config: GrpcTransportConfig) {
    this.grpc = grpc
    this.config = config
  }

  getPort(): number {
    return this.boundPort
  }

  async start(handler: ListenHandler): Promise<() => void> {
    if (this.closed) {
      throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'gRPC server has been shut down')
    }

    const previousHandler = this.handler
    this.handler = handler

    const restore = (): void => {
      if (this.handler === handler) {
        this.handler = previousHandler ?? null
      }
    }

    if (this.server !== null) {
      return restore
    }

    const server = new this.grpc.Server(channelOptions())
    server.addService(nodeTransportService as unknown as ServiceDefinition, {
      send: (call: ServerUnaryCall<Uint8Array, Uint8Array>, callback: sendUnaryData<Uint8Array>) => {
        this.handleSend(call, callback)
      },
      openStream: (call: ServerWritableStream<Uint8Array, Uint8Array>) => {
        this.handleOpenStream(call)
      },
    })

    const address = `${this.config.host}:${this.config.port}`

    return new Promise<() => void>((resolve, reject) => {
      const injector = server.createConnectionInjector(this.serverCredentials())
      const listener = createServer(socket => {
        this.sockets.add(socket)
        socket.once('close', () => this.sockets.delete(socket))
        injector.injectConnection(socket)
      })
      listener.maxConnections = GRPC_INBOUND_CONNECTION_LIMIT
      listener.on('error', err => {
        if (this.listener !== null) {
          return
        }
        injector.destroy()
        reject(
          new TransportError(TransportErrorCodes.CONNECT_FAILED, `gRPC server failed to start: ${err.message}`, {
            address,
          }),
        )
      })
      listener.listen(this.config.port, unbracketedHost(this.config.host), () => {
        const bound = listener.address()
        this.server = server
        this.listener = listener
        this.boundPort = bound !== null && typeof bound === 'object' ? bound.port : this.config.port
        resolve(restore)
      })
    })
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.handler = null

    const listener = this.listener
    this.listener = null
    if (this.server !== null) {
      this.server.forceShutdown()
      this.server = null
    }
    for (const socket of this.sockets) {
      socket.destroy()
    }
    this.sockets.clear()
    if (listener !== null) {
      await new Promise<void>(resolve => {
        listener.close(() => resolve())
      })
    }
  }

  private serverCredentials(): ServerCredentials {
    const tls = this.config.tls
    if (tls === undefined) {
      return this.grpc.ServerCredentials.createInsecure()
    }
    return this.grpc.ServerCredentials.createSsl(
      tls.ca !== undefined ? toCredentialBuffer(tls.ca) : null,
      [{ private_key: toCredentialBuffer(tls.key), cert_chain: toCredentialBuffer(tls.cert) }],
      tls.rejectUnauthorized ?? true,
    )
  }

  private handleSend(call: ServerUnaryCall<Uint8Array, Uint8Array>, callback: sendUnaryData<Uint8Array>): void {
    const handler = this.handler
    if (handler === null) {
      callback(this.statusError(this.grpc.status.UNAVAILABLE, 'No listener is registered'))
      return
    }

    let message: TransportMessage
    try {
      message = decodeTransportMessage(call.request)
    } catch (err) {
      callback(null, encodeTransportMessage(errorEnvelope('', err)))
      return
    }

    let responded = false
    const respond: RespondFn = async (response: TransportMessage): Promise<void> => {
      if (responded) {
        return
      }
      responded = true
      callback(null, encodeTransportMessage(response))
    }

    this.runHandler(handler, message, respond, err => {
      if (!responded) {
        responded = true
        callback(null, encodeTransportMessage(errorEnvelope(message.requestId, err)))
      }
    })
  }

  private handleOpenStream(call: ServerWritableStream<Uint8Array, Uint8Array>): void {
    const handler = this.handler
    if (handler === null) {
      call.emit('error', this.statusError(this.grpc.status.UNAVAILABLE, 'No listener is registered'))
      return
    }

    let message: TransportMessage
    try {
      message = decodeTransportMessage(call.request)
    } catch (err) {
      call.emit(
        'error',
        this.statusError(this.grpc.status.INVALID_ARGUMENT, err instanceof Error ? err.message : String(err)),
      )
      return
    }

    let chunkCount = 0
    const respond: RespondFn = (response: TransportMessage): Promise<void> => {
      if (!call.writable) {
        return Promise.resolve()
      }
      chunkCount++
      if (call.write(response.payload)) {
        return Promise.resolve()
      }
      return drainedOrClosed(call)
    }

    const fail = (err: unknown): void => {
      call.emit('error', this.statusError(this.grpc.status.UNKNOWN, err instanceof Error ? err.message : String(err)))
    }

    const finish = (): void => {
      if (chunkCount > 0) {
        call.end()
      } else {
        fail(new Error('The stream handler produced no chunks'))
      }
    }

    try {
      const result = handler(message, respond)
      if (result instanceof Promise) {
        result.then(finish, fail)
      } else {
        finish()
      }
    } catch (err) {
      fail(err)
    }
  }

  private statusError(code: number, details: string): Error {
    return Object.assign(new Error(details), { code, details })
  }

  private runHandler(
    handler: ListenHandler,
    message: TransportMessage,
    respond: RespondFn,
    onFailure: (err: unknown) => void,
  ): void {
    try {
      const result = handler(message, respond)
      if (result instanceof Promise) {
        result.catch(onFailure)
      }
    } catch (err) {
      onFailure(err)
    }
  }
}
