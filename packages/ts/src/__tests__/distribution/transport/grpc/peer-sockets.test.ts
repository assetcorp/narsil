import { connect, createServer, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { generate } from 'selfsigned'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TransportErrorCodes } from '../../../../distribution/transport'
import { createGrpcTransport, type GrpcTransportConfig } from '../../../../distribution/transport/grpc'
import { failureOf, relayTo, startReceivingSide } from '../receiving-side'
import { type CertBundle, echoHandler, makeMessage, TLS_BUNDLES_TIMEOUT_MS } from '../tcp-tls/fixtures'

type GrpcTransport = Awaited<ReturnType<typeof createGrpcTransport>>

const SHORT_CONNECT_TIMEOUT_MS = 1_000
const SOCKETS_CLOSE_WITHIN_MS = 5_000
const TEST_TIMEOUT_MS = 30_000
const SUBJECT_ALT_NAME_DNS = 2
const SUBJECT_ALT_NAME_IP = 7

const hasIpv6Loopback = Object.values(networkInterfaces()).some(addresses =>
  (addresses ?? []).some(entry => entry.family === 'IPv6' && entry.address === '::1'),
)

interface HostForm {
  name: string
  listenHost: string
  socketHost: string
  targetHost: string
}

const HOST_FORMS: HostForm[] = [
  { name: 'DNS name', listenHost: '127.0.0.1', socketHost: '127.0.0.1', targetHost: 'localhost' },
  { name: 'IPv4', listenHost: '127.0.0.1', socketHost: '127.0.0.1', targetHost: '127.0.0.1' },
  ...(hasIpv6Loopback ? [{ name: 'bracketed IPv6', listenHost: '[::1]', socketHost: '::1', targetHost: '[::1]' }] : []),
]

interface Certificates {
  everyName: CertBundle
  otherName: CertBundle
  client: CertBundle
}

let certificates: Certificates
const releases: Array<() => Promise<void>> = []

async function issue(
  authority: { key: string; cert: string },
  commonName: string,
  altNames: Array<{ type: typeof SUBJECT_ALT_NAME_DNS | typeof SUBJECT_ALT_NAME_IP; value?: string; ip?: string }>,
): Promise<CertBundle> {
  const issued = await generate([{ name: 'commonName', value: commonName }], {
    keySize: 2048,
    algorithm: 'sha256',
    ca: authority,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      ...(altNames.length > 0 ? [{ name: 'subjectAltName' as const, altNames }] : []),
    ],
  })
  return { cert: issued.cert, key: issued.private, ca: authority.cert }
}

beforeAll(async () => {
  const authority = await generate([{ name: 'commonName', value: 'Narsil Peer Socket CA' }], {
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  })
  const signer = { key: authority.private, cert: authority.cert }
  const [everyName, otherName, client] = await Promise.all([
    issue(signer, 'narsil-every-name', [
      { type: SUBJECT_ALT_NAME_DNS, value: 'localhost' },
      { type: SUBJECT_ALT_NAME_IP, ip: '127.0.0.1' },
      { type: SUBJECT_ALT_NAME_IP, ip: '::1' },
    ]),
    issue(signer, 'narsil-other-name', [{ type: SUBJECT_ALT_NAME_DNS, value: 'elsewhere.invalid' }]),
    issue(signer, 'narsil-client', []),
  ])
  certificates = { everyName, otherName, client }
}, TLS_BUNDLES_TIMEOUT_MS)

afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release()
})

async function startTransport(nodeId: string, config: Partial<GrpcTransportConfig> = {}): Promise<GrpcTransport> {
  const transport = await createGrpcTransport(nodeId, {
    host: '127.0.0.1',
    port: 0,
    connectTimeout: 10_000,
    requestTimeout: 10_000,
    snapshotTimeout: 10_000,
    ...config,
  })
  releases.push(() => transport.shutdown())
  return transport
}

interface SilentPeer {
  port: number
  open(): number
}

async function silentPeer(host: string): Promise<SilentPeer> {
  const sockets: Socket[] = []
  const server = createServer(socket => {
    sockets.push(socket)
    socket.on('error', () => socket.destroy())
    socket.resume()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The silent peer has no port')
  releases.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { port: address.port, open: () => sockets.filter(socket => !socket.destroyed).length }
}

function plainSocketTo(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
    releases.push(async () => {
      socket.destroy()
    })
  })
}

describe('the sockets of a gRPC peer', { timeout: TEST_TIMEOUT_MS }, () => {
  it.each(HOST_FORMS)('checks the certificate against a $name target', async form => {
    const trusted = await startTransport('trusted-receiver', {
      host: form.listenHost,
      tls: certificates.everyName,
    })
    await trusted.listen(echoHandler('trusted-receiver'))
    const misnamed = await startTransport('misnamed-receiver', {
      host: form.listenHost,
      tls: certificates.otherName,
    })
    await misnamed.listen(echoHandler('misnamed-receiver'))
    const sender = await startTransport('sender', { tls: certificates.client })

    const payload = new Uint8Array([7, 1])
    const answer = await sender.send(`${form.targetHost}:${trusted.getPort()}`, makeMessage({ payload }))
    expect(answer.payload).toEqual(payload)
    expect(answer.sourceId).toBe('trusted-receiver')

    const refused = await failureOf(sender.send(`${form.targetHost}:${misnamed.getPort()}`, makeMessage()))
    expect(refused).toMatchObject({
      code: TransportErrorCodes.CONNECT_FAILED,
      message: expect.stringMatching(/certificate|altnames/i),
    })
  })

  it.each(HOST_FORMS)('destroys the socket of a failed connect to a $name target', async form => {
    const silent = await silentPeer(form.socketHost)
    const sender = await startTransport('sender', { connectTimeout: SHORT_CONNECT_TIMEOUT_MS })

    const failure = await failureOf(sender.send(`${form.targetHost}:${silent.port}`, makeMessage()))

    expect(failure).toMatchObject({ code: TransportErrorCodes.CONNECT_FAILED })
    await expect.poll(silent.open, { timeout: SOCKETS_CLOSE_WITHIN_MS }).toBe(0)
  })

  it("leaves another pool's connection and a plain socket open when a second pool shuts down", async () => {
    const receiver = await startTransport('receiver')
    await receiver.listen(echoHandler('receiver'))
    const relay = await startReceivingSide(socket => relayTo(receiver.getPort(), socket))
    releases.push(relay.close)
    const plainPeer = await silentPeer('127.0.0.1')
    const kept = await startTransport('kept-sender')
    await kept.send(relay.target, makeMessage({ requestId: 'kept-first' }))
    const stopped = await startTransport('stopped-sender')
    await stopped.send(relay.target, makeMessage({ requestId: 'stopped-first' }))
    const plain = await plainSocketTo(plainPeer.port)
    expect(relay.sockets).toHaveLength(2)

    await stopped.shutdown()

    await expect.poll(relay.openSockets, { timeout: SOCKETS_CLOSE_WITHIN_MS }).toBe(1)
    expect(plain.destroyed).toBe(false)
    expect(plainPeer.open()).toBe(1)
    const answer = await kept.send(relay.target, makeMessage({ requestId: 'kept-second' }))
    expect(answer.requestId).toBe('kept-second')
    expect(relay.sockets).toHaveLength(2)
    expect(relay.openSockets()).toBe(1)
  })
})
