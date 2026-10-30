import type { CallOptions, ChannelCredentials, Client, Metadata } from '@grpc/grpc-js'
import { MAX_MESSAGE_SIZE_BYTES } from '../constants'
import { replyDeadlineMs } from '../reply-deadline'
import { decodeTransportMessage, encodeTransportMessage } from '../tcp/framing'
import { TransportError, TransportErrorCodes, type TransportMessage } from '../types'
import type { GrpcModule } from './loader'
import { openStreamMethod, sendMethod } from './service'
import { channelOptions, type GrpcTransportConfig, toCredentialBuffer } from './types'

const CONNECT_PROBE_PATH = '/narsil.transport.v1.ConnectProbe/LastError'
const LAST_ERROR_PATTERN = /Last error: (?:Error: )?(.*?)\. Resolution note:/s

interface StatusCarrier {
  code?: number
  message?: string
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
    const client = await this.readyClient(target)
    const responseBytes = await this.unaryCall(
      client,
      target,
      message.requestId,
      messageBytes,
      replyDeadlineMs(message.type, this.config),
    )

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
      {},
    )

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timeoutMs = this.config.snapshotTimeout
      let idleTimer: ReturnType<typeof setTimeout> | null = null

      const settle = (fn: () => void): void => {
        if (idleTimer !== null) clearTimeout(idleTimer)
        if (!settled) {
          settled = true
          fn()
        }
      }

      const rearm = (): void => {
        if (idleTimer !== null) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          call.cancel()
          settle(() =>
            reject(
              new TransportError(
                TransportErrorCodes.TIMEOUT,
                `No chunk of the stream from '${target}' arrived within ${timeoutMs}ms`,
                { target, requestId: message.requestId, timeoutMs },
              ),
            ),
          )
        }, timeoutMs)
      }
      rearm()

      call.on('data', (chunk: Uint8Array) => {
        rearm()
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
      throw new TransportError(TransportErrorCodes.CONNECT_FAILED, 'gRPC client pool has been shut down')
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

  private async readyClient(target: string): Promise<Client> {
    const client = await this.getClient(target)
    if (client.getChannel().getConnectivityState(false) === this.grpc.connectivityState.READY) {
      return client
    }
    const ready = this.awaitReady(client, target)
    this.clients.set(target, ready)
    ready.catch(() => {
      if (this.clients.get(target) === ready) {
        this.clients.delete(target)
      }
    })
    return ready
  }

  private connect(target: string): Promise<Client> {
    return this.awaitReady(new this.grpc.Client(target, this.credentials(), channelOptions()), target)
  }

  private awaitReady(client: Client, target: string): Promise<Client> {
    const channel = client.getChannel()
    const { READY, SHUTDOWN, TRANSIENT_FAILURE } = this.grpc.connectivityState
    const deadline = Date.now() + this.config.connectTimeout

    return new Promise<Client>((resolve, reject) => {
      const fail = (reason: string): void => {
        client.close()
        reject(
          new TransportError(TransportErrorCodes.CONNECT_FAILED, `Failed to connect to '${target}': ${reason}`, {
            target,
          }),
        )
      }

      const check = (deadlinePassed?: Error): void => {
        if (deadlinePassed !== undefined) {
          fail(`no connection was ready within ${this.config.connectTimeout}ms`)
          return
        }
        try {
          const state = channel.getConnectivityState(true)
          if (state === READY) {
            resolve(client)
          } else if (state === TRANSIENT_FAILURE) {
            void this.lastConnectError(client, deadline).then(fail)
          } else if (state === SHUTDOWN) {
            fail('the channel shut down')
          } else {
            channel.watchConnectivityState(state, deadline, check)
          }
        } catch {
          fail('the channel closed')
        }
      }
      check()
    })
  }

  private lastConnectError(client: Client, deadline: number): Promise<string> {
    return new Promise<string>(resolve => {
      client.makeUnaryRequest(
        CONNECT_PROBE_PATH,
        sendMethod.requestSerialize,
        sendMethod.responseDeserialize,
        new Uint8Array(0),
        this.metadata(),
        { deadline },
        err => {
          const details = err?.details ?? ''
          resolve(LAST_ERROR_PATTERN.exec(details)?.[1] ?? (details === '' ? 'the channel failed to connect' : details))
        },
      )
    })
  }

  private credentials(): ChannelCredentials {
    const tls = this.config.tls
    if (tls === undefined) {
      return this.grpc.credentials.createInsecure()
    }
    return this.grpc.credentials.createSsl(
      tls.ca !== undefined ? toCredentialBuffer(tls.ca) : null,
      toCredentialBuffer(tls.key),
      toCredentialBuffer(tls.cert),
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

  private unaryCall(
    client: Client,
    target: string,
    requestId: string,
    messageBytes: Uint8Array,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      client.makeUnaryRequest(
        sendMethod.path,
        sendMethod.requestSerialize,
        sendMethod.responseDeserialize,
        messageBytes,
        this.metadata(),
        this.callOptions(timeoutMs),
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
