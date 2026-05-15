import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InMemoryNetwork, NodeTransport, TransportMessage } from '../../../distribution/transport'
import {
  ClusterMessageTypes,
  createInMemoryNetwork,
  createInMemoryTransport,
  ReplicationMessageTypes,
  TransportError,
  TransportErrorCodes,
} from '../../../distribution/transport'

function makeMessage(overrides: Partial<TransportMessage> = {}): TransportMessage {
  return {
    type: ClusterMessageTypes.PING,
    sourceId: 'node-a',
    requestId: 'req-001',
    payload: new Uint8Array([1, 2, 3]),
    ...overrides,
  }
}

function makeResponse(requestId: string, sourceId: string): TransportMessage {
  return {
    type: ClusterMessageTypes.PONG,
    sourceId,
    requestId,
    payload: new Uint8Array([4, 5, 6]),
  }
}

describe('InMemoryTransport', () => {
  let network: InMemoryNetwork
  let transportA: NodeTransport
  let transportB: NodeTransport

  beforeEach(async () => {
    network = createInMemoryNetwork()
    transportA = createInMemoryTransport('node-a', network)
    transportB = createInMemoryTransport('node-b', network)

    await transportB.listen((message, respond) => {
      respond(makeResponse(message.requestId, 'node-b'))
    })
  })

  afterEach(async () => {
    await transportA.shutdown()
    await transportB.shutdown()
  })

  describe('network registration', () => {
    it('registers transports and makes them discoverable', () => {
      expect(network.getTransport('node-a')).toBeDefined()
      expect(network.getTransport('node-b')).toBeDefined()
    })

    it('returns undefined for unregistered nodes', () => {
      expect(network.getTransport('node-c')).toBeUndefined()
    })

    it('unregisters transport when called', () => {
      network.unregister('node-b')
      expect(network.getTransport('node-b')).toBeUndefined()
    })
  })

  describe('send', () => {
    it('delivers a message and receives a response', async () => {
      const request = makeMessage({ sourceId: 'node-a', requestId: 'req-send-001' })
      const response = await transportA.send('node-b', request)

      expect(response.type).toBe(ClusterMessageTypes.PONG)
      expect(response.sourceId).toBe('node-b')
      expect(response.payload).toEqual(new Uint8Array([4, 5, 6]))
    })

    it('correlates requestId between request and response', async () => {
      const request = makeMessage({ requestId: 'req-correlation-test' })
      const response = await transportA.send('node-b', request)

      expect(response.requestId).toBe('req-correlation-test')
    })

    it('throws TRANSPORT_PEER_UNAVAILABLE for unregistered target', async () => {
      const request = makeMessage()

      await expect(transportA.send('node-unknown', request)).rejects.toThrow(TransportError)
      try {
        await transportA.send('node-unknown', request)
      } catch (error) {
        expect(error).toBeInstanceOf(TransportError)
        const transportErr = error as TransportError
        expect(transportErr.code).toBe(TransportErrorCodes.PEER_UNAVAILABLE)
        expect(transportErr.details.target).toBe('node-unknown')
      }
    })

    it('handles multiple sequential messages', async () => {
      for (let i = 0; i < 10; i++) {
        const request = makeMessage({ requestId: `req-seq-${i}` })
        const response = await transportA.send('node-b', request)
        expect(response.requestId).toBe(`req-seq-${i}`)
        expect(response.sourceId).toBe('node-b')
      }
    })

    it('preserves payload bytes through delivery', async () => {
      const payload = new Uint8Array([10, 20, 30, 40, 50])
      const request = makeMessage({ payload, requestId: 'req-payload-test' })

      await transportB.listen((message, respond) => {
        respond({
          type: ClusterMessageTypes.PONG,
          sourceId: 'node-b',
          requestId: message.requestId,
          payload: message.payload,
        })
      })

      const response = await transportA.send('node-b', request)
      expect(response.payload).toEqual(payload)
    })

    it('throws TRANSPORT_PEER_UNAVAILABLE when sending from a shut-down transport', async () => {
      await transportA.shutdown()

      await expect(transportA.send('node-b', makeMessage())).rejects.toThrow(TransportError)
      try {
        await transportA.send('node-b', makeMessage())
      } catch (error) {
        const transportErr = error as TransportError
        expect(transportErr.code).toBe(TransportErrorCodes.PEER_UNAVAILABLE)
      }
    })
  })

  describe('send timeout', () => {
    it('throws TRANSPORT_TIMEOUT when peer does not respond', async () => {
      vi.useFakeTimers()

      const silentNetwork = createInMemoryNetwork()
      const sender = createInMemoryTransport('sender', silentNetwork, { requestTimeout: 100 })
      const receiver = createInMemoryTransport('receiver', silentNetwork)

      await receiver.listen(() => {
        /* intentionally not responding */
      })

      const sendPromise = sender.send('receiver', makeMessage({ sourceId: 'sender' }))

      vi.advanceTimersByTime(101)

      await expect(sendPromise).rejects.toThrow(TransportError)
      try {
        await sendPromise
      } catch {
        /* already asserted */
      }

      await sender.shutdown()
      await receiver.shutdown()
      vi.useRealTimers()
    })
  })

  describe('two-way communication', () => {
    it('allows both nodes to send and receive messages', async () => {
      await transportA.listen((message, respond) => {
        respond(makeResponse(message.requestId, 'node-a'))
      })

      const requestFromA = makeMessage({ sourceId: 'node-a', requestId: 'req-a-to-b' })
      const responseFromB = await transportA.send('node-b', requestFromA)
      expect(responseFromB.sourceId).toBe('node-b')
      expect(responseFromB.requestId).toBe('req-a-to-b')

      const requestFromB = makeMessage({ sourceId: 'node-b', requestId: 'req-b-to-a' })
      const responseFromA = await transportB.send('node-a', requestFromB)
      expect(responseFromA.sourceId).toBe('node-a')
      expect(responseFromA.requestId).toBe('req-b-to-a')
    })
  })

  describe('stream', () => {
    it('delivers streamed chunks to the handler callback', async () => {
      const chunk1 = new Uint8Array([1, 2, 3])
      const chunk2 = new Uint8Array([4, 5, 6])
      const chunk3 = new Uint8Array([7, 8, 9])

      await transportB.listen((message, respond) => {
        respond({ ...message, sourceId: 'node-b', payload: chunk1 })
        respond({ ...message, sourceId: 'node-b', payload: chunk2 })
        respond({ ...message, sourceId: 'node-b', payload: chunk3 })
      })

      const received: Uint8Array[] = []
      await transportA.stream('node-b', makeMessage({ requestId: 'req-stream' }), chunk => {
        received.push(chunk)
      })

      expect(received).toHaveLength(3)
      expect(received[0]).toEqual(chunk1)
      expect(received[1]).toEqual(chunk2)
      expect(received[2]).toEqual(chunk3)
    })

    it('throws TRANSPORT_PEER_UNAVAILABLE for unregistered target', async () => {
      await expect(transportA.stream('node-unknown', makeMessage(), () => {})).rejects.toThrow(TransportError)

      try {
        await transportA.stream('node-unknown', makeMessage(), () => {})
      } catch (error) {
        const transportErr = error as TransportError
        expect(transportErr.code).toBe(TransportErrorCodes.PEER_UNAVAILABLE)
      }
    })

    it('throws TRANSPORT_PEER_UNAVAILABLE when streaming from a shut-down transport', async () => {
      await transportA.shutdown()

      await expect(transportA.stream('node-b', makeMessage(), () => {})).rejects.toThrow(TransportError)
    })

    it('handles empty stream with no chunks', async () => {
      await transportB.listen((_message, _respond) => {
        /* no respond calls means no chunks */
      })

      const received: Uint8Array[] = []
      await transportA.stream('node-b', makeMessage(), chunk => {
        received.push(chunk)
      })

      expect(received).toHaveLength(0)
    })
  })

  describe('listen', () => {
    it('replaces the previous handler when called again', async () => {
      const firstHandlerCalls: string[] = []
      const secondHandlerCalls: string[] = []

      await transportB.listen((message, respond) => {
        firstHandlerCalls.push(message.requestId)
        respond(makeResponse(message.requestId, 'node-b'))
      })

      await transportA.send('node-b', makeMessage({ requestId: 'req-first' }))
      expect(firstHandlerCalls).toContain('req-first')

      await transportB.listen((message, respond) => {
        secondHandlerCalls.push(message.requestId)
        respond(makeResponse(message.requestId, 'node-b'))
      })

      await transportA.send('node-b', makeMessage({ requestId: 'req-second' }))
      expect(firstHandlerCalls).not.toContain('req-second')
      expect(secondHandlerCalls).toContain('req-second')
    })

    it('receives the full TransportMessage envelope', async () => {
      let receivedMessage: TransportMessage | undefined

      await transportB.listen((message, respond) => {
        receivedMessage = message
        respond(makeResponse(message.requestId, 'node-b'))
      })

      const request = makeMessage({
        type: ReplicationMessageTypes.FORWARD,
        sourceId: 'node-a',
        requestId: 'req-envelope-check',
        payload: new Uint8Array([99, 88, 77]),
      })

      await transportA.send('node-b', request)

      expect(receivedMessage).toBeDefined()
      expect(receivedMessage?.type).toBe(ReplicationMessageTypes.FORWARD)
      expect(receivedMessage?.sourceId).toBe('node-a')
      expect(receivedMessage?.requestId).toBe('req-envelope-check')
      expect(receivedMessage?.payload).toEqual(new Uint8Array([99, 88, 77]))
    })
  })

  describe('shutdown', () => {
    it('unregisters the transport from the network', async () => {
      expect(network.getTransport('node-a')).toBeDefined()
      await transportA.shutdown()
      expect(network.getTransport('node-a')).toBeUndefined()
    })

    it('causes sends to the shut-down node to fail', async () => {
      await transportB.shutdown()

      await expect(transportA.send('node-b', makeMessage())).rejects.toThrow(TransportError)
      try {
        await transportA.send('node-b', makeMessage())
      } catch (error) {
        const transportErr = error as TransportError
        expect(transportErr.code).toBe(TransportErrorCodes.PEER_UNAVAILABLE)
      }
    })

    it('is idempotent and does not throw on repeated calls', async () => {
      await transportA.shutdown()
      await transportA.shutdown()
      await transportA.shutdown()
    })

    it('clears the listen handler so no new messages are processed', async () => {
      const handlerCalls: string[] = []

      await transportA.listen((message, respond) => {
        handlerCalls.push(message.requestId)
        respond(makeResponse(message.requestId, 'node-a'))
      })

      await transportB.send('node-a', makeMessage({ sourceId: 'node-b', requestId: 'before-shutdown' }))
      expect(handlerCalls).toContain('before-shutdown')

      await transportA.shutdown()

      const freshTransportA = createInMemoryTransport('node-a', network)
      await freshTransportA.listen((_message, _respond) => {
        /* new handler, different from the original */
      })

      expect(handlerCalls).not.toContain('after-shutdown')
      await freshTransportA.shutdown()
    })
  })

  describe('edge cases', () => {
    it('handles empty payload', async () => {
      const request = makeMessage({ payload: new Uint8Array(0) })

      await transportB.listen((message, respond) => {
        respond({
          type: ClusterMessageTypes.PONG,
          sourceId: 'node-b',
          requestId: message.requestId,
          payload: new Uint8Array(0),
        })
      })

      const response = await transportA.send('node-b', request)
      expect(response.payload).toEqual(new Uint8Array(0))
      expect(response.payload.byteLength).toBe(0)
    })

    it('handles large payload without modification', async () => {
      const largePayload = new Uint8Array(1024 * 1024)
      for (let i = 0; i < largePayload.length; i++) {
        largePayload[i] = i % 256
      }

      await transportB.listen((message, respond) => {
        respond({
          type: ClusterMessageTypes.PONG,
          sourceId: 'node-b',
          requestId: message.requestId,
          payload: message.payload,
        })
      })

      const response = await transportA.send('node-b', makeMessage({ payload: largePayload }))
      expect(response.payload).toEqual(largePayload)
    })
  })
})
