import type { TransportMessage } from '../../../../distribution/transport'
import { ClusterMessageTypes } from '../../../../distribution/transport'

export function makeMessage(overrides: Partial<TransportMessage> = {}): TransportMessage {
  return {
    type: ClusterMessageTypes.PING,
    sourceId: 'node-a',
    requestId: 'req-001',
    payload: new Uint8Array([1, 2, 3]),
    ...overrides,
  }
}

export function makeResponse(requestId: string, sourceId: string): TransportMessage {
  return {
    type: ClusterMessageTypes.PONG,
    sourceId,
    requestId,
    payload: new Uint8Array([4, 5, 6]),
  }
}
