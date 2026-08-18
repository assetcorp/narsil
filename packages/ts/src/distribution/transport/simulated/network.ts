import {
  type NodeTransport,
  type RespondFn,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from '../types'
import { createFaultPolicy, type FaultPolicy, type FaultPolicyConfig } from './fault-policy'
import { createDeterministicScheduler, type DeterministicScheduler } from './scheduler'
import { decodeMessageFrame, encodeMessageFrame } from './wire'

export interface SimulatedStreamSink {
  chunk(payload: Uint8Array): Promise<void>
  end(): void
  fail(error: Error): void
}

export interface SimulatedTransportInternal extends NodeTransport {
  deliverMessage(message: TransportMessage, respond: RespondFn): void
  deliverStream(message: TransportMessage, sink: SimulatedStreamSink): void
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

function overTheWire(message: TransportMessage): TransportMessage {
  return decodeMessageFrame(encodeMessageFrame(message))
}

export function createSimulatedNetwork(config: SimulatedNetworkConfig): SimulatedNetwork {
  const transports = new Map<string, SimulatedTransportInternal>()
  const faultPolicy = createFaultPolicy(config.faults ?? {}, config.seed)
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
          peer.deliverMessage(overTheWire(message), async (response: TransportMessage): Promise<void> => {
            if (!settled) {
              settled = true
              resolve(overTheWire(response))
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
