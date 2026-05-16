import { beforeAll, describe, expect, it } from 'vitest'
import { ClusterMessageTypes, TransportError } from '../../../../distribution/transport'
import { createTcpTransport } from '../../../../distribution/transport/tcp'
import { type CertBundle, createTlsPair, echoHandler, generateTlsBundles, makeMessage, makeTlsConfig } from './fixtures'

let serverBundle: CertBundle
let clientBundle: CertBundle
let rotatedClientBundle: CertBundle
let rotatedServerBundle: CertBundle

beforeAll(async () => {
  const bundles = await generateTlsBundles()
  serverBundle = bundles.serverBundle
  clientBundle = bundles.clientBundle
  rotatedClientBundle = bundles.rotatedClientBundle
  rotatedServerBundle = bundles.rotatedServerBundle
})

describe('TcpTransport with mTLS', () => {
  describe('TLS context rotation', () => {
    it('rotates server TLS context for new connections without dropping existing ones', async () => {
      const server = createTcpTransport('tls-rotating-server', {
        host: '127.0.0.1',
        port: 0,
        requestTimeout: 5_000,
        connectTimeout: 3_000,
        snapshotTimeout: 10_000,
        tls: makeTlsConfig(serverBundle),
      })
      await server.listen(echoHandler('tls-rotating-server'))
      const port = server.getPort()

      const existingClient = createTcpTransport('tls-existing-client', {
        host: '127.0.0.1',
        port: 0,
        requestTimeout: 5_000,
        connectTimeout: 3_000,
        snapshotTimeout: 10_000,
        tls: makeTlsConfig(clientBundle),
      })
      const rotatedClient = createTcpTransport('tls-rotated-client', {
        host: '127.0.0.1',
        port: 0,
        requestTimeout: 5_000,
        connectTimeout: 3_000,
        snapshotTimeout: 10_000,
        tls: makeTlsConfig(rotatedClientBundle),
      })
      const staleClient = createTcpTransport('tls-stale-client', {
        host: '127.0.0.1',
        port: 0,
        requestTimeout: 5_000,
        connectTimeout: 3_000,
        snapshotTimeout: 10_000,
        tls: makeTlsConfig(clientBundle),
      })

      try {
        const beforeRotation = await existingClient.send(
          `127.0.0.1:${port}`,
          makeMessage({ requestId: 'tls-rotate-before-001' }),
        )
        expect(beforeRotation.requestId).toBe('tls-rotate-before-001')

        server.rotateTlsContext(makeTlsConfig(rotatedServerBundle))

        const existingConnectionResponse = await existingClient.send(
          `127.0.0.1:${port}`,
          makeMessage({ requestId: 'tls-rotate-existing-001' }),
        )
        expect(existingConnectionResponse.requestId).toBe('tls-rotate-existing-001')

        const rotatedResponse = await rotatedClient.send(
          `127.0.0.1:${port}`,
          makeMessage({ requestId: 'tls-rotate-new-001' }),
        )
        expect(rotatedResponse.requestId).toBe('tls-rotate-new-001')
        expect(rotatedResponse.sourceId).toBe('tls-rotating-server')

        await expect(
          staleClient.send(`127.0.0.1:${port}`, makeMessage({ requestId: 'tls-rotate-stale-001' })),
        ).rejects.toBeInstanceOf(TransportError)
      } finally {
        await staleClient.shutdown()
        await rotatedClient.shutdown()
        await existingClient.shutdown()
        await server.shutdown()
      }
    }, 15_000)
  })

  describe('streaming over TLS', () => {
    it('delivers streamed chunks to the handler callback over mTLS', async () => {
      const chunk1 = new Uint8Array([1, 2, 3])
      const chunk2 = new Uint8Array([4, 5, 6])
      const chunk3 = new Uint8Array([7, 8, 9])

      const pair = await createTlsPair(
        (message, respond) => {
          respond({ ...message, sourceId: 'tls-server', payload: chunk1 })
          respond({ ...message, sourceId: 'tls-server', payload: chunk2 })
          respond({ ...message, sourceId: 'tls-server', payload: chunk3 })
        },
        makeTlsConfig(serverBundle),
        makeTlsConfig(clientBundle),
      )

      try {
        const received: Uint8Array[] = []
        await pair.client.stream(`127.0.0.1:${pair.port}`, makeMessage({ requestId: 'tls-stream-001' }), chunk => {
          received.push(chunk)
        })
        expect(received).toHaveLength(3)
        expect(received[0]).toEqual(chunk1)
        expect(received[1]).toEqual(chunk2)
        expect(received[2]).toEqual(chunk3)
      } finally {
        await pair.cleanup()
      }
    })
  })

  describe('large payload over TLS', () => {
    it('handles a 256KB payload without corruption over mTLS', async () => {
      const pair = await createTlsPair(
        echoHandler('tls-server'),
        makeTlsConfig(serverBundle),
        makeTlsConfig(clientBundle),
      )
      try {
        const largePayload = new Uint8Array(1024 * 256)
        for (let i = 0; i < largePayload.length; i++) {
          largePayload[i] = i % 256
        }
        const response = await pair.client.send(
          `127.0.0.1:${pair.port}`,
          makeMessage({ payload: largePayload, requestId: 'tls-large-001' }),
        )
        expect(response.payload).toEqual(largePayload)
      } finally {
        await pair.cleanup()
      }
    })
  })

  describe('concurrent sends over TLS', () => {
    it('handles multiple messages in flight on the same TLS connection', async () => {
      const pair = await createTlsPair(
        (message, respond) => {
          setTimeout(() => {
            respond({
              type: ClusterMessageTypes.PONG,
              sourceId: 'tls-server',
              requestId: message.requestId,
              payload: new Uint8Array([4, 5, 6]),
            })
          }, Math.random() * 50)
        },
        makeTlsConfig(serverBundle),
        makeTlsConfig(clientBundle),
      )

      try {
        const promises = Array.from({ length: 10 }, (_, i) =>
          pair.client.send(`127.0.0.1:${pair.port}`, makeMessage({ requestId: `tls-conc-${i}` })),
        )
        const results = await Promise.all(promises)
        for (let i = 0; i < 10; i++) {
          expect(results[i].requestId).toBe(`tls-conc-${i}`)
          expect(results[i].sourceId).toBe('tls-server')
        }
      } finally {
        await pair.cleanup()
      }
    })
  })
})
