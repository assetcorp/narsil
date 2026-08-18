import type {
  Server,
  ServerCredentials,
  ServerUnaryCall,
  ServerWritableStream,
  ServiceDefinition,
  sendUnaryData,
} from '@grpc/grpc-js'
import { decodeTransportMessage, encodeTransportMessage } from '../tcp/framing'
import { TransportError, TransportErrorCodes, type TransportMessage } from '../types'
import type { GrpcModule } from './loader'
import { nodeTransportService } from './service'
import { channelOptions, type GrpcTransportConfig } from './types'

type ListenHandler = (message: TransportMessage, respond: (response: TransportMessage) => void) => void | Promise<void>

function toBuffer(material: Buffer | string): Buffer {
  return typeof material === 'string' ? Buffer.from(material) : material
}

function errorEnvelope(requestId: string, err: unknown): TransportMessage {
  const errorMsg = err instanceof Error ? err.message : String(err)
  return {
    type: 'error',
    sourceId: '',
    requestId,
    payload: new TextEncoder().encode(errorMsg),
  }
}

export class GrpcServerHost {
  private readonly grpc: GrpcModule
  private readonly config: GrpcTransportConfig
  private server: Server | null = null
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
      server.bindAsync(address, this.serverCredentials(), (err, port) => {
        if (err !== null) {
          reject(
            new TransportError(TransportErrorCodes.CONNECT_FAILED, `gRPC server failed to start: ${err.message}`, {
              address,
            }),
          )
          return
        }
        this.server = server
        this.boundPort = port
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

    if (this.server !== null) {
      this.server.forceShutdown()
      this.server = null
    }
  }

  private serverCredentials(): ServerCredentials {
    const tls = this.config.tls
    if (tls === undefined) {
      return this.grpc.ServerCredentials.createInsecure()
    }
    return this.grpc.ServerCredentials.createSsl(
      tls.ca !== undefined ? toBuffer(tls.ca) : null,
      [{ private_key: toBuffer(tls.key), cert_chain: toBuffer(tls.cert) }],
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
    const respond = (response: TransportMessage): void => {
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
    const respond = (response: TransportMessage): void => {
      if (call.writable) {
        chunkCount++
        call.write(response.payload)
      }
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
    respond: (response: TransportMessage) => void,
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
