import { afterEach, describe, expect, it } from 'vitest'
import { ClusterMessageTypes, TransportError, type TransportMessage } from '../../../../distribution/transport'
import { createGrpcTransport } from '../../../../distribution/transport/grpc'
import { generateTlsBundles, makeTlsConfig } from '../tcp-tls/fixtures'

type GrpcTransport = Awaited<ReturnType<typeof createGrpcTransport>>

const activeTransports: GrpcTransport[] = []

async function createTlsTransport(nodeId: string, tls: ReturnType<typeof makeTlsConfig>): Promise<GrpcTransport> {
  const transport = await createGrpcTransport(nodeId, {
    host: '127.0.0.1',
    port: 0,
    requestTimeout: 5_000,
    connectTimeout: 3_000,
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

describe('GrpcTransport with mutual TLS', () => {
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

  it('rejects a client whose certificate chains to an untrusted authority', async () => {
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

    const err = await rogue
      .send(`127.0.0.1:${server.getPort()}`, makeMessage('tls-req-002'))
      .catch((thrown: TransportError) => thrown)

    expect(err).toBeInstanceOf(TransportError)
  })

  it('fails the handshake when the two sides trust different authorities', async () => {
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

    const err = await client
      .send(`127.0.0.1:${server.getPort()}`, makeMessage('tls-req-003'))
      .catch((thrown: TransportError) => thrown)

    expect(err).toBeInstanceOf(TransportError)
  })
})
