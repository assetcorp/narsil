import { connect, createServer, type Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TransportErrorCodes } from '../../../../distribution/transport'
import { createTcpTransport, type TcpTransportConfig } from '../../../../distribution/transport/tcp'
import {
  echoHandler,
  generateTlsBundles,
  makeMessage,
  makeTlsConfig,
  TLS_BUNDLES_TIMEOUT_MS,
  type TlsBundles,
} from '../tcp-tls/fixtures'

const LOOPBACK = '127.0.0.1'
const CONCURRENT_FIRST_SENDS = 300
const CONNECT_TIMEOUT_MS = 20_000
const SHUTDOWN_WITHIN_MS = 2_000
const FRAME_ARRIVES_WITHIN_MS = 200
const LENGTH_BYTES = 4
const RESPONSE_FRAME = 2
const LENGTH_BEYOND_THE_LIMIT = Buffer.from([0xff, 0xff, 0xff, 0xff])

let bundles: TlsBundles
const releases: Array<() => Promise<void>> = []

beforeAll(async () => {
  bundles = await generateTlsBundles()
}, TLS_BUNDLES_TIMEOUT_MS)

afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release()
})

function startTransport(nodeId: string, config: Partial<TcpTransportConfig> = {}) {
  const transport = createTcpTransport(nodeId, {
    host: LOOPBACK,
    port: 0,
    connectTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: 10_000,
    snapshotTimeout: 10_000,
    ...config,
  })
  releases.push(() => transport.shutdown())
  return transport
}

async function startReceivingSide(accept: (socket: Socket, position: number) => void) {
  const sockets: Socket[] = []
  const server = createServer({ noDelay: true }, socket => {
    socket.on('error', () => socket.destroy())
    sockets.push(socket)
    accept(socket, sockets.length - 1)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK, resolve)
  })
  releases.push(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The receiving side has no port')
  return {
    target: `${LOOPBACK}:${address.port}`,
    sockets,
    openSockets: () => sockets.filter(socket => !socket.destroyed).length,
  }
}

function relayTo(port: number, inbound: Socket): void {
  const outbound = connect({ host: LOOPBACK, port, noDelay: true })
  inbound.pipe(outbound)
  outbound.pipe(inbound)
  outbound.on('error', () => inbound.destroy())
  outbound.on('close', () => inbound.destroy())
  inbound.on('close', () => outbound.destroy())
}

function onEachRequest(socket: Socket, receive: (requestId: string, data: Uint8Array) => void): void {
  let buffered = Buffer.alloc(0)
  socket.on('data', (data: Buffer) => {
    buffered = Buffer.concat([buffered, data])
    while (buffered.length >= LENGTH_BYTES) {
      const end = LENGTH_BYTES + buffered.readUInt32BE(0)
      if (buffered.length < end) return
      const frame = decode(buffered.subarray(LENGTH_BYTES, end)) as { requestId: string; data: Uint8Array }
      receive(frame.requestId, new Uint8Array(frame.data))
      buffered = buffered.subarray(end)
    }
  })
}

function respond(socket: Socket, requestId: string, data: Uint8Array): void {
  const body = encode({ frameType: RESPONSE_FRAME, requestId, data })
  const prefix = Buffer.alloc(LENGTH_BYTES)
  prefix.writeUInt32BE(body.byteLength)
  socket.write(Buffer.concat([prefix, body]))
}

function failureOf(request: Promise<unknown>): Promise<unknown> {
  return request.then(
    () => 'the request succeeded',
    (error: unknown) => error,
  )
}

