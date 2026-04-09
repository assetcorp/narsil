import {
  MAX_MESSAGE_SIZE_BYTES,
  type NodeTransport,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from '../types'
import { TcpConnectionPool } from './connection'
import { TcpServer } from './server'
import { DEFAULT_TCP_CONFIG, type TcpTransportConfig } from './types'

export type { TcpTransportConfig } from './types'

type ListenHandler = (message: TransportMessage, respond: (response: TransportMessage) => void) => void | Promise<void>

export function createTcpTransport(
  nodeId: string,
  config?: Partial<TcpTransportConfig>,
): NodeTransport & { getPort(): number } {
  const resolvedConfig: TcpTransportConfig = {
    ...DEFAULT_TCP_CONFIG,
    ...config,
  }

  const pool = new TcpConnectionPool(resolvedConfig)
  const server = new TcpServer(resolvedConfig)
  let isShutdown = false

  function assertNotShutdown(): void {
    if (isShutdown) {
      throw new TransportError(
        TransportErrorCodes.PEER_UNAVAILABLE,
        `TCP transport for node '${nodeId}' has been shut down`,
        { nodeId },
      )
    }
  }

  return {
    getPort(): number {
      return server.getPort()
    },

    async send(target: string, message: TransportMessage): Promise<TransportMessage> {
      assertNotShutdown()
      if (message.payload.byteLength > MAX_MESSAGE_SIZE_BYTES) {
        throw new TransportError(
          TransportErrorCodes.MESSAGE_TOO_LARGE,
          `Message payload (${message.payload.byteLength} bytes) exceeds the ${MAX_MESSAGE_SIZE_BYTES} byte limit`,
          { target, requestId: message.requestId, payloadSize: message.payload.byteLength },
        )
      }
      return pool.send(target, message)
    },

    async stream(target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void): Promise<void> {
      assertNotShutdown()
      return pool.stream(target, message, handler)
    },

    async listen(handler: ListenHandler): Promise<() => void> {
      assertNotShutdown()
      return server.start(handler)
    },

    async shutdown(): Promise<void> {
      if (isShutdown) {
        return
      }
      isShutdown = true
      await Promise.all([pool.shutdown(), server.shutdown()])
    },
  }
}
