import { createServer, type Http2Server, type ServerHttp2Stream } from 'node:http2'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { TransportError, TransportErrorCodes } from '../../../../distribution/transport'
import { createGrpcTransport } from '../../../../distribution/transport/grpc'
import { failureOf, LOOPBACK } from '../receiving-side'
import { makeMessage } from '../tcp-tls/fixtures'

type GrpcTransport = Awaited<ReturnType<typeof createGrpcTransport>>

const OPEN_STREAM_PATH = '/narsil.transport.v1.NodeTransport/OpenStream'
const CHUNKS = 26
const CHUNKS_BEFORE_GOAWAY = 2
const BYTES_FIELD_KEY = 0x0a
const GRPC_STATUS_OK = '0'
const GRPC_STATUS_UNIMPLEMENTED = '12'
const SETTLES_WITHIN_MS = 10_000
const SHUTDOWN_WITHIN_MS = 3_000
const RECONNECT_EVERY_MS = 20
const TEST_TIMEOUT_MS = 30_000

const releases: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release()
})

function chunkFrame(value: number): Buffer {
  return Buffer.from([0, 0, 0, 0, 3, BYTES_FIELD_KEY, 1, value])
}

interface DrainingPeer {
  target: string
  wentAway: Promise<void>
  disconnected: Promise<void>
  resume(): void
}

function settledOnce(): { settled: Promise<void>; settle: () => void } {
  let settle = (): void => undefined
  const settled = new Promise<void>(resolve => {
    settle = resolve
  })
  return { settled, settle }
}

function answerUnimplemented(stream: ServerHttp2Stream): void {
  stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
  stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': GRPC_STATUS_UNIMPLEMENTED }))
  stream.end()
}

async function drainingPeer(): Promise<DrainingPeer> {
  const goaway = settledOnce()
  const disconnect = settledOnce()
  const resumed = settledOnce()
  const server: Http2Server = createServer()
  let streamed = false
  server.on('session', session => {
    session.on('error', () => undefined)
    session.once('close', () => disconnect.settle())
  })
  server.on('stream', (stream, headers) => {
    stream.on('error', () => undefined)
    if (headers[':path'] !== OPEN_STREAM_PATH || streamed) {
      answerUnimplemented(stream)
      return
    }
    streamed = true
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': GRPC_STATUS_OK }))
    for (let value = 0; value < CHUNKS_BEFORE_GOAWAY; value++) stream.write(chunkFrame(value))
    server.close()
    stream.session?.close()
    goaway.settle()
    void resumed.settled.then(() => {
      for (let value = CHUNKS_BEFORE_GOAWAY; value < CHUNKS; value++) stream.write(chunkFrame(value))
      stream.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, LOOPBACK, resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('The draining peer has no port')
  releases.push(async () => {
    resumed.settle()
    server.close()
  })
  return {
    target: `${LOOPBACK}:${address.port}`,
    wentAway: goaway.settled,
    disconnected: disconnect.settled,
    resume: resumed.settle,
  }
}

async function startSender(): Promise<GrpcTransport> {
  const sender = await createGrpcTransport('sender', {
    host: LOOPBACK,
    port: 0,
    connectTimeout: 2_000,
    requestTimeout: 5_000,
    snapshotTimeout: SETTLES_WITHIN_MS,
  })
  releases.push(() => sender.shutdown())
  return sender
}

interface Draining {
  streaming: Promise<unknown>
  received: () => number
}

async function streamUntilAReconnectFails(sender: GrpcTransport, peer: DrainingPeer): Promise<Draining> {
  let received = 0
  const streaming = failureOf(
    sender.stream(peer.target, makeMessage({ requestId: 'drained-stream' }), () => {
      received += 1
    }),
  )
  await peer.wentAway
  const startedAt = performance.now()
  for (;;) {
    const failure = await failureOf(sender.send(peer.target, makeMessage({ requestId: 'after-goaway' })))
    if (failure instanceof TransportError && failure.code === TransportErrorCodes.CONNECT_FAILED) break
    expect(performance.now() - startedAt).toBeLessThan(SETTLES_WITHIN_MS)
    await sleep(RECONNECT_EVERY_MS)
  }
  return { streaming, received: () => received }
}

describe('a gRPC connection that the peer drains with GOAWAY', { timeout: TEST_TIMEOUT_MS }, () => {
  it('finishes its stream while a reconnect to the same peer fails', async () => {
    const peer = await drainingPeer()
    const sender = await startSender()
    const draining = await streamUntilAReconnectFails(sender, peer)

    peer.resume()

    expect(await draining.streaming).toBe('the request succeeded')
    expect(draining.received()).toBe(CHUNKS)
  })

  it('closes on shutdown and fails its stream as unavailable', async () => {
    const peer = await drainingPeer()
    const sender = await startSender()
    const draining = await streamUntilAReconnectFails(sender, peer)

    const startedAt = performance.now()
    await sender.shutdown()

    expect(performance.now() - startedAt).toBeLessThan(SHUTDOWN_WITHIN_MS)
    await peer.disconnected
    expect(await draining.streaming).toMatchObject({ code: TransportErrorCodes.PEER_UNAVAILABLE })
    expect(draining.received()).toBe(CHUNKS_BEFORE_GOAWAY)
  })
})