describe('the connection to one TCP peer', () => {
  it.each([
    'plain TCP',
    'mutual TLS',
  ] as const)('carries every concurrent first send and stream over %s and closes on shutdown', async carrier => {
    const secured = carrier === 'mutual TLS'
    const receiver = startTransport('receiver', secured ? { tls: makeTlsConfig(bundles.serverBundle) } : {})
    await receiver.listen(echoHandler('receiver'))
    const relay = await startReceivingSide(socket => relayTo(receiver.getPort(), socket))
    const sender = startTransport('sender', secured ? { tls: makeTlsConfig(bundles.clientBundle) } : {})

    const payloads = Array.from({ length: CONCURRENT_FIRST_SENDS }, (_, at) => new Uint8Array([at >> 8, at & 0xff, 7]))
    const streamed: Uint8Array[] = []
    const streaming = sender.stream(
      relay.target,
      makeMessage({ requestId: 'first-stream', payload: new Uint8Array([9]) }),
      chunk => {
        streamed.push(chunk)
      },
    )
    const answers = await Promise.all(
      payloads.map((payload, at) => sender.send(relay.target, makeMessage({ requestId: `first-${at}`, payload }))),
    )
    await streaming

    expect(answers.map(answer => answer.payload)).toEqual(payloads)
    expect(streamed).toEqual([new Uint8Array([9])])
    expect(relay.sockets).toHaveLength(1)

    await sender.shutdown()
    await expect.poll(relay.openSockets, { timeout: SHUTDOWN_WITHIN_MS }).toBe(0)
  })

  it('rejects every request that waits for a failed connect and connects afresh for the next', async () => {
    const receiver = startTransport('receiver', { tls: makeTlsConfig(bundles.serverBundle) })
    await receiver.listen(echoHandler('receiver'))
    const relay = await startReceivingSide((socket, position) => {
      if (position === 0) socket.destroy()
      else relayTo(receiver.getPort(), socket)
    })
    const sender = startTransport('sender', { tls: makeTlsConfig(bundles.clientBundle) })

    const failures = await Promise.all([
      failureOf(sender.stream(relay.target, makeMessage({ requestId: 'waiting-stream' }), () => undefined)),
      ...Array.from({ length: 20 }, (_, at) =>
        failureOf(sender.send(relay.target, makeMessage({ requestId: `waiting-${at}` }))),
      ),
    ])
    for (const failure of failures) expect(failure).toMatchObject({ code: TransportErrorCodes.CONNECT_FAILED })
    expect(relay.sockets).toHaveLength(1)

    const payload = new Uint8Array([4, 2])
    const answer = await sender.send(relay.target, makeMessage({ requestId: 'afresh', payload }))
    expect(answer.payload).toEqual(payload)
    expect(relay.sockets).toHaveLength(2)
  })

  it('ends a TLS connect in progress on shutdown', async () => {
    let handshakeBegan = (): void => undefined
    const began = new Promise<void>(resolve => {
      handshakeBegan = resolve
    })
    const silent = await startReceivingSide(socket => {
      socket.on('data', () => handshakeBegan())
    })
    const sender = startTransport('sender', { tls: makeTlsConfig(bundles.clientBundle) })
    const sent = failureOf(sender.send(silent.target, makeMessage({ requestId: 'sent' })))
    const streamed = failureOf(sender.stream(silent.target, makeMessage({ requestId: 'streamed' }), () => undefined))
    await began

    const startedAt = performance.now()
    await sender.shutdown()
    expect(performance.now() - startedAt).toBeLessThan(SHUTDOWN_WITHIN_MS)
    for (const failure of await Promise.all([sent, streamed])) {
      expect(failure).toMatchObject({ code: TransportErrorCodes.CONNECT_FAILED })
    }
    await expect.poll(silent.openSockets, { timeout: SHUTDOWN_WITHIN_MS }).toBe(0)
  })

  it('writes no request once shutdown begins during a plain connect', async () => {
    let bytesReceived = 0
    const peer = await startReceivingSide(socket => {
      socket.on('data', data => {
        bytesReceived += data.byteLength
      })
    })
    const sender = startTransport('sender')
    const sent = failureOf(sender.send(peer.target, makeMessage({ requestId: 'sent' })))
    const streamed = failureOf(sender.stream(peer.target, makeMessage({ requestId: 'streamed' }), () => undefined))
    await sender.shutdown()

    for (const failure of await Promise.all([sent, streamed])) {
      expect(failure).toMatchObject({ code: TransportErrorCodes.CONNECT_FAILED })
    }
    await sleep(FRAME_ARRIVES_WITHIN_MS)
    expect(bytesReceived).toBe(0)
    expect(peer.openSockets()).toBe(0)
  })

  it('keeps a replacement and its pending request when the connection that it replaced closes', async () => {
    let oldClosed = (): void => undefined
    const closed = new Promise<void>(resolve => {
      oldClosed = resolve
    })
    const peer = await startReceivingSide((socket, position) => {
      if (position === 0) {
        socket.on('close', () => oldClosed())
        socket.once('data', () => socket.write(LENGTH_BEYOND_THE_LIMIT))
        return
      }
      onEachRequest(socket, (requestId, data) => {
        void closed.then(() => sleep(FRAME_ARRIVES_WITHIN_MS)).then(() => respond(socket, requestId, data))
      })
    })
    const sender = startTransport('sender')

    let failure: unknown
    const replacement = await sender.send(peer.target, makeMessage({ requestId: 'old' })).catch((error: unknown) => {
      failure = error
      return sender.send(peer.target, makeMessage({ requestId: 'replacement', payload: new Uint8Array([2]) }))
    })
    const reused = await sender.send(peer.target, makeMessage({ requestId: 'reused', payload: new Uint8Array([3]) }))

    expect(failure).toMatchObject({ code: TransportErrorCodes.PEER_UNAVAILABLE })
    expect(replacement.payload).toEqual(new Uint8Array([2]))
    expect(reused.payload).toEqual(new Uint8Array([3]))
    expect(peer.sockets).toHaveLength(2)
    expect(peer.openSockets()).toBe(1)
  })
})
