import { generate } from 'selfsigned'
import { beforeAll, describe, expect, it } from 'vitest'
import type { TransportMessage } from '../../../distribution/transport'
import { ClusterMessageTypes, TransportError, TransportErrorCodes } from '../../../distribution/transport'
import { createTcpTransport, type TlsConfig } from '../../../distribution/transport/tcp'

interface CertBundle {
  cert: string
  key: string
  ca: string
}

type ListenHandler = (message: TransportMessage, respond: (r: TransportMessage) => void) => void | Promise<void>

let serverBundle: CertBundle
let clientBundle: CertBundle
let rogueBundle: CertBundle
let rotatedClientBundle: CertBundle
let rotatedServerBundle: CertBundle

function makeMessage(overrides: Partial<TransportMessage> = {}): TransportMessage {
  return {
    type: ClusterMessageTypes.PING,
    sourceId: 'tls-node-a',
    requestId: 'tls-req-001',
    payload: new Uint8Array([1, 2, 3]),
    ...overrides,
  }
}

function echoHandler(serverId: string): ListenHandler {
  return (message, respond) => {
    respond({
      type: ClusterMessageTypes.PONG,
      sourceId: serverId,
      requestId: message.requestId,
      payload: message.payload,
    })
  }
}

function makeTlsConfig(bundle: CertBundle): TlsConfig {
  return { cert: bundle.cert, key: bundle.key, ca: bundle.ca }
}

type TransportPair = {
  server: ReturnType<typeof createTcpTransport>
  client: ReturnType<typeof createTcpTransport>
  port: number
  cleanup: () => Promise<void>
}

async function createTlsPair(
  handler: ListenHandler,
  serverTls?: TlsConfig,
  clientTls?: TlsConfig,
): Promise<TransportPair> {
  const server = createTcpTransport('tls-server', {
    host: '127.0.0.1',
    port: 0,
    requestTimeout: 5_000,
    connectTimeout: 3_000,
    snapshotTimeout: 10_000,
    tls: serverTls,
  })
  await server.listen(handler)
  const port = server.getPort()
  const client = createTcpTransport('tls-client', {
    host: '127.0.0.1',
    port: 0,
    requestTimeout: 5_000,
    connectTimeout: 3_000,
    snapshotTimeout: 10_000,
    tls: clientTls,
  })
  return {
    server,
    client,
    port,
    cleanup: async () => {
      await client.shutdown()
      await server.shutdown()
    },
  }
}

beforeAll(async () => {
  const caResult = await generate([{ name: 'commonName', value: 'Narsil Test CA' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  })
  const caCert = caResult.cert
  const caKey = caResult.private

  const serverResult = await generate([{ name: 'commonName', value: 'narsil-server' }], {
    keySize: 2048,
    algorithm: 'sha256',
    ca: { key: caKey, cert: caCert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
    ],
  })

  const clientResult = await generate([{ name: 'commonName', value: 'narsil-client' }], {
    keySize: 2048,
    algorithm: 'sha256',
    ca: { key: caKey, cert: caCert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', clientAuth: true },
    ],
  })

  serverBundle = { cert: serverResult.cert, key: serverResult.private, ca: caCert }
  clientBundle = { cert: clientResult.cert, key: clientResult.private, ca: caCert }

  const rogueCA = await generate([{ name: 'commonName', value: 'Rogue CA' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  })
  const rogueCert = await generate([{ name: 'commonName', value: 'rogue-node' }], {
    keySize: 2048,
    algorithm: 'sha256',
    ca: { key: rogueCA.private, cert: rogueCA.cert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', clientAuth: true },
    ],
  })
  rogueBundle = { cert: rogueCert.cert, key: rogueCert.private, ca: rogueCA.cert }

  const rotatedCA = await generate([{ name: 'commonName', value: 'Rotated Test CA' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  })
  const rotatedServer = await generate([{ name: 'commonName', value: 'rotated-narsil-server' }], {
    keySize: 2048,
    algorithm: 'sha256',
    ca: { key: rotatedCA.private, cert: rotatedCA.cert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 7, ip: '127.0.0.1' }] },
    ],
  })
  const rotatedClient = await generate([{ name: 'commonName', value: 'rotated-narsil-client' }], {
    keySize: 2048,
    algorithm: 'sha256',
    ca: { key: rotatedCA.private, cert: rotatedCA.cert },
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', clientAuth: true },
    ],
  })
  rotatedServerBundle = { cert: rotatedServer.cert, key: rotatedServer.private, ca: rotatedCA.cert }
  rotatedClientBundle = { cert: rotatedClient.cert, key: rotatedClient.private, ca: rotatedCA.cert }
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
