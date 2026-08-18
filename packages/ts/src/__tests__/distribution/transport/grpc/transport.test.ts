import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ClusterMessageTypes,
  MAX_MESSAGE_SIZE_BYTES,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from '../../../../distribution/transport'
import { createGrpcTransport } from '../../../../distribution/transport/grpc'

type GrpcTransport = Awaited<ReturnType<typeof createGrpcTransport>>

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

async function createTransport(nodeId: string): Promise<GrpcTransport> {
  return createGrpcTransport(nodeId, {
    host: '127.0.0.1',
    port: 0,
    requestTimeout: 5_000,
    connectTimeout: 3_000,
    snapshotTimeout: 10_000,
  })
}

describe('GrpcTransport', () => {
  let transportA: GrpcTransport
  let transportB: GrpcTransport
  let target: string

  beforeEach(async () => {
    transportB = await createTransport('node-b')
    await transportB.listen((message, respond) => {
      respond(makeResponse(message.requestId, 'node-b'))
    })
    target = `127.0.0.1:${transportB.getPort()}`
    transportA = await createTransport('node-a')
  })

  afterEach(async () => {
    await transportA.shutdown()
    await transportB.shutdown()
  })

  describe('send and receive', () => {
    it('delivers a message and receives a response over gRPC', async () => {
      const response = await transportA.send(target, makeMessage({ requestId: 'req-grpc-001' }))

      expect(response.type).toBe(ClusterMessageTypes.PONG)
      expect(response.sourceId).toBe('node-b')
      expect(response.requestId).toBe('req-grpc-001')
      expect(response.payload).toEqual(new Uint8Array([4, 5, 6]))
    })

    it('preserves payload bytes through gRPC delivery', async () => {
      const payload = new Uint8Array(70_000)
      for (let index = 0; index < payload.byteLength; index++) {
        payload[index] = index % 256
      }
      await transportB.listen((message, respond) => {
        respond({ ...message, type: ClusterMessageTypes.PONG, sourceId: 'node-b' })
      })

      const response = await transportA.send(target, makeMessage({ payload }))

      expect(response.payload).toEqual(payload)
    })

    it('serves concurrent requests over one channel', async () => {
      const responses = await Promise.all(
        Array.from({ length: 20 }, (_, index) => transportA.send(target, makeMessage({ requestId: `req-${index}` }))),
      )

      for (let index = 0; index < 20; index++) {
        expect(responses[index].requestId).toBe(`req-${index}`)
      }
    })

    it('rejects a message above the size limit before sending', async () => {
      const oversized = makeMessage({ payload: new Uint8Array(MAX_MESSAGE_SIZE_BYTES + 1) })

      const err = await transportA.send(target, oversized).catch((thrown: TransportError) => thrown)

      expect(err).toBeInstanceOf(TransportError)
      expect((err as TransportError).code).toBe(TransportErrorCodes.MESSAGE_TOO_LARGE)
    })

    it('rejects with CONNECT_FAILED when nothing listens on the target port', async () => {
      const impatient = await createGrpcTransport('node-c', {
        host: '127.0.0.1',
        port: 0,
        requestTimeout: 2_000,
        connectTimeout: 1_000,
        snapshotTimeout: 5_000,
      })

      const err = await impatient.send('127.0.0.1:1', makeMessage()).catch((thrown: TransportError) => thrown)
      await impatient.shutdown()

      expect(err).toBeInstanceOf(TransportError)
      expect((err as TransportError).code).toBe(TransportErrorCodes.CONNECT_FAILED)
    })

    it('answers with an error envelope when the handler rejects', async () => {
      await transportB.listen(() => Promise.reject(new Error('handler exploded')))

      const response = await transportA.send(target, makeMessage({ requestId: 'req-err' }))

      expect(response.type).toBe('error')
      expect(response.requestId).toBe('req-err')
      expect(new TextDecoder().decode(response.payload)).toContain('handler exploded')
    })

    it('rejects with PEER_UNAVAILABLE after the listener unsubscribes', async () => {
      const listenOnly = await createTransport('node-d')
      const unsubscribe = await listenOnly.listen((message, respond) => {
        respond(makeResponse(message.requestId, 'node-d'))
      })
      const listenTarget = `127.0.0.1:${listenOnly.getPort()}`

      await expect(transportA.send(listenTarget, makeMessage())).resolves.toBeDefined()

      unsubscribe()
      const err = await transportA.send(listenTarget, makeMessage()).catch((thrown: TransportError) => thrown)
      await listenOnly.shutdown()

      expect(err).toBeInstanceOf(TransportError)
      expect((err as TransportError).code).toBe(TransportErrorCodes.PEER_UNAVAILABLE)
    })
  })

  describe('streaming', () => {
    it('delivers stream chunks in order and resolves at the end', async () => {
      await transportB.listen(async (message, respond) => {
        respond({ ...makeResponse(message.requestId, 'node-b'), payload: new Uint8Array([1]) })
        respond({ ...makeResponse(message.requestId, 'node-b'), payload: new Uint8Array([2, 2]) })
        respond({ ...makeResponse(message.requestId, 'node-b'), payload: new Uint8Array([3, 3, 3]) })
      })

      const chunks: Uint8Array[] = []
      await transportA.stream(target, makeMessage({ requestId: 'req-stream' }), chunk => {
        chunks.push(new Uint8Array(chunk))
      })

      expect(chunks).toEqual([new Uint8Array([1]), new Uint8Array([2, 2]), new Uint8Array([3, 3, 3])])
    })

    it('rejects the stream when the handler produces no chunks', async () => {
      await transportB.listen(async () => {})

      const err = await transportA.stream(target, makeMessage(), () => {}).catch((thrown: TransportError) => thrown)

      expect(err).toBeInstanceOf(TransportError)
      expect((err as TransportError).code).toBe(TransportErrorCodes.PEER_UNAVAILABLE)
    })

    it('rejects the stream when the chunk handler throws', async () => {
      await transportB.listen(async (message, respond) => {
        respond({ ...makeResponse(message.requestId, 'node-b'), payload: new Uint8Array([1]) })
      })

      const err = await transportA
        .stream(target, makeMessage(), () => {
          throw new Error('bad chunk')
        })
        .catch((thrown: TransportError) => thrown)

      expect(err).toBeInstanceOf(TransportError)
      expect((err as TransportError).code).toBe(TransportErrorCodes.DECODE_FAILED)
    })
  })

  describe('shutdown', () => {
    it('rejects sends after shutdown and stays idempotent', async () => {
      await transportA.shutdown()
      await transportA.shutdown()

      await expect(transportA.send(target, makeMessage())).rejects.toMatchObject({
        code: TransportErrorCodes.PEER_UNAVAILABLE,
      })
    })
  })
})
