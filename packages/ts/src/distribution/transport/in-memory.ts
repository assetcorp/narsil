import {
  DEFAULT_TRANSPORT_CONFIG,
  MAX_MESSAGE_SIZE_BYTES,
  type NodeTransport,
  type TransportConfig,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from './types'

type ListenHandler = (message: TransportMessage, respond: (response: TransportMessage) => void) => void

type StreamResponder = (chunks: Uint8Array[]) => void

export interface InMemoryTransportInternal extends NodeTransport {
  deliverMessage(message: TransportMessage, respond: (response: TransportMessage) => void): void
  deliverStream(message: TransportMessage, responder: StreamResponder): void
}

export interface InMemoryNetwork {
  register(nodeId: string, transport: InMemoryTransportInternal): void
  unregister(nodeId: string): void
  getTransport(nodeId: string): InMemoryTransportInternal | undefined
}

export function createInMemoryNetwork(): InMemoryNetwork {
  const transports = new Map<string, InMemoryTransportInternal>()

  return {
    register(nodeId: string, transport: InMemoryTransportInternal): void {
      transports.set(nodeId, transport)
    },

    unregister(nodeId: string): void {
      transports.delete(nodeId)
    },

    getTransport(nodeId: string): InMemoryTransportInternal | undefined {
      return transports.get(nodeId)
    },
  }
}

export function createInMemoryTransport(
  nodeId: string,
  network: InMemoryNetwork,
  config?: Partial<TransportConfig>,
): NodeTransport {
  const resolvedConfig: TransportConfig = {
    ...DEFAULT_TRANSPORT_CONFIG,
    ...config,
  }

  let listenHandler: ListenHandler | undefined
  let isShutdown = false

  function assertNotShutdown(): void {
    if (isShutdown) {
      throw new TransportError(
        TransportErrorCodes.PEER_UNAVAILABLE,
        `Transport for node '${nodeId}' has been shut down`,
        { nodeId },
      )
    }
  }

  function lookupPeer(target: string): InMemoryTransportInternal {
    const peer = network.getTransport(target)
    if (peer === undefined) {
      throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, `Node '${target}' is not reachable`, { target })
    }
    return peer
  }

  const internal: InMemoryTransportInternal = {
    deliverMessage(message: TransportMessage, respond: (response: TransportMessage) => void): void {
      if (listenHandler === undefined) {
        return
      }
      listenHandler(message, respond)
    },

    deliverStream(message: TransportMessage, responder: StreamResponder): void {
      if (listenHandler === undefined) {
        return
      }

      const chunks: Uint8Array[] = []
      listenHandler(message, (response: TransportMessage) => {
        chunks.push(response.payload)
      })
      responder(chunks)
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
      const peer = lookupPeer(target)

      return new Promise<TransportMessage>((resolve, reject) => {
        let settled = false
        const timeoutId = setTimeout(() => {
          if (!settled) {
            settled = true
            reject(
              new TransportError(
                TransportErrorCodes.TIMEOUT,
                `Request to node '${target}' timed out after ${resolvedConfig.requestTimeout}ms`,
                { target, requestId: message.requestId, timeoutMs: resolvedConfig.requestTimeout },
              ),
            )
          }
        }, resolvedConfig.requestTimeout)

        try {
          peer.deliverMessage(message, (response: TransportMessage) => {
            if (!settled) {
              settled = true
              clearTimeout(timeoutId)
              resolve(response)
            }
          })
        } catch (error) {
          if (!settled) {
            settled = true
            clearTimeout(timeoutId)
            reject(error)
          }
        }
      })
    },

    async stream(target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void): Promise<void> {
      assertNotShutdown()
      const peer = lookupPeer(target)

      return new Promise<void>((resolve, reject) => {
        let settled = false
        const timeoutId = setTimeout(() => {
          if (!settled) {
            settled = true
            reject(
              new TransportError(
                TransportErrorCodes.TIMEOUT,
                `Stream to node '${target}' timed out after ${resolvedConfig.snapshotTimeout}ms`,
                { target, requestId: message.requestId, timeoutMs: resolvedConfig.snapshotTimeout },
              ),
            )
          }
        }, resolvedConfig.snapshotTimeout)

        try {
          peer.deliverStream(message, (chunks: Uint8Array[]) => {
            if (!settled) {
              settled = true
              clearTimeout(timeoutId)
              for (const chunk of chunks) {
                handler(chunk)
              }
              resolve()
            }
          })
        } catch (error) {
          if (!settled) {
            settled = true
            clearTimeout(timeoutId)
            reject(error)
          }
        }
      })
    },

    async listen(handler: ListenHandler): Promise<void> {
      listenHandler = handler
    },

    async shutdown(): Promise<void> {
      if (isShutdown) {
        return
      }
      isShutdown = true
      network.unregister(nodeId)
      listenHandler = undefined
    },
  }

  network.register(nodeId, internal)

  return internal
}
