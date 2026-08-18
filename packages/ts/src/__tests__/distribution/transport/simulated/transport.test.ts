import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SimulatedNetwork } from '../../../../distribution/transport/simulated/transport'
import {
  createSimulatedNetwork,
  createSimulatedTransport,
} from '../../../../distribution/transport/simulated/transport'
import type { NodeTransport, TransportMessage } from '../../../../distribution/transport/types'
import { TransportError, TransportErrorCodes } from '../../../../distribution/transport/types'

const START_TIME = 1_000_000_000

function makeMessage(type: string, sourceId: string, payload = new Uint8Array([1])): TransportMessage {
  return { type, sourceId, requestId: `req-${type}-${sourceId}`, payload }
}

function makeNetwork(faults?: Parameters<typeof createSimulatedNetwork>[0]['faults']): SimulatedNetwork {
  return createSimulatedNetwork({
    seed: 42,
    startTime: START_TIME,
    advanceTimers: ms => vi.advanceTimersByTimeAsync(ms),
    faults,
  })
}

function listenEcho(transport: NodeTransport, nodeId: string): Promise<() => void> {
  return transport.listen((message, respond) => {
    respond({
      type: `${message.type}_result`,
      sourceId: nodeId,
      requestId: message.requestId,
      payload: message.payload,
    })
  })
}

