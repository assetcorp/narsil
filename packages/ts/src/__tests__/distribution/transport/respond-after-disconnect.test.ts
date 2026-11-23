import { connect, type Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { createGrpcTransport } from '../../../distribution/transport/grpc'
import { createTcpTransport } from '../../../distribution/transport/tcp'
import type { ListenHandler, NodeTransport } from '../../../distribution/transport/types'
import { failureOf, LOOPBACK, startReceivingSide } from './receiving-side'
import { makeMessage } from './tcp/fixtures'

const CHUNK_BYTES = 1024 * 1024
const MAX_CHUNKS = 1024
const STALL_QUIET_MS = 500
const STALL_WITHIN_MS = 15_000
const POLL_MS = 25
const FINISH_WITHIN_MS = 5_000
const PATIENT_TIMEOUT_MS = 60_000
const TEST_TIMEOUT_MS = 40_000

type ListeningTransport = NodeTransport & { getPort(): number }

const releases: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const release of releases.splice(0).reverse()) await release()
})

interface SnapshotLikeHandler {
  handler: ListenHandler
  chunksTaken(): number
  finished: Promise<'finished'>
}

function snapshotLikeHandler(): SnapshotLikeHandler {
  const chunk = new Uint8Array(CHUNK_BYTES).fill(7)
  let taken = 0
  let markFinished: (outcome: 'finished') => void = () => undefined
  const finished = new Promise<'finished'>(resolve => {
    markFinished = resolve
  })
  const handler: ListenHandler = async (message, respond) => {
    for (let at = 0; at < MAX_CHUNKS; at++) {
      await respond({ ...message, sourceId: 'node-b', payload: chunk })
      taken++
    }
    markFinished('finished')
  }
  return { handler, chunksTaken: () => taken, finished }
}

interface StallingRelay {
  target: string
  stopReadingFromServer(): void
  disconnect(): Promise<void>
}

async function stallingRelay(serverPort: number): Promise<StallingRelay> {
  const links: Array<{ inbound: Socket; outbound: Socket }> = []
  const side = await startReceivingSide(inbound => {
    const outbound = connect({ host: LOOPBACK, port: serverPort, noDelay: true })
    outbound.on('error', () => inbound.destroy())
    inbound.on('close', () => outbound.destroy())
    outbound.on('close', () => inbound.destroy())
    inbound.pipe(outbound)
    outbound.pipe(inbound)
    links.push({ inbound, outbound })
  })
  const disconnect = async (): Promise<void> => {
    for (const { outbound } of links) outbound.destroy()
    await side.close()
  }
  releases.push(disconnect)
  return {
    target: side.target,
    stopReadingFromServer: () => {
      for (const { inbound, outbound } of links) {
        outbound.unpipe(inbound)
        outbound.pause()
      }
    },
    disconnect,
  }
}

async function waitForStall(handler: SnapshotLikeHandler): Promise<void> {
  const deadline = Date.now() + STALL_WITHIN_MS
  let last = -1
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    const taken = handler.chunksTaken()
    if (taken !== last) {
      last = taken
      quietSince = Date.now()
    } else if (taken > 0 && Date.now() - quietSince >= STALL_QUIET_MS) {
      return
    }
    await sleep(POLL_MS)
  }
  throw new Error(`The handler never stalled on a full send buffer after ${last} chunks`)
}

async function expectHandlerToFinishAfterThePeerLeaves(server: ListeningTransport, client: NodeTransport) {
  const streaming = snapshotLikeHandler()
  await server.listen(streaming.handler)
  const relay = await stallingRelay(server.getPort())
  let chunksReceived = 0

  const answer = failureOf(
    client.stream(relay.target, makeMessage({ requestId: 'snapshot-stream' }), () => {
      chunksReceived++
      if (chunksReceived === 1) relay.stopReadingFromServer()
    }),
  )
  await waitForStall(streaming)
  expect(streaming.chunksTaken()).toBeLessThan(MAX_CHUNKS)

  await relay.disconnect()
  await answer

  const outcome = await Promise.race([
    streaming.finished,
    sleep(FINISH_WITHIN_MS).then(() => `still waiting after ${streaming.chunksTaken()} chunks`),
  ])
  expect(outcome).toBe('finished')
}

describe('a streaming handler whose peer leaves while its send buffer is full', () => {
  it(
    'finishes on the TCP carrier',
    async () => {
      const options = {
        host: LOOPBACK,
        port: 0,
        requestTimeout: PATIENT_TIMEOUT_MS,
        snapshotTimeout: PATIENT_TIMEOUT_MS,
      }
      const server = createTcpTransport('node-b', options)
      const client = createTcpTransport('node-a', options)
      releases.push(
        () => server.shutdown(),
        () => client.shutdown(),
      )
      await expectHandlerToFinishAfterThePeerLeaves(server, client)
    },
    TEST_TIMEOUT_MS,
  )

  it(
    'finishes on the gRPC carrier',
    async () => {
      const options = {
        host: LOOPBACK,
        port: 0,
        requestTimeout: PATIENT_TIMEOUT_MS,
        snapshotTimeout: PATIENT_TIMEOUT_MS,
      }
      const server = await createGrpcTransport('node-b', options)
      const client = await createGrpcTransport('node-a', options)
      releases.push(
        () => server.shutdown(),
        () => client.shutdown(),
      )
      await expectHandlerToFinishAfterThePeerLeaves(server, client)
    },
    TEST_TIMEOUT_MS,
  )
})
