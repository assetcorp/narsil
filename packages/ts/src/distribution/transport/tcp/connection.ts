import { MAX_MESSAGE_SIZE_BYTES } from '../constants'
import { replyDeadlineMs } from '../reply-deadline'
import { TransportError, TransportErrorCodes, type TransportMessage } from '../types'
import { dialPeer, type PeerLink } from './dial'
import { encodeFrame, encodeTransportMessage } from './framing'
import type { PeerConnection } from './peer-connection'
import { FRAME_TYPE_REQUEST, type TcpTransportConfig, type TlsConfig } from './types'

export class TcpConnectionPool {
  private readonly current = new Map<string, PeerLink>()
  private readonly open = new Set<PeerLink>()
  private config: TcpTransportConfig
  private closed = false

  constructor(config: TcpTransportConfig) {
    this.config = config
  }

  updateTlsConfig(nextTlsConfig: TlsConfig): void {
    this.config = {
      ...this.config,
      tls: nextTlsConfig,
    }
  }

  async send(target: string, message: TransportMessage): Promise<TransportMessage> {
    this.assertOpen(target)
    const frame = requestFrame(target, message)
    const connection = await this.connectionTo(target)
    return connection.send(message.requestId, frame, replyDeadlineMs(message.type, this.config))
  }

  async stream(target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void): Promise<void> {
    this.assertOpen(target)
    const frame = requestFrame(target, message)
    const connection = await this.connectionTo(target)
    return connection.stream(message.requestId, frame, this.config.snapshotTimeout, handler)
  }

  async shutdown(): Promise<void> {
    this.closed = true
    const links = [...this.open]
    for (const link of links) link.shutDown()
    await Promise.all(links.map(link => link.closed))
  }

  private assertOpen(target: string): void {
    if (this.closed) {
      throw new TransportError(TransportErrorCodes.CONNECT_FAILED, 'Connection pool has been shut down', { target })
    }
  }

  private connectionTo(target: string): Promise<PeerConnection> {
    const current = this.current.get(target)
    if (current?.usable()) return current.connection

    const link = dialPeer(target, this.config)
    this.current.set(target, link)
    this.open.add(link)
    void link.closed.then(() => {
      this.open.delete(link)
      if (this.current.get(target) === link) this.current.delete(target)
    })
    return link.connection
  }
}

function requestFrame(target: string, message: TransportMessage): Uint8Array {
  const messageBytes = encodeTransportMessage(message)
  if (messageBytes.byteLength > MAX_MESSAGE_SIZE_BYTES) {
    throw new TransportError(
      TransportErrorCodes.MESSAGE_TOO_LARGE,
      `Message payload (${messageBytes.byteLength} bytes) exceeds the ${MAX_MESSAGE_SIZE_BYTES} byte limit`,
      { target, requestId: message.requestId, payloadSize: messageBytes.byteLength },
    )
  }
  return encodeFrame(FRAME_TYPE_REQUEST, message.requestId, messageBytes)
}
