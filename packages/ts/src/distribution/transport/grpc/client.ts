import type { CallOptions, ChannelCredentials, Client, Metadata } from '@grpc/grpc-js'
import { MAX_MESSAGE_SIZE_BYTES } from '../constants'
import { replyDeadlineMs } from '../reply-deadline'
import { decodeTransportMessage, encodeTransportMessage } from '../tcp/framing'
import { TransportError, TransportErrorCodes, type TransportMessage } from '../types'
import { type ChannelConnect, connectChannel, connectFailed } from './channel-connect'
import type { GrpcModule } from './loader'
import { PeerSockets } from './peer-sockets'
import { openStreamMethod, sendMethod } from './service'
import { channelOptions, type GrpcTransportConfig, toCredentialBuffer } from './types'

interface StatusCarrier {
  code?: number
  message?: string
}

interface PeerClient {
  client: Client
  connecting?: ChannelConnect
}

export class GrpcClientPool {
  private readonly grpc: GrpcModule
  private readonly config: GrpcTransportConfig
  private readonly peers = new Map<string, PeerClient>()
  private readonly callsHandedOver = new Set<() => void>()
  private readonly sockets = new PeerSockets()
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
    const client = await this.readyClient(target)
    const call = this.handOver(target, () =>
      client.makeServerStreamRequest(
        openStreamMethod.path,
        openStreamMethod.requestSerialize,
        openStreamMethod.responseDeserialize,
        messageBytes,
        this.metadata(),
        {},
      ),
    )

    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timeoutMs = this.config.snapshotTimeout
      let idleTimer: ReturnType<typeof setTimeout> | null = null

      const settle = (fn: () => void): void => {
        if (idleTimer !== null) clearTimeout(idleTimer)
        this.callsHandedOver.delete(stop)
        if (!settled) {
          settled = true
          fn()
        }
      }

      const stop = (): void => {
        settle(() => reject(this.stoppedByShutdown(target, message.requestId)))
        call.cancel()
      }
      this.callsHandedOver.add(stop)

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
        if (settled) return
        rearm()
        try {
          handler(chunk)
        } catch (err) {
          call.cancel()
          settle(() => reject(err))
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
    this.closed = true

    for (const stop of [...this.callsHandedOver]) stop()
    this.callsHandedOver.clear()
    for (const { client, connecting } of this.peers.values()) {
      connecting?.cancel()
      client.close()
    }
    this.peers.clear()
    await this.sockets.closeAll()
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

  private async readyClient(target: string): Promise<Client> {
    this.assertOpen()
    const peer = this.peerAt(target)
    if (peer.connecting === undefined) {
      if (peer.client.getChannel().getConnectivityState(false) === this.grpc.connectivityState.READY) {
        return peer.client
      }
      const connecting = connectChannel(this.grpc, peer.client, target, this.config.connectTimeout)
      peer.connecting = connecting
      connecting.ready.then(
        () => {
          peer.connecting = undefined
        },
        () => {
          if (this.peers.get(target) === peer) this.peers.delete(target)
        },
      )
    }
    await peer.connecting.ready
    return peer.client
  }

  private peerAt(target: string): PeerClient {
    const existing = this.peers.get(target)
    if (existing !== undefined) return existing
    try {
      const credentials = this.sockets.closingOnRelease(this.credentials())
      const options = { ...channelOptions(), 'grpc.use_local_subchannel_pool': 1 }
      const peer: PeerClient = { client: new this.grpc.Client(target, credentials, options) }
      this.peers.set(target, peer)
      return peer
    } catch (err) {
      throw connectFailed(target, err instanceof Error ? err.message : String(err))
    }
  }

  private handOver<T>(target: string, start: () => T): T {
    this.assertOpen()
    try {
      return start()
    } catch (err) {
      throw connectFailed(target, err instanceof Error ? err.message : String(err))
    }
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
      let settled = false
      const stop = (): void => {
        reject(this.stoppedByShutdown(target, requestId))
        call.cancel()
      }
      const call = this.handOver(target, () =>
        client.makeUnaryRequest(
          sendMethod.path,
          sendMethod.requestSerialize,
          sendMethod.responseDeserialize,
          messageBytes,
          this.metadata(),
          this.callOptions(timeoutMs),
          (err, response) => {
            settled = true
            this.callsHandedOver.delete(stop)
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
        ),
      )
      if (!settled) this.callsHandedOver.add(stop)
    })
  }

  private stoppedByShutdown(target: string, requestId: string): TransportError {
    return new TransportError(
      TransportErrorCodes.PEER_UNAVAILABLE,
      `The transport shut down before '${target}' answered`,
      { target, requestId },
    )
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
