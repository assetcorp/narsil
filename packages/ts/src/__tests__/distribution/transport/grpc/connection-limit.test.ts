import { connect, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { ClusterMessageTypes, TransportError, type TransportMessage } from '../../../../distribution/transport'
import { createGrpcTransport } from '../../../../distribution/transport/grpc'

type GrpcTransport = Awaited<ReturnType<typeof createGrpcTransport>>

const INBOUND_CONNECTION_LIMIT = 256
const EXTRA_CONNECTIONS = 8
const SETTLE_MS = 1_000

const hasIpv6Loopback = Object.values(networkInterfaces()).some(addresses =>
  (addresses ?? []).some(entry => entry.family === 'IPv6' && entry.address === '::1'),
)

interface ListenSetting {
  configuredHost: string
  socketHost: string
  targetHost: string
}

const IPV4_LOOPBACK: ListenSetting = { configuredHost: '127.0.0.1', socketHost: '127.0.0.1', targetHost: '127.0.0.1' }
const BRACKETED_IPV6_LOOPBACK: ListenSetting = { configuredHost: '[::1]', socketHost: '::1', targetHost: '[::1]' }

function ping(requestId: string): TransportMessage {
  return { type: ClusterMessageTypes.PING, sourceId: 'flooding-peer', requestId, payload: new Uint8Array([1]) }
}

function openSocket(host: string, port: number): Promise<{ socket: Socket; closed: () => boolean }> {
  return new Promise((resolve, reject) => {
    let closed = false
    const socket = connect(port, host)
    socket.on('error', () => {})
    socket.once('close', () => {
      closed = true
    })
    socket.once('connect', () => resolve({ socket, closed: () => closed }))
    socket.once('error', reject)
  })
}

describe('gRPC carrier inbound connection limit', () => {
  const held: Socket[] = []
  const transports: GrpcTransport[] = []

  afterEach(async () => {
    for (const socket of held.splice(0)) socket.destroy()
    for (const transport of transports.splice(0)) await transport.shutdown()
  })

  async function transportNamed(nodeId: string, host: string): Promise<GrpcTransport> {
    const transport = await createGrpcTransport(nodeId, {
      host,
      port: 0,
      requestTimeout: 3_000,
      connectTimeout: 2_000,
      snapshotTimeout: 5_000,
    })
    transports.push(transport)
    return transport
  }

  async function floodAndRecover(setting: ListenSetting): Promise<void> {
    const receiver = await transportNamed('receiver', setting.configuredHost)
    await receiver.listen((message, respond) =>
      respond({
        type: ClusterMessageTypes.PONG,
        sourceId: 'receiver',
        requestId: message.requestId,
        payload: message.payload,
      }),
    )
    const port = receiver.getPort()
    const target = `${setting.targetHost}:${port}`

    const opened: Array<{ socket: Socket; closed: () => boolean }> = []
    for (let at = 0; at < INBOUND_CONNECTION_LIMIT + EXTRA_CONNECTIONS; at++) {
      const entry = await openSocket(setting.socketHost, port)
      opened.push(entry)
      held.push(entry.socket)
    }
    await sleep(SETTLE_MS)

    const stillOpen = opened.filter(entry => !entry.closed()).length
    expect(stillOpen).toBe(INBOUND_CONNECTION_LIMIT)
    expect(opened.slice(INBOUND_CONNECTION_LIMIT).every(entry => entry.closed())).toBe(true)

    const peer = await transportNamed('peer', setting.configuredHost)
    const refused = await peer.send(target, ping('while-full')).catch((thrown: unknown) => thrown)
    expect(refused).toBeInstanceOf(TransportError)

    for (const entry of opened.slice(0, EXTRA_CONNECTIONS)) entry.socket.destroy()
    await sleep(SETTLE_MS)

    const fresh = await transportNamed('fresh-peer', setting.configuredHost)
    const answered = await fresh.send(target, ping('after-release'))
    expect(answered).toMatchObject({ type: ClusterMessageTypes.PONG, sourceId: 'receiver', requestId: 'after-release' })
  }

  it('closes every connection past 256 and serves a peer again once a slot frees', { timeout: 60_000 }, async () => {
    await floodAndRecover(IPV4_LOOPBACK)
  })

  it.skipIf(!hasIpv6Loopback)(
    'enforces the limit on a bracketed IPv6 listen address',
    { timeout: 60_000 },
    async () => {
      await floodAndRecover(BRACKETED_IPV6_LOOPBACK)
    },
  )
})
