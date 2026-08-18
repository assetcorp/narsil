import {
  DEFAULT_TRANSPORT_CONFIG,
  type ListenHandler,
  type NodeTransport,
  type RespondFn,
  type TransportConfig,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from '../types'
import type { SimulatedNetwork, SimulatedStreamSink, SimulatedTransportInternal } from './network'
import { createSimulatedStreamSink } from './stream-sink'
import { decodeMessageFrame, encodeMessageFrame } from './wire'

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function createSimulatedTransport(
  nodeId: string,
  network: SimulatedNetwork,
  config?: Partial<TransportConfig>,
): NodeTransport {
  const resolvedConfig: TransportConfig = {
    ...DEFAULT_TRANSPORT_CONFIG,
    ...config,
  }
  const scheduler = network.scheduler
  const faultPolicy = network.faultPolicy

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

  function lookupPeer(target: string): SimulatedTransportInternal {
    const peer = network.getTransport(target)
    if (peer === undefined) {
      throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, `Node '${target}' is not reachable`, { target })
    }
    return peer
  }

  const internal: SimulatedTransportInternal = {
    deliverMessage(message: TransportMessage, respond: RespondFn): void {
      if (listenHandler === undefined) {
        return
      }
      listenHandler(message, respond)
    },

    deliverStream(message: TransportMessage, sink: SimulatedStreamSink): void {
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
            sink.fail(asError(error))
          })
          return
        }
        finish()
      } catch (error) {
        sink.fail(asError(error))
      }
    },

    async send(target: string, message: TransportMessage): Promise<TransportMessage> {
      assertNotShutdown()
      const requestFrame = encodeMessageFrame(message)
      lookupPeer(target)

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

        const settle = (action: () => void): void => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timeoutId)
          action()
        }

        const respond: RespondFn = async (response: TransportMessage): Promise<void> => {
          if (settled) {
            return
          }
          const responseFrame = encodeMessageFrame(response)
          if (faultPolicy.shouldDrop(target, nodeId, response.type)) {
            return
          }
          scheduler.enqueue({
            deliverAt: scheduler.now + faultPolicy.sampleLatency(target, nodeId, response.type),
            run: () => {
              settle(() => {
                resolve(decodeMessageFrame(responseFrame))
              })
            },
          })
        }

        if (faultPolicy.shouldDrop(nodeId, target, message.type)) {
          return
        }

        scheduler.enqueue({
          deliverAt: scheduler.now + faultPolicy.sampleLatency(nodeId, target, message.type),
          run: () => {
            if (settled) {
              return
            }
            const peer = network.getTransport(target)
            if (peer === undefined) {
              return
            }
            try {
              peer.deliverMessage(decodeMessageFrame(requestFrame), respond)
            } catch (error) {
              settle(() => {
                reject(asError(error))
              })
            }
          },
        })
      })
    },

    async stream(target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void): Promise<void> {
      assertNotShutdown()
      const requestFrame = encodeMessageFrame(message)
      lookupPeer(target)

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

        if (faultPolicy.shouldDrop(nodeId, target, message.type)) {
          return
        }

        scheduler.enqueue({
          deliverAt: scheduler.now + faultPolicy.sampleLatency(nodeId, target, message.type),
          run: () => {
            if (settled) {
              return
            }
            const peer = network.getTransport(target)
            if (peer === undefined) {
              return
            }
            const sink = createSimulatedStreamSink({
              nodeId,
              target,
              message,
              scheduler,
              faultPolicy,
              handler,
              isSettled: () => settled,
              settle,
              resolve,
              reject,
            })
            try {
              peer.deliverStream(decodeMessageFrame(requestFrame), sink)
            } catch (error) {
              settle(() => {
                reject(asError(error))
              })
            }
          },
        })
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
