import { createServer, type Server } from 'node:net'
import { encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TransportError, TransportErrorCodes } from '../../../../distribution/transport'
import { createTcpTransport } from '../../../../distribution/transport/tcp'
import { parseAddress } from '../../../../distribution/transport/tcp/connection'
import { FRAME_TYPE_RESPONSE, LENGTH_PREFIX_BYTES } from '../../../../distribution/transport/tcp/types'
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

  describe('stream', () => {
    it('delivers streamed chunks to the handler callback', async () => {
      const target = `127.0.0.1:${portB}`
      const chunk1 = new Uint8Array([1, 2, 3])
      const chunk2 = new Uint8Array([4, 5, 6])
      const chunk3 = new Uint8Array([7, 8, 9])

      await transportB.listen((message, respond) => {
        respond({ ...message, sourceId: 'node-b', payload: chunk1 })
        respond({ ...message, sourceId: 'node-b', payload: chunk2 })
        respond({ ...message, sourceId: 'node-b', payload: chunk3 })
      })

      const received: Uint8Array[] = []
      await transportA.stream(target, makeMessage({ requestId: 'req-stream' }), chunk => {
        received.push(chunk)
      })

      expect(received).toHaveLength(3)
      expect(received[0]).toEqual(chunk1)
      expect(received[1]).toEqual(chunk2)
      expect(received[2]).toEqual(chunk3)
    })

    it('handles empty stream with no chunks', async () => {
      const target = `127.0.0.1:${portB}`

      await transportB.listen((_message, _respond) => {
        /* intentionally no respond calls */
      })

      const received: Uint8Array[] = []

      const streamTransport = createTcpTransport('stream-empty', {
        host: '127.0.0.1',
        port: 0,
        snapshotTimeout: 1_000,
      })

      try {
        await streamTransport.stream(target, makeMessage({ requestId: 'req-empty-stream' }), chunk => {
          received.push(chunk)
        })
        expect.unreachable('should have timed out since no STREAM_END was sent')
      } catch (error) {
        expect(error).toBeInstanceOf(TransportError)
        const transportErr = error as TransportError
        expect(transportErr.code).toBe(TransportErrorCodes.TIMEOUT)
      } finally {
        await streamTransport.shutdown()
      }
    })
  })

  describe('concurrent sends', () => {
    it('handles multiple messages in flight on the same connection', async () => {
      const target = `127.0.0.1:${portB}`

      await transportB.listen((message, respond) => {
        setTimeout(() => {
          respond(makeResponse(message.requestId, 'node-b'))
        }, Math.random() * 50)
      })

      const promises = Array.from({ length: 10 }, (_, i) =>
        transportA.send(target, makeMessage({ requestId: `req-concurrent-${i}` })),
      )

      const results = await Promise.all(promises)
      for (let i = 0; i < 10; i++) {
        expect(results[i].requestId).toBe(`req-concurrent-${i}`)
        expect(results[i].sourceId).toBe('node-b')
      }
    })
  })

  describe('listen handler replacement', () => {
    it('replaces the previous handler when listen is called again', async () => {
      const target = `127.0.0.1:${portB}`
      const firstCalls: string[] = []
      const secondCalls: string[] = []

      await transportB.listen((message, respond) => {
        firstCalls.push(message.requestId)
        respond(makeResponse(message.requestId, 'node-b'))
      })

      await transportA.send(target, makeMessage({ requestId: 'req-first-handler' }))
      expect(firstCalls).toContain('req-first-handler')

      await transportB.listen((message, respond) => {
        secondCalls.push(message.requestId)
        respond(makeResponse(message.requestId, 'node-b'))
      })

      await transportA.send(target, makeMessage({ requestId: 'req-second-handler' }))
      expect(firstCalls).not.toContain('req-second-handler')
      expect(secondCalls).toContain('req-second-handler')
    })
  })

  describe('connection error isolation', () => {
    it('does not reject pending requests to node-C when node-B connection fails', async () => {
      const transportC = createTcpTransport('node-c', {
        host: '127.0.0.1',
        port: 0,
        requestTimeout: 5_000,
        connectTimeout: 3_000,
        snapshotTimeout: 10_000,
      })

      await transportC.listen((message, respond) => {
        setTimeout(() => {
          respond(makeResponse(message.requestId, 'node-c'))
        }, 200)
      })
      const portC = transportC.getPort()

      try {
        const targetC = `127.0.0.1:${portC}`
        const pendingToC = transportA.send(targetC, makeMessage({ requestId: 'req-to-c' }))

        try {
          await transportA.send('127.0.0.1:1', makeMessage({ requestId: 'req-to-dead' }))
        } catch (_) {
          /* expected failure */
        }

        const responseFromC = await pendingToC
        expect(responseFromC.requestId).toBe('req-to-c')
        expect(responseFromC.sourceId).toBe('node-c')
      } finally {
        await transportC.shutdown()
      }
    })
  })

  describe('parseAddress validation', () => {
    it('rejects address with empty host', () => {
      expect(() => parseAddress(':8080')).toThrow(TransportError)
    })

    it('rejects address with null bytes in host', () => {
      expect(() => parseAddress('host\0name:8080')).toThrow(TransportError)
    })

    it('rejects address without port separator', () => {
      expect(() => parseAddress('localhost')).toThrow(TransportError)
    })

    it('parses valid address correctly', () => {
      const [host, port] = parseAddress('127.0.0.1:9300')
      expect(host).toBe('127.0.0.1')
      expect(port).toBe('9300')
    })

    it('parses IPv6 address correctly', () => {
      const [host, port] = parseAddress('[::1]:9300')
      expect(host).toBe('[::1]')
      expect(port).toBe('9300')
    })
  })

  describe('stream decode-failure fast-fail', () => {
    it('rejects a pending stream immediately when the first frame fails to decode', async () => {
      const rawServer: Server = createServer()
      await new Promise<void>((resolve, reject) => {
        rawServer.once('error', reject)
        rawServer.listen(0, '127.0.0.1', () => resolve())
      })
      const addr = rawServer.address()
      if (addr === null || typeof addr !== 'object') {
        throw new Error('failed to determine raw server port')
      }
      const rawPort = addr.port

      rawServer.on('connection', socket => {
        socket.on('data', (_data: Buffer) => {
          const malformedData = new Uint8Array([0xc1, 0xc1, 0xc1, 0xc1, 0xc1])
          const envelope = encode({ frameType: FRAME_TYPE_RESPONSE, requestId: 'raw-1', data: malformedData })
          const frame = new Uint8Array(LENGTH_PREFIX_BYTES + envelope.byteLength)
          const view = new DataView(frame.buffer)
          view.setUint32(0, envelope.byteLength, false)
          frame.set(envelope, LENGTH_PREFIX_BYTES)
          socket.write(Buffer.from(frame))
        })
      })

      const clientTransport = createTcpTransport('raw-client', {
        host: '127.0.0.1',
        port: 0,
        snapshotTimeout: 10_000,
        requestTimeout: 5_000,
        connectTimeout: 3_000,
      })

      try {
        const target = `127.0.0.1:${rawPort}`
        const startedAt = Date.now()
        await expect(
          clientTransport.stream(target, makeMessage({ requestId: 'raw-1' }), () => {}),
        ).rejects.toMatchObject({
          code: TransportErrorCodes.DECODE_FAILED,
        })
        const elapsed = Date.now() - startedAt
        expect(elapsed).toBeLessThan(5_000)
      } finally {
        await clientTransport.shutdown()
        await new Promise<void>(resolve => {
          rawServer.close(() => resolve())
        })
      }
    })
  })

  describe('async listen handler', () => {
    it('sends STREAM_END after async handler resolves', async () => {
      const target = `127.0.0.1:${portB}`
      const chunk1 = new Uint8Array([10, 20])
      const chunk2 = new Uint8Array([30, 40])

      await transportB.listen(async (message, respond) => {
        respond({ ...message, sourceId: 'node-b', payload: chunk1 })
        await new Promise<void>(resolve => setTimeout(resolve, 50))
        respond({ ...message, sourceId: 'node-b', payload: chunk2 })
      })

      const received: Uint8Array[] = []
      await transportA.stream(target, makeMessage({ requestId: 'req-async-stream' }), chunk => {
        received.push(chunk)
      })

      expect(received).toHaveLength(2)
      expect(received[0]).toEqual(chunk1)
      expect(received[1]).toEqual(chunk2)
    })
  })
})
