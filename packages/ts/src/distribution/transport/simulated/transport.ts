import {
  DEFAULT_TRANSPORT_CONFIG,
  MAX_MESSAGE_SIZE_BYTES,
  type NodeTransport,
  type TransportConfig,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from '../types'
import { createFaultPolicy, type FaultPolicy, type FaultPolicyConfig } from './fault-policy'
import { createSeededPrng } from './prng'
import { createDeterministicScheduler, type DeterministicScheduler } from './scheduler'

type ListenHandler = (message: TransportMessage, respond: (response: TransportMessage) => void) => void | Promise<void>

export interface SimulatedTransportInternal extends NodeTransport {
  deliverMessage(message: TransportMessage, respond: (response: TransportMessage) => void): void
  deliverStream(message: TransportMessage, responder: (chunks: Uint8Array[]) => void): void
}

export interface SimulatedNetworkConfig {
  seed: number
  startTime: number
  advanceTimers: (ms: number) => Promise<unknown>
  faults?: FaultPolicyConfig
}

export interface SimulatedNetwork {
  readonly scheduler: DeterministicScheduler
  readonly faultPolicy: FaultPolicy
  register(nodeId: string, transport: SimulatedTransportInternal): void
  unregister(nodeId: string): void
  getTransport(nodeId: string): SimulatedTransportInternal | undefined
  directExchange(target: string, message: TransportMessage): Promise<TransportMessage>
}

export function createSimulatedNetwork(config: SimulatedNetworkConfig): SimulatedNetwork {
  const transports = new Map<string, SimulatedTransportInternal>()
  const faultPolicy = createFaultPolicy(config.faults ?? {}, createSeededPrng(config.seed))
  const scheduler = createDeterministicScheduler({
    startTime: config.startTime,
    advanceTimers: config.advanceTimers,
  })

  return {
    scheduler,

    faultPolicy,

    register(nodeId: string, transport: SimulatedTransportInternal): void {
      transports.set(nodeId, transport)
    },

    unregister(nodeId: string): void {
      transports.delete(nodeId)
    },

    getTransport(nodeId: string): SimulatedTransportInternal | undefined {
      return transports.get(nodeId)
    },

    async directExchange(target: string, message: TransportMessage): Promise<TransportMessage> {
      const peer = transports.get(target)
      if (peer === undefined) {
        throw new TransportError(TransportErrorCodes.PEER_UNAVAILABLE, `Node '${target}' is not reachable`, { target })
      }
      return new Promise<TransportMessage>((resolve, reject) => {
        let settled = false
        try {
          peer.deliverMessage(message, (response: TransportMessage) => {
            if (!settled) {
              settled = true
              resolve(response)
            }
          })
        } catch (error) {
          if (!settled) {
            settled = true
            reject(error)
          }
        }
      })
    },
  }
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
    deliverMessage(message: TransportMessage, respond: (response: TransportMessage) => void): void {
      if (listenHandler === undefined) {
        return
      }
      listenHandler(message, respond)
    },

    deliverStream(message: TransportMessage, responder: (chunks: Uint8Array[]) => void): void {
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

        if (faultPolicy.shouldDrop(nodeId, target, message.type)) {
          return
        }

        const requestLatency = faultPolicy.sampleLatency(nodeId, target, message.type)
        scheduler.enqueue({
          deliverAt: scheduler.now + requestLatency,
          run: () => {
            if (settled) {
              return
            }
            const peer = network.getTransport(target)
            if (peer === undefined) {
              return
            }
            try {
              peer.deliverMessage(message, (response: TransportMessage) => {
                if (settled) {
                  return
                }
                if (faultPolicy.shouldDrop(target, nodeId, response.type)) {
                  return
                }
                const responseLatency = faultPolicy.sampleLatency(target, nodeId, response.type)
                scheduler.enqueue({
                  deliverAt: scheduler.now + responseLatency,
                  run: () => {
                    if (!settled) {
                      settled = true
                      clearTimeout(timeoutId)
                      resolve(response)
                    }
                  },
                })
              })
            } catch (error) {
              if (!settled) {
                settled = true
                clearTimeout(timeoutId)
                reject(error)
              }
            }
          },
        })
      })
    },

    async stream(target: string, message: TransportMessage, handler: (chunk: Uint8Array) => void): Promise<void> {
      assertNotShutdown()
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

        if (faultPolicy.shouldDrop(nodeId, target, message.type)) {
          return
        }

        const requestLatency = faultPolicy.sampleLatency(nodeId, target, message.type)
        scheduler.enqueue({
          deliverAt: scheduler.now + requestLatency,
          run: () => {
            if (settled) {
              return
            }
            const peer = network.getTransport(target)
            if (peer === undefined) {
              return
            }
            try {
              peer.deliverStream(message, (chunks: Uint8Array[]) => {
                if (settled) {
                  return
                }
                if (faultPolicy.shouldDrop(target, nodeId, message.type)) {
                  return
                }
                const responseLatency = faultPolicy.sampleLatency(target, nodeId, message.type)
                scheduler.enqueue({
                  deliverAt: scheduler.now + responseLatency,
                  run: () => {
                    if (settled) {
                      return
                    }
                    settled = true
                    clearTimeout(timeoutId)
                    for (const chunk of chunks) {
                      handler(chunk)
                    }
                    resolve()
                  },
                })
              })
            } catch (error) {
              if (!settled) {
                settled = true
                clearTimeout(timeoutId)
                reject(error)
              }
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
