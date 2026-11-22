import type { Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TransportErrorCodes } from '../../../../distribution/transport'
import { createGrpcTransport, type GrpcTransportConfig } from '../../../../distribution/transport/grpc'
import { failureOf, LOOPBACK, type ReceivingSide, relayTo, startReceivingSide } from '../receiving-side'
import {
  echoHandler,
  generateTlsBundles,
  makeMessage,
  makeTlsConfig,
  TLS_BUNDLES_TIMEOUT_MS,
  type TlsBundles,
} from '../tcp-tls/fixtures'

type GrpcTransport = Awaited<ReturnType<typeof createGrpcTransport>>

const WAITERS_PER_METHOD = 5
const SHORT_CONNECT_TIMEOUT_MS = 1_000
const LONG_CONNECT_TIMEOUT_MS = 20_000
const ONE_SHARED_TIMEOUT_WITHIN_MS = 4_000
const SHUTDOWN_WITHIN_MS = 3_000
const SOCKETS_CLOSE_WITHIN_MS = 5_000
const DELIVERED_WITHIN_MS = 500
const TEST_TIMEOUT_MS = 30_000

let bundles: TlsBundles
const releases: Array<() => Promise<void>> = []

beforeAll(async () => {
  bundles = await generateTlsBundles()
}, TLS_BUNDLES_TIMEOUT_MS)

afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release()
})

async function startTransport(nodeId: string, config: Partial<GrpcTransportConfig> = {}): Promise<GrpcTransport> {
  const transport = await createGrpcTransport(nodeId, {
    host: LOOPBACK,
    port: 0,
    connectTimeout: LONG_CONNECT_TIMEOUT_MS,
    requestTimeout: 10_000,
    snapshotTimeout: 10_000,
    ...config,
  })
  releases.push(() => transport.shutdown())
  return transport
}

async function receivingSide(accept: (socket: Socket, position: number) => void): Promise<ReceivingSide> {
  const side = await startReceivingSide(accept)
  releases.push(side.close)
  return side
}

function callsWaitingFor(sender: GrpcTransport, target: string): Array<Promise<unknown>> {
  return Array.from({ length: WAITERS_PER_METHOD }, (_, at) => [
    failureOf(sender.send(target, makeMessage({ requestId: `send-${at}` }))),
    failureOf(sender.stream(target, makeMessage({ requestId: `stream-${at}` }), () => undefined)),
  ]).flat()
}

describe('the connection to one gRPC peer', { timeout: TEST_TIMEOUT_MS }, () => {
  it('rejects every waiter with one failed connect and connects afresh for the next', async () => {
    const receiver = await startTransport('receiver')
    await receiver.listen(echoHandler('receiver'))
    const peer = await receivingSide((socket, position) => {
      if (position === 0) socket.resume()
      else relayTo(receiver.getPort(), socket)
    })
    const sender = await startTransport('sender', { connectTimeout: SHORT_CONNECT_TIMEOUT_MS })

    const startedAt = performance.now()
    const failures = await Promise.all(callsWaitingFor(sender, peer.target))
    expect(performance.now() - startedAt).toBeLessThan(ONE_SHARED_TIMEOUT_WITHIN_MS)
    for (const failure of failures) expect(failure).toMatchObject({ code: TransportErrorCodes.CONNECT_FAILED })
    expect(peer.sockets).toHaveLength(1)
    await expect.poll(peer.openSockets, { timeout: SOCKETS_CLOSE_WITHIN_MS }).toBe(0)

    const payload = new Uint8Array([4, 2])
    const answer = await sender.send(peer.target, makeMessage({ requestId: 'afresh', payload }))
    expect(answer.payload).toEqual(payload)
    expect(peer.sockets).toHaveLength(2)
  })

  it.each(['plain gRPC', 'mutual TLS'] as const)('ends a %s connect in progress on shutdown', async carrier => {
    let connectBegan = (): void => undefined
    const began = new Promise<void>(resolve => {
      connectBegan = resolve
    })
    const silent = await receivingSide(socket => {
      socket.on('data', () => connectBegan())
    })
    const tls = carrier === 'mutual TLS' ? { tls: makeTlsConfig(bundles.clientBundle) } : {}
    const sender = await startTransport('sender', tls)
    const waiting = callsWaitingFor(sender, silent.target)
    await began

    const startedAt = performance.now()
    await sender.shutdown()
    expect(performance.now() - startedAt).toBeLessThan(SHUTDOWN_WITHIN_MS)
    for (const failure of await Promise.all(waiting)) {
      expect(failure).toMatchObject({ code: TransportErrorCodes.CONNECT_FAILED })
    }
    await expect.poll(silent.openSockets, { timeout: SOCKETS_CLOSE_WITHIN_MS }).toBe(0)
  })

  it.each([
    'send',
    'stream',
  ] as const)('refuses a %s that shutdown stops during a connect to a healthy peer', async method => {
    const receiver = await startTransport('receiver')
    let received = 0
    await receiver.listen((message, respond) => {
      received += 1
      return respond(message)
    })
    const sender = await startTransport('sender')
    const target = `${LOOPBACK}:${receiver.getPort()}`
    const call = failureOf(
      method === 'send' ? sender.send(target, makeMessage()) : sender.stream(target, makeMessage(), () => undefined),
    )
    await sender.shutdown()

    expect(await call).toMatchObject({ code: TransportErrorCodes.CONNECT_FAILED })
    await sleep(DELIVERED_WITHIN_MS)
    expect(received).toBe(0)
  })

  it('reports a request that shutdown stops after the hand-over as unknown', async () => {
    const receiver = await startTransport('receiver')
    let received = 0
    let releaseHandlers = (): void => undefined
    const held = new Promise<void>(resolve => {
      releaseHandlers = resolve
    })
    releases.push(async () => releaseHandlers())
    await receiver.listen(async (message, respond) => {
      received += 1
      await held
      await respond(message)
    })
    const sender = await startTransport('sender')
    const target = `${LOOPBACK}:${receiver.getPort()}`
    const sent = failureOf(sender.send(target, makeMessage({ requestId: 'sent' })))
    const streamed = failureOf(sender.stream(target, makeMessage({ requestId: 'streamed' }), () => undefined))
    await expect.poll(() => received, { timeout: SOCKETS_CLOSE_WITHIN_MS }).toBe(2)
    await sender.shutdown()

    for (const failure of await Promise.all([sent, streamed])) {
      expect(failure).toMatchObject({ code: TransportErrorCodes.PEER_UNAVAILABLE })
    }
  })
})
