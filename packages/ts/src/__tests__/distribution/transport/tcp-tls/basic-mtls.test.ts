import { beforeAll, describe, expect, it } from 'vitest'
import { ClusterMessageTypes, TransportError, TransportErrorCodes } from '../../../../distribution/transport'
import { createTcpTransport } from '../../../../distribution/transport/tcp'
import { type CertBundle, createTlsPair, echoHandler, generateTlsBundles, makeMessage, makeTlsConfig } from './fixtures'

let serverBundle: CertBundle
let clientBundle: CertBundle
let rogueBundle: CertBundle

beforeAll(async () => {
  const bundles = await generateTlsBundles()
  serverBundle = bundles.serverBundle
  clientBundle = bundles.clientBundle
  rogueBundle = bundles.rogueBundle
})

describe('TcpTransport with mTLS', () => {
  describe('mTLS connection and messaging', () => {
    it('establishes a connection and exchanges messages over mTLS', async () => {
      const pair = await createTlsPair(
        echoHandler('tls-server'),
        makeTlsConfig(serverBundle),
        makeTlsConfig(clientBundle),
      )
      try {
        const response = await pair.client.send(`127.0.0.1:${pair.port}`, makeMessage({ requestId: 'tls-msg-001' }))
        expect(response.type).toBe(ClusterMessageTypes.PONG)
        expect(response.sourceId).toBe('tls-server')
        expect(response.requestId).toBe('tls-msg-001')
        expect(response.payload).toEqual(new Uint8Array([1, 2, 3]))
      } finally {
        await pair.cleanup()
      }
    })

    it('preserves payload bytes through TLS delivery', async () => {
      const pair = await createTlsPair(
        echoHandler('tls-server'),
        makeTlsConfig(serverBundle),
        makeTlsConfig(clientBundle),
      )
      try {
        const payload = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80])
        const response = await pair.client.send(
          `127.0.0.1:${pair.port}`,
          makeMessage({ payload, requestId: 'tls-echo-001' }),
        )
        expect(response.payload).toEqual(payload)
      } finally {
        await pair.cleanup()
      }
    })

    it('handles multiple sequential messages over mTLS', async () => {
      const pair = await createTlsPair(
        echoHandler('tls-server'),
        makeTlsConfig(serverBundle),
        makeTlsConfig(clientBundle),
      )
      try {
        for (let i = 0; i < 5; i++) {
          const response = await pair.client.send(`127.0.0.1:${pair.port}`, makeMessage({ requestId: `tls-seq-${i}` }))
          expect(response.requestId).toBe(`tls-seq-${i}`)
        }
      } finally {
        await pair.cleanup()
      }
    })
  })

  describe('mTLS certificate rejection', () => {
    it('rejects a non-TLS client connecting to a TLS server', async () => {
      const pair = await createTlsPair(echoHandler('tls-server'), makeTlsConfig(serverBundle), undefined)
      try {
        await pair.client.send(`127.0.0.1:${pair.port}`, makeMessage({ requestId: 'tls-nocert-001' }))
        expect.unreachable('a non-TLS client connecting to a TLS server should fail')
      } catch (error) {
        expect(error).toBeInstanceOf(TransportError)
        const transportErr = error as TransportError
        expect(
          transportErr.code === TransportErrorCodes.CONNECT_FAILED ||
            transportErr.code === TransportErrorCodes.TIMEOUT ||
            transportErr.code === TransportErrorCodes.PEER_UNAVAILABLE,
        ).toBe(true)
      } finally {
        await pair.cleanup()
      }
    })

    it('rejects a client whose certificate is signed by a different CA', async () => {
      const server = createTcpTransport('tls-rogue-server', {
        host: '127.0.0.1',
        port: 0,
        requestTimeout: 2_000,
        connectTimeout: 2_000,
        tls: makeTlsConfig(serverBundle),
      })
      await server.listen(echoHandler('tls-rogue-server'))
      const port = server.getPort()

      const rogueClient = createTcpTransport('tls-rogue-client', {
        host: '127.0.0.1',
        port: 0,
        requestTimeout: 2_000,
        connectTimeout: 2_000,
        tls: { cert: rogueBundle.cert, key: rogueBundle.key, ca: serverBundle.ca },
      })

      try {
        await rogueClient.send(`127.0.0.1:${port}`, makeMessage({ requestId: 'tls-rogue-001' }))
        expect.unreachable('a client with a rogue CA cert should be rejected by the server')
      } catch (error) {
        expect(error).toBeInstanceOf(TransportError)
        const transportErr = error as TransportError
        expect(
          transportErr.code === TransportErrorCodes.CONNECT_FAILED ||
            transportErr.code === TransportErrorCodes.TIMEOUT ||
            transportErr.code === TransportErrorCodes.PEER_UNAVAILABLE,
        ).toBe(true)
      } finally {
        await rogueClient.shutdown()
        await server.shutdown()
      }
    }, 15_000)
  })

  describe('backward compatibility', () => {
    it('non-TLS transports continue to work without TLS config', async () => {
      const pair = await createTlsPair(echoHandler('plain-server'), undefined, undefined)
      try {
        const response = await pair.client.send(`127.0.0.1:${pair.port}`, makeMessage({ requestId: 'plain-msg-001' }))
        expect(response.type).toBe(ClusterMessageTypes.PONG)
        expect(response.sourceId).toBe('plain-server')
      } finally {
        await pair.cleanup()
      }
    })
  })
})
