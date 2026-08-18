import { TransportError, type TransportErrorCode, TransportErrorCodes, type TransportMessage } from '../types'
import type { FaultPolicy } from './fault-policy'
import type { SimulatedStreamSink } from './network'
import type { DeterministicScheduler } from './scheduler'
import { decodeChunkFrame, encodeChunkFrame } from './wire'

export interface StreamSinkDeps {
  nodeId: string
  target: string
  message: TransportMessage
  scheduler: DeterministicScheduler
  faultPolicy: FaultPolicy
  handler: (chunk: Uint8Array) => void
  isSettled: () => boolean
  settle: (action: () => void) => void
  resolve: () => void
  reject: (error: Error) => void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createSimulatedStreamSink(deps: StreamSinkDeps): SimulatedStreamSink {
  const { scheduler, faultPolicy, nodeId, target, message } = deps
  let lastDeliverAt = scheduler.now

  function scheduleInOrder(run: () => void): void {
    const latency = faultPolicy.sampleLatency(target, nodeId, message.type)
    const deliverAt = Math.max(scheduler.now + latency, lastDeliverAt)
    lastDeliverAt = deliverAt
    scheduler.enqueue({ deliverAt, run })
  }

  function failStream(code: TransportErrorCode, reason: string): void {
    deps.settle(() =>
      deps.reject(
        new TransportError(code, reason, { target, requestId: message.requestId, messageType: message.type }),
      ),
    )
  }

  return {
    chunk(payload: Uint8Array): Promise<void> {
      if (deps.isSettled()) {
        return Promise.resolve()
      }
      const frame = encodeChunkFrame(message.requestId, payload)
      const lost = faultPolicy.shouldDrop(target, nodeId, message.type)

      return new Promise<void>(taken => {
        scheduleInOrder(() => {
          if (lost) {
            failStream(TransportErrorCodes.PEER_UNAVAILABLE, `The stream from node '${target}' lost a chunk in flight`)
            taken()
            return
          }
          if (!deps.isSettled()) {
            try {
              deps.handler(decodeChunkFrame(frame))
            } catch (error) {
              failStream(TransportErrorCodes.DECODE_FAILED, `The stream chunk handler failed: ${describe(error)}`)
            }
          }
          taken()
        })
      })
    },

    end(): void {
      scheduleInOrder(() => {
        deps.settle(deps.resolve)
      })
    },

    fail(error: Error): void {
      scheduleInOrder(() => {
        deps.settle(() => deps.reject(error))
      })
    },
  }
}
