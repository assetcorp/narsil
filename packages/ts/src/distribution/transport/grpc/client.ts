import type { CallOptions, ChannelCredentials, Client, Metadata } from '@grpc/grpc-js'
import { decodeTransportMessage, encodeTransportMessage } from '../tcp/framing'
import { MAX_MESSAGE_SIZE_BYTES, TransportError, TransportErrorCodes, type TransportMessage } from '../types'
import type { GrpcModule } from './loader'
import { openStreamMethod, sendMethod } from './service'
import { channelOptions, type GrpcTransportConfig } from './types'

interface StatusCarrier {
  code?: number
  message?: string
}

function toBuffer(material: Buffer | string): Buffer {
  return typeof material === 'string' ? Buffer.from(material) : material
}

export class GrpcClientPool {
  private readonly grpc: GrpcModule
  private readonly config: GrpcTransportConfig
  private readonly clients = new Map<string, Promise<Client>>()
  private closed = false

  constructor(grpc: GrpcModule, config: GrpcTransportConfig) {
    this.grpc = grpc
    this.config = config
  }

  async send(target: string, message: TransportMessage): Promise<TransportMessage> {
    const messageBytes = this.encodeChecked(target, message)
    const client = await this.getClient(target)
    const responseBytes = await this.unaryCall(client, target, message.requestId, messageBytes)

    try {
      return decodeTransportMessage(responseBytes)
    } catch (err) {
      throw new TransportError(
        TransportErrorCodes.DECODE_FAILED,
        `Failed to decode response: ${err instanceof Error ? err.message : String(err)}`,
        { target, requestId: message.requestId },
      )
    }
  }

  async stream(target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void): Promise<void> {
    const messageBytes = this.encodeChecked(target, message)
    const client = await this.getClient(target)
    const call = client.makeServerStreamRequest(
      openStreamMethod.path,
      openStreamMethod.requestSerialize,
      openStreamMethod.responseDeserialize,
      messageBytes,
      this.metadata(),
      this.callOptions(this.config.snapshotTimeout),
    )

    return new Promise<void>((resolve, reject) => {
      let settled = false

      const settle = (fn: () => void): void => {
        if (!settled) {
          settled = true
          fn()
        }
      }

      call.on('data', (chunk: Uint8Array) => {
        try {
          handler(chunk)
        } catch (err) {
          call.cancel()
          settle(() =>
            reject(
              new TransportError(
                TransportErrorCodes.DECODE_FAILED,
                `Stream chunk handler failed: ${err instanceof Error ? err.message : String(err)}`,
                { target, requestId: message.requestId },
              ),
            ),
          )
        }
      })

      call.on('end', () => {
        settle(resolve)
      })

      call.on('error', (err: Error) => {
        settle(() => reject(this.mapCallError(target, message.requestId, err)))
      })
    })
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true

    const pending = Array.from(this.clients.values())
    this.clients.clear()

    await Promise.all(
      pending.map(clientPromise =>
        clientPromise.then(
          client => {
            client.close()
          },
          () => undefined,
        ),
      ),
    )
  }

  private encodeChecked(target: string, message: TransportMessage): Uint8Array {
    this.assertOpen()
    const messageBytes = encodeTransportMessage(message)
    if (messageBytes.byteLength > MAX_MESSAGE_SIZE_BYTES) {
      throw new TransportError(
        TransportErrorCodes.MESSAGE_TOO_LARGE,
        `Message payload (${messageBytes.byteLength} bytes) exceeds the ${MAX_MESSAGE_SIZE_BYTES} byte limit`,
        { target, requestId: message.requestId, payloadSize: messageBytes.byteLength },
      )
    }
    return messageBytes
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, 'gRPC client pool has been shut down')
    }
  }

  private getClient(target: string): Promise<Client> {
    this.assertOpen()

    const existing = this.clients.get(target)
    if (existing !== undefined) {
      return existing
    }

    const clientPromise = this.connect(target)
    this.clients.set(target, clientPromise)
    clientPromise.catch(() => {
      if (this.clients.get(target) === clientPromise) {
        this.clients.delete(target)
      }
    })
    return clientPromise
  }

  private connect(target: string): Promise<Client> {
    const client = new this.grpc.Client(target, this.credentials(), channelOptions())

    return new Promise<Client>((resolve, reject) => {
      client.waitForReady(Date.now() + this.config.connectTimeout, err => {
        if (err === undefined) {
          resolve(client)
          return
        }
        client.close()
        reject(
          new TransportError(TransportErrorCodes.CONNECT_FAILED, `Failed to connect to '${target}': ${err.message}`, {
            target,
          }),
        )
      })
    })
  }

  private credentials(): ChannelCredentials {
    const tls = this.config.tls
    if (tls === undefined) {
      return this.grpc.credentials.createInsecure()
    }
    return this.grpc.credentials.createSsl(
      tls.ca !== undefined ? toBuffer(tls.ca) : null,
      toBuffer(tls.key),
      toBuffer(tls.cert),
      {
        rejectUnauthorized: tls.rejectUnauthorized ?? true,
      },
    )
  }

  private metadata(): Metadata {
    return new this.grpc.Metadata()
  }

  private callOptions(timeoutMs: number): CallOptions {
    return { deadline: Date.now() + timeoutMs }
  }

  private unaryCall(client: Client, target: string, requestId: string, messageBytes: Uint8Array): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      client.makeUnaryRequest(
        sendMethod.path,
        sendMethod.requestSerialize,
        sendMethod.responseDeserialize,
        messageBytes,
        this.metadata(),
        this.callOptions(this.config.requestTimeout),
        (err, response) => {
          if (err !== null) {
            reject(this.mapCallError(target, requestId, err))
            return
          }
          if (response === undefined) {
            reject(
              new TransportError(TransportErrorCodes.DECODE_FAILED, `Empty response from '${target}'`, {
                target,
                requestId,
              }),
            )
            return
          }
          resolve(response)
        },
      )
    })
  }

  private mapCallError(target: string, requestId: string, err: Error): TransportError {
    const status = (err as StatusCarrier).code
    const details = { target, requestId }

    if (status === this.grpc.status.DEADLINE_EXCEEDED) {
      return new TransportError(
        TransportErrorCodes.TIMEOUT,
        `Request to '${target}' timed out: ${err.message}`,
        details,
      )
    }
    if (status === this.grpc.status.RESOURCE_EXHAUSTED) {
      return new TransportError(
        TransportErrorCodes.MESSAGE_TOO_LARGE,
        `Message to '${target}' exceeded a size limit: ${err.message}`,
        details,
      )
    }
    return new TransportError(
      TransportErrorCodes.PEER_UNAVAILABLE,
      `Request to '${target}' failed: ${err.message}`,
      details,
    )
  }
}