describe('simulated transport', () => {
  let network: SimulatedNetwork

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START_TIME)
    network = makeNetwork()
  })

  afterEach(() => {
    network.scheduler.dispose()
    vi.useRealTimers()
  })

  it('carries a request and its reply through the scheduler', async () => {
    const transportA = createSimulatedTransport('node-a', network)
    const transportB = createSimulatedTransport('node-b', network)
    await listenEcho(transportB, 'node-b')

    const response = await network.scheduler.runWithDrain(() =>
      transportA.send('node-b', makeMessage('query.search', 'node-a', new Uint8Array([7, 8]))),
    )

    expect(response.sourceId).toBe('node-b')
    expect(response.type).toBe('query.search_result')
    expect(Array.from(response.payload)).toEqual([7, 8])
    expect(network.scheduler.now).toBeGreaterThan(START_TIME)
  })

  it('delivers the same exchange order for the same seed', async () => {
    const runExchanges = async () => {
      vi.useFakeTimers()
      vi.setSystemTime(START_TIME)
      const net = makeNetwork({ latencyMinMs: 1, latencyMaxMs: 20 })
      const sender = createSimulatedTransport('node-a', net)
      const receiver = createSimulatedTransport('node-b', net)
      const arrivals: string[] = []
      await receiver.listen((message, respond) => {
        arrivals.push(message.requestId)
        respond({ type: 'echo', sourceId: 'node-b', requestId: message.requestId, payload: message.payload })
      })

      await net.scheduler.runWithDrain(() =>
        Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            sender.send('node-b', {
              type: 'query.search',
              sourceId: 'node-a',
              requestId: `req-${i}`,
              payload: new Uint8Array([i]),
            }),
          ),
        ),
      )
      net.scheduler.dispose()
      vi.useRealTimers()
      return arrivals
    }

    const first = await runExchanges()
    const second = await runExchanges()

    expect(first).toHaveLength(8)
    expect(second).toEqual(first)
  })

  it('times out a dropped request with a transport timeout', async () => {
    const transportA = createSimulatedTransport('node-a', network, { requestTimeout: 400 })
    const transportB = createSimulatedTransport('node-b', network)
    await listenEcho(transportB, 'node-b')
    network.faultPolicy.setDropRate(1)

    const outcome = await network.scheduler.runWithDrain(() =>
      transportA.send('node-b', makeMessage('replication.entry', 'node-a')).then(
        () => 'resolved',
        (error: unknown) => error,
      ),
    )

    expect(outcome).toBeInstanceOf(TransportError)
    expect((outcome as TransportError).code).toBe(TransportErrorCodes.TIMEOUT)
  })

  it('times out both directions across a network partition and recovers after healing', async () => {
    const transportA = createSimulatedTransport('node-a', network, { requestTimeout: 300 })
    const transportB = createSimulatedTransport('node-b', network, { requestTimeout: 300 })
    await listenEcho(transportA, 'node-a')
    await listenEcho(transportB, 'node-b')
    network.faultPolicy.addPartition('node-a', 'node-b')

    const [aToB, bToA] = await network.scheduler.runWithDrain(() =>
      Promise.all([
        transportA.send('node-b', makeMessage('query.search', 'node-a')).then(
          () => 'resolved',
          (error: unknown) => (error as TransportError).code,
        ),
        transportB.send('node-a', makeMessage('query.search', 'node-b')).then(
          () => 'resolved',
          (error: unknown) => (error as TransportError).code,
        ),
      ]),
    )

    expect(aToB).toBe(TransportErrorCodes.TIMEOUT)
    expect(bToA).toBe(TransportErrorCodes.TIMEOUT)

    network.faultPolicy.removePartition('node-a', 'node-b')
    const healed = await network.scheduler.runWithDrain(() =>
      transportA.send('node-b', makeMessage('query.search', 'node-a')),
    )
    expect(healed.sourceId).toBe('node-b')
  })

  it('rejects a send to an unregistered peer without waiting', async () => {
    const transportA = createSimulatedTransport('node-a', network)

    await expect(transportA.send('node-x', makeMessage('query.search', 'node-a'))).rejects.toMatchObject({
      code: TransportErrorCodes.PEER_UNAVAILABLE,
    })
  })

  it('rejects an oversized payload without scheduling it', async () => {
    const transportA = createSimulatedTransport('node-a', network)
    createSimulatedTransport('node-b', network)

    await expect(
      transportA.send('node-b', makeMessage('query.search', 'node-a', new Uint8Array(67_108_865))),
    ).rejects.toMatchObject({ code: TransportErrorCodes.MESSAGE_TOO_LARGE })
    expect(network.scheduler.pendingCount).toBe(0)
  })

  it('times out when the peer shuts down before delivery', async () => {
    const transportA = createSimulatedTransport('node-a', network, { requestTimeout: 300 })
    const transportB = createSimulatedTransport('node-b', network)
    await listenEcho(transportB, 'node-b')

    const outcome = await network.scheduler.runWithDrain(async () => {
      const pending = transportA.send('node-b', makeMessage('query.search', 'node-a')).then(
        () => 'resolved',
        (error: unknown) => (error as TransportError).code,
      )
      await transportB.shutdown()
      return pending
    })

    expect(outcome).toBe(TransportErrorCodes.TIMEOUT)
  })

  it('streams every chunk of a response in order', async () => {
    const transportA = createSimulatedTransport('node-a', network)
    const transportB = createSimulatedTransport('node-b', network)
    await transportB.listen((message, respond) => {
      for (let i = 0; i < 3; i++) {
        respond({
          type: 'replication.snapshot_chunk',
          sourceId: 'node-b',
          requestId: message.requestId,
          payload: new Uint8Array([i]),
        })
      }
    })

    const chunks: number[] = []
    await network.scheduler.runWithDrain(() =>
      transportA.stream('node-b', makeMessage('replication.snapshot_sync_request', 'node-a'), chunk => {
        chunks.push(chunk[0])
      }),
    )

    expect(chunks).toEqual([0, 1, 2])
  })

  it('refuses every call after its own shutdown', async () => {
    const transportA = createSimulatedTransport('node-a', network)
    createSimulatedTransport('node-b', network)
    await transportA.shutdown()

    await expect(transportA.send('node-b', makeMessage('query.search', 'node-a'))).rejects.toMatchObject({
      code: TransportErrorCodes.PEER_UNAVAILABLE,
    })
  })

  it('answers a direct exchange even while the fault policy drops everything', async () => {
    createSimulatedTransport('node-a', network)
    const transportB = createSimulatedTransport('node-b', network)
    await listenEcho(transportB, 'node-b')
    network.faultPolicy.setDropRate(1)

    const response = await network.directExchange('node-b', makeMessage('query.list', 'oracle'))

    expect(response.sourceId).toBe('node-b')
    expect(response.type).toBe('query.list_result')
  })
})
