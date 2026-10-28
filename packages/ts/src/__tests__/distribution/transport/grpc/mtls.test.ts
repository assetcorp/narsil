import { afterEach, describe, expect, it } from 'vitest'
import {
  ClusterMessageTypes,
  TransportError,
  TransportErrorCodes,
  type TransportMessage,
} from '../../../../distribution/transport'
import { createGrpcTransport } from '../../../../distribution/transport/grpc'
import { generateTlsBundles, makeTlsConfig } from '../tcp-tls/fixtures'

type GrpcTransport = Awaited<ReturnType<typeof createGrpcTransport>>

const CONNECT_TIMEOUT_MS = 10_000
const TEST_TIMEOUT_MS = 20_000

const activeTransports: GrpcTransport[] = []

async function createTlsTransport(nodeId: string, tls: ReturnType<typeof makeTlsConfig>): Promise<GrpcTransport> {
  const transport = await createGrpcTransport(nodeId, {
    host: '127.0.0.1',
    port: 0,
    requestTimeout: 5_000,
    connectTimeout: CONNECT_TIMEOUT_MS,
    snapshotTimeout: 10_000,
    tls,
  })
  activeTransports.push(transport)
  return transport
}

function makeMessage(requestId: string): TransportMessage {
  return {
    type: ClusterMessageTypes.PING,
    sourceId: 'tls-node-a',
    requestId,
    payload: new Uint8Array([1, 2, 3]),
  }
}

async function timedSend(
  transport: GrpcTransport,
  target: string,
  message: TransportMessage,
): Promise<{ err: unknown; elapsed: number }> {
  const started = performance.now()
  const err = await transport.send(target, message).catch((thrown: unknown) => thrown)
  return { err, elapsed: performance.now() - started }
}

describe('GrpcTransport with mutual TLS', { timeout: TEST_TIMEOUT_MS }, () => {
  afterEach(async () => {
    await Promise.all(activeTransports.map(transport => transport.shutdown()))
    activeTransports.length = 0
  })

  it('completes a round trip when both sides present trusted certificates', async () => {
    const bundles = await generateTlsBundles()
    const server = await createTlsTransport('tls-server', makeTlsConfig(bundles.serverBundle))
    await server.listen((message, respond) => {
      respond({
        type: ClusterMessageTypes.PONG,
        sourceId: 'tls-server',
        requestId: message.requestId,
        payload: message.payload,
      })
    })

    const client = await createTlsTransport('tls-client', makeTlsConfig(bundles.clientBundle))
    const response = await client.send(`127.0.0.1:${server.getPort()}`, makeMessage('tls-req-001'))

    expect(response.type).toBe(ClusterMessageTypes.PONG)
    expect(response.sourceId).toBe('tls-server')
    expect(response.payload).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('rejects a client whose certificate chains to an untrusted authority at once', async () => {
    const bundles = await generateTlsBundles()
    const server = await createTlsTransport('tls-server', makeTlsConfig(bundles.serverBundle))
    await server.listen((message, respond) => {
      respond({ ...message, type: ClusterMessageTypes.PONG, sourceId: 'tls-server' })
    })

    const rogue = await createTlsTransport('tls-rogue', {
      cert: bundles.rogueBundle.cert,
      key: bundles.rogueBundle.key,
      ca: bundles.serverBundle.ca,
    })

    const { err, elapsed } = await timedSend(rogue, `127.0.0.1:${server.getPort()}`, makeMessage('tls-req-002'))

    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).code).toBe(TransportErrorCodes.CONNECT_FAILED)
    expect(elapsed).toBeLessThan(CONNECT_TIMEOUT_MS / 2)
  })

  it('fails the handshake at once, with the certificate error in its message, when the two sides trust different authorities', async () => {
    const bundles = await generateTlsBundles()
    const server = await createTlsTransport('tls-server', makeTlsConfig(bundles.rotatedServerBundle))
    await server.listen((message, respond) => {
      respond({ ...message, type: ClusterMessageTypes.PONG, sourceId: 'tls-server' })
    })

    const client = await createTlsTransport('tls-client', {
      cert: bundles.clientBundle.cert,
      key: bundles.clientBundle.key,
      ca: bundles.clientBundle.ca,
    })

    const { err, elapsed } = await timedSend(client, `127.0.0.1:${server.getPort()}`, makeMessage('tls-req-003'))

    expect(err).toBeInstanceOf(TransportError)
    expect((err as TransportError).code).toBe(TransportErrorCodes.CONNECT_FAILED)
    expect((err as TransportError).message).toMatch(/certificate/)
    expect(elapsed).toBeLessThan(CONNECT_TIMEOUT_MS / 2)
  })
})
