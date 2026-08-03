import {
  DEFAULT_TRANSPORT_CONFIG,
  MAX_MESSAGE_SIZE_BYTES,
  type NodeTransport,
  type TransportConfig,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from './types'

type ListenHandler = (message: TransportMessage, respond: (response: TransportMessage) => void) => void | Promise<void>

/**
 * Receives the chunks a streamed response carries, in order.
 *
 * @param chunks - Every chunk the responder produced.
 *
 * @public
 */
export type StreamResponder = (chunks: Uint8Array[]) => void

/**
 * The delivery side of an in-memory transport, which the network calls to hand
 * a peer its message.
 *
 * You reach this through {@link InMemoryNetwork} rather than building one, so
 * treat it as the connection between two in-process nodes.
 *
 * @public
 */
export interface InMemoryTransportInternal extends NodeTransport {
  /**
   * Delivers one request to this node's listener.
   *
   * @param message - The request the sender posted.
   * @param respond - Hands the reply back to the sender.
   */
  deliverMessage(message: TransportMessage, respond: (response: TransportMessage) => void): void
  /**
   * Delivers one streamed request to this node's listener.
   *
   * @param message - The request the sender posted.
   * @param responder - Hands the chunks back to the sender.
   */
  deliverStream(message: TransportMessage, responder: StreamResponder): void
}

/**
 * The switchboard that connects in-process cluster nodes to each other.
 *
 * Every node registers its transport under its own id, and a message addressed
 * to a node is handed straight to the transport registered under that id. This
 * runs a whole cluster inside one process, which is what tests and local
 * development use in place of TCP.
 *
 * @public
 */
export interface InMemoryNetwork {
  /**
   * Makes a node reachable under its id.
   *
   * @param nodeId - The id peers address this node by.
   * @param transport - The transport that receives its messages.
   */
  register(nodeId: string, transport: InMemoryTransportInternal): void
  /**
   * Makes a node unreachable, so a message addressed to it fails.
   *
   * @param nodeId - The node to remove.
   */
  unregister(nodeId: string): void
  /**
   * Looks a node's transport up.
   *
   * @param nodeId - The node to find.
   * @returns Its transport, or `undefined` when no node holds that id.
   */
  getTransport(nodeId: string): InMemoryTransportInternal | undefined
}

/**
 * Builds the switchboard that connects in-process cluster nodes.
 *
 * Create one network, then create a transport per node against it, which is
 * how a whole cluster runs inside a single process.
 *
 * @returns An empty network, ready for nodes to register against.
 *
 * @public
 */
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

/**
 * Builds one node's transport and registers it on an in-process network.
 *
 * The network hands each message straight to the addressed node with no socket
 * in between, so a cluster built this way behaves like a real one without any
 * ports to open.
 *
 * @param nodeId - The id peers address this node by.
 * @param network - The network this node joins.
 * @param config - The timeouts to override. Omit it to accept the defaults.
 * @returns The transport you pass as a cluster node's `transport`.
 *
 * @public
 */
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
        responder([])
        return
      }

      const chunks: Uint8Array[] = []
      const handlerResult = listenHandler(message, (response: TransportMessage) => {
        chunks.push(response.payload)
      })

      if (handlerResult instanceof Promise) {
        handlerResult.then(
          () => responder(chunks),
          () => responder(chunks),
        )
        return
      }

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

    async listen(handler: ListenHandler): Promise<() => void> {
      listenHandler = handler
      return () => {
        if (listenHandler === handler) {
          listenHandler = undefined
        }
      }
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
