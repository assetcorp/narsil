import { MAX_MESSAGE_SIZE_BYTES } from './constants'
import {
  DEFAULT_TRANSPORT_CONFIG,
  type ListenHandler,
  type NodeTransport,
  type RespondFn,
  type TransportConfig,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from './types'

/**
 * Receives a streamed response one chunk at a time.
 *
 * A sender hands each chunk over through {@link InMemoryStreamSink.chunk} and
 * waits for it before building the next, so a snapshot travels no faster than
 * the receiver reads it. A stream that breaks part way through ends at
 * {@link InMemoryStreamSink.fail} rather than at
 * {@link InMemoryStreamSink.end}, which is what stops a half-copied snapshot
 * from reading as a whole one.
 *
 * @public
 */
export interface InMemoryStreamSink {
  /**
   * Hands one chunk to the caller waiting on the stream.
   *
   * @param payload - The bytes this chunk carries.
   * @returns A promise that settles once the caller has taken the chunk.
   */
  chunk(payload: Uint8Array): Promise<void>
  /** Closes the stream, which settles the caller's `stream` call. */
  end(): void
  /**
   * Breaks the stream, which rejects the caller's `stream` call.
   *
   * @param error - Why the stream broke.
   */
  fail(error: Error): void
}

export type { ListenHandler, RespondFn } from './types'

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
  deliverMessage(message: TransportMessage, respond: RespondFn): void
  /**
   * Delivers one streamed request to this node's listener.
   *
   * @param message - The request the sender posted.
   * @param sink - Takes each chunk, and the end or the failure of the stream.
   */
  deliverStream(message: TransportMessage, sink: InMemoryStreamSink): void
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
    deliverMessage(message: TransportMessage, respond: RespondFn): void {
      if (listenHandler === undefined) {
        return
      }
      listenHandler(message, respond)
    },

    deliverStream(message: TransportMessage, sink: InMemoryStreamSink): void {
      if (listenHandler === undefined) {
        sink.fail(
          new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, `Node '${nodeId}' has no listener registered`, {
            nodeId,
            requestId: message.requestId,
          }),
        )
        return
      }

      let chunkCount = 0
      const respond: RespondFn = async (response: TransportMessage): Promise<void> => {
        chunkCount++
        await sink.chunk(response.payload)
      }

      const finish = (): void => {
        if (chunkCount === 0) {
          sink.fail(
            new TransportError(
              TransportErrorCodes.PEER_UNAVAILABLE,
              `Node '${nodeId}' answered the stream with no chunks`,
              { nodeId, requestId: message.requestId },
            ),
          )
          return
        }
        sink.end()
      }

      try {
        const handlerResult = listenHandler(message, respond)
        if (handlerResult instanceof Promise) {
          handlerResult.then(finish, (error: unknown) => {
            sink.fail(error instanceof Error ? error : new Error(String(error)))
          })
          return
        }
        finish()
      } catch (error) {
        sink.fail(error instanceof Error ? error : new Error(String(error)))
      }
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
          peer.deliverMessage(message, async (response: TransportMessage): Promise<void> => {
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

        const settle = (action: () => void): void => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timeoutId)
          action()
        }

        const sink: InMemoryStreamSink = {
          chunk(payload: Uint8Array): Promise<void> {
            if (settled) {
              return Promise.resolve()
            }
            try {
              handler(payload)
            } catch (error) {
              settle(() => {
                reject(
                  new TransportError(
                    TransportErrorCodes.DECODE_FAILED,
                    `The stream chunk handler failed: ${error instanceof Error ? error.message : String(error)}`,
                    { target, requestId: message.requestId },
                  ),
                )
              })
            }
            return Promise.resolve()
          },

          end(): void {
            settle(resolve)
          },

          fail(error: Error): void {
            settle(() => {
              reject(error)
            })
          },
        }

        try {
          peer.deliverStream(message, sink)
        } catch (error) {
          settle(() => {
            reject(error)
          })
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
