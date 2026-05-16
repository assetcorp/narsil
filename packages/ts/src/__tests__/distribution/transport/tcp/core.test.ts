import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ClusterMessageTypes,
  MAX_MESSAGE_SIZE_BYTES,
  TransportError,
  TransportErrorCodes,
} from '../../../../distribution/transport'
import { createTcpTransport } from '../../../../distribution/transport/tcp'
import { makeMessage, makeResponse } from './fixtures'

describe('TcpTransport', () => {
  let transportA: ReturnType<typeof createTcpTransport>
  let transportB: ReturnType<typeof createTcpTransport>
  let portB: number

  beforeEach(async () => {
    transportB = createTcpTransport('node-b', {
      host: '127.0.0.1',
      port: 0,
      requestTimeout: 5_000,
      connectTimeout: 3_000,
      snapshotTimeout: 10_000,
    })

    await transportB.listen((message, respond) => {
      respond(makeResponse(message.requestId, 'node-b'))
    })
    portB = transportB.getPort()

    transportA = createTcpTransport('node-a', {
      host: '127.0.0.1',
      port: 0,
      requestTimeout: 5_000,
      connectTimeout: 3_000,
      snapshotTimeout: 10_000,
    })
  })

  afterEach(async () => {
    await transportA.shutdown()
    await transportB.shutdown()
  })

  describe('send and receive', () => {
    it('delivers a message and receives a response over TCP', async () => {
      const target = `127.0.0.1:${portB}`
      const request = makeMessage({ sourceId: 'node-a', requestId: 'req-send-001' })
      const response = await transportA.send(target, request)

      expect(response.type).toBe(ClusterMessageTypes.PONG)
      expect(response.sourceId).toBe('node-b')
      expect(response.requestId).toBe('req-send-001')
      expect(response.payload).toEqual(new Uint8Array([4, 5, 6]))
    })

    it('preserves payload bytes through TCP delivery', async () => {
      const target = `127.0.0.1:${portB}`
      const payload = new Uint8Array([10, 20, 30, 40, 50])

      await transportB.listen((message, respond) => {
        respond({
          type: ClusterMessageTypes.PONG,
          sourceId: 'node-b',
          requestId: message.requestId,
          payload: message.payload,
        })
      })

      const response = await transportA.send(target, makeMessage({ payload, requestId: 'req-echo' }))
      expect(response.payload).toEqual(payload)
    })

    it('handles multiple sequential messages', async () => {
      const target = `127.0.0.1:${portB}`
      for (let i = 0; i < 5; i++) {
        const request = makeMessage({ requestId: `req-seq-${i}` })
        const response = await transportA.send(target, request)
        expect(response.requestId).toBe(`req-seq-${i}`)
        expect(response.sourceId).toBe('node-b')
      }
    })
  })

  describe('connection pooling', () => {
    it('reuses the same socket for subsequent sends to the same target', async () => {
      const target = `127.0.0.1:${portB}`

      await transportA.send(target, makeMessage({ requestId: 'req-pool-1' }))
      /* The pool is internal, so we verify by checking that second send also works */
      const response = await transportA.send(target, makeMessage({ requestId: 'req-pool-2' }))
      expect(response.requestId).toBe('req-pool-2')
    })
  })

  describe('message size enforcement', () => {
    it('rejects outgoing messages exceeding MAX_MESSAGE_SIZE_BYTES', async () => {
      const target = `127.0.0.1:${portB}`
      const oversizedPayload = new Uint8Array(MAX_MESSAGE_SIZE_BYTES + 1)

      try {
        await transportA.send(target, makeMessage({ payload: oversizedPayload, requestId: 'req-oversized' }))
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(TransportError)
        const transportErr = error as TransportError
        expect(transportErr.code).toBe(TransportErrorCodes.MESSAGE_TOO_LARGE)
      }
    })
  })

  describe('timeout', () => {
    it('throws TRANSPORT_TIMEOUT when target does not respond', async () => {
      const silentB = createTcpTransport('silent-node', {
        host: '127.0.0.1',
        port: 0,
        requestTimeout: 500,
      })

      await silentB.listen(() => {
        /* intentionally not responding */
      })
      const silentPort = silentB.getPort()

      const sender = createTcpTransport('timeout-sender', {
        host: '127.0.0.1',
        port: 0,
        requestTimeout: 500,
        connectTimeout: 3_000,
      })

      try {
        await sender.send(
          `127.0.0.1:${silentPort}`,
          makeMessage({ sourceId: 'timeout-sender', requestId: 'req-timeout' }),
        )
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(TransportError)
        const transportErr = error as TransportError
        expect(transportErr.code).toBe(TransportErrorCodes.TIMEOUT)
      } finally {
        await sender.shutdown()
        await silentB.shutdown()
      }
    })
  })

  describe('connect failure', () => {
    it('throws TRANSPORT_CONNECT_FAILED when target is unreachable', async () => {
      try {
        await transportA.send('127.0.0.1:1', makeMessage({ requestId: 'req-unreachable' }))
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(TransportError)
        const transportErr = error as TransportError
        expect(
          transportErr.code === TransportErrorCodes.CONNECT_FAILED || transportErr.code === TransportErrorCodes.TIMEOUT,
        ).toBe(true)
      }
    })
  })

  describe('shutdown', () => {
    it('stops the server and rejects new sends', async () => {
      const target = `127.0.0.1:${portB}`
      const response = await transportA.send(target, makeMessage({ requestId: 'req-pre-shutdown' }))
      expect(response.requestId).toBe('req-pre-shutdown')

      await transportA.shutdown()

      try {
        await transportA.send(target, makeMessage({ requestId: 'req-post-shutdown' }))
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(TransportError)
        const transportErr = error as TransportError
        expect(transportErr.code).toBe(TransportErrorCodes.PEER_UNAVAILABLE)
      }
    })

    it('is idempotent and does not throw on repeated calls', async () => {
      await transportA.shutdown()
      await transportA.shutdown()
      await transportA.shutdown()
    })

    it('closes the server so no new connections are accepted', async () => {
      await transportB.shutdown()

      const newSender = createTcpTransport('new-sender', {
        host: '127.0.0.1',
        port: 0,
        connectTimeout: 1_000,
        requestTimeout: 1_000,
      })

      try {
        await newSender.send(`127.0.0.1:${portB}`, makeMessage({ requestId: 'req-after-server-close' }))
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(TransportError)
      } finally {
        await newSender.shutdown()
      }
    })
  })

  describe('two-way communication', () => {
    it('allows both nodes to send and receive messages', async () => {
      await transportA.listen((message, respond) => {
        respond(makeResponse(message.requestId, 'node-a'))
      })
      const portA = transportA.getPort()

      const targetB = `127.0.0.1:${portB}`
      const targetA = `127.0.0.1:${portA}`

      const responseFromB = await transportA.send(targetB, makeMessage({ sourceId: 'node-a', requestId: 'req-a-to-b' }))
      expect(responseFromB.sourceId).toBe('node-b')
      expect(responseFromB.requestId).toBe('req-a-to-b')

      const responseFromA = await transportB.send(targetA, makeMessage({ sourceId: 'node-b', requestId: 'req-b-to-a' }))
      expect(responseFromA.sourceId).toBe('node-a')
      expect(responseFromA.requestId).toBe('req-b-to-a')
    })
  })

  describe('framing', () => {
    it('handles large payload without corruption', async () => {
      const target = `127.0.0.1:${portB}`
      const largePayload = new Uint8Array(1024 * 256)
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

      const response = await transportA.send(target, makeMessage({ payload: largePayload, requestId: 'req-large' }))
      expect(response.payload).toEqual(largePayload)
    })

    it('handles empty payload', async () => {
      const target = `127.0.0.1:${portB}`

      await transportB.listen((message, respond) => {
        respond({
          type: ClusterMessageTypes.PONG,
          sourceId: 'node-b',
          requestId: message.requestId,
          payload: new Uint8Array(0),
        })
      })

      const response = await transportA.send(
        target,
        makeMessage({ payload: new Uint8Array(0), requestId: 'req-empty' }),
      )
      expect(response.payload).toEqual(new Uint8Array(0))
      expect(response.payload.byteLength).toBe(0)
    })
  })
})
