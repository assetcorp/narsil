import { randomUUID } from 'node:crypto'
import { connect, createServer, type Server, type Socket } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { Etcd3 } from 'etcd3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterCoordinator } from '../../../../distribution/coordinator'
import { createEtcdCoordinator } from '../../../../distribution/coordinator'
import {
  type EtcdContainerHandle,
  eventually,
  MANAGED_ETCD_ENDPOINT,
  makeAllocationTable,
  makeNodeRegistration,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from './fixtures'

const HEARTBEAT_TTL_SECONDS = 2
const LINK_DOWN_MS = 5_000
const RECOVERY_BUDGET_MS = 30_000

interface LinkProxy {
  endpoint: string
  cut(): void
  restore(): void
  close(): Promise<void>
}

async function startLinkProxy(target: URL): Promise<LinkProxy> {
  const sockets = new Set<Socket>()
  let linkUp = true

  function track(socket: Socket): void {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
  }

  const server: Server = createServer(client => {
    track(client)
    if (!linkUp) {
      client.destroy()
      return
    }
    const upstream = connect(Number(target.port), target.hostname)
    track(upstream)
    client.pipe(upstream)
    upstream.pipe(client)
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') reject(new Error('the proxy has no port'))
      else resolve(address.port)
    })
  })

  return {
    endpoint: `http://127.0.0.1:${port}`,
    cut() {
      linkUp = false
      for (const socket of sockets) socket.destroy()
    },
    restore() {
      linkUp = true
    },
    close() {
      for (const socket of sockets) socket.destroy()
      return new Promise(resolve => server.close(() => resolve()))
    },
  }
}

async function compactEverything(raw: Etcd3, probeKey: string): Promise<void> {
  const latest = await raw.get(probeKey).exec()
  await raw.kv.compact({ revision: latest.header.revision })
}

describe('an etcd coordinator whose link to etcd drops', () => {
  let container: EtcdContainerHandle | null = null

  function requireEndpoint(): string {
    if (container === null) throw new Error('etcd is not available')
    return container.endpoint
  }

  beforeAll(async () => {
    if (MANAGED_ETCD_ENDPOINT !== null) {
      container = { endpoint: MANAGED_ETCD_ENDPOINT, name: null }
      await waitForEtcdReady(MANAGED_ETCD_ENDPOINT)
      return
    }
    await runDocker(['version'])
    container = await startEtcdContainer()
  }, 90_000)

  afterAll(async () => {
    await stopEtcdContainer(container?.name ?? null)
    container = null
  }, 30_000)

  it('reports every change made while its watches were cut off, after etcd compacted them away', async () => {
    const endpoint = requireEndpoint()
    const keyPrefix = `_narsil_link_loss_${randomUUID()}`
    const proxy = await startLinkProxy(new URL(endpoint))
    const watching = await createEtcdCoordinator({ endpoints: [proxy.endpoint], keyPrefix })
    const writer = await createEtcdCoordinator({ endpoints: [endpoint], keyPrefix })
    const raw = new Etcd3({ hosts: [endpoint] })
    const tableVersions: number[] = []
    const joinedNodes = new Set<string>()
    const leftNodes = new Set<string>()

    try {
      await writer.registerNode(makeNodeRegistration({ nodeId: 'departing-node' }))
      const stopTables = await watching.watchAllocation(event => tableVersions.push(event.table.version))
      const stopNodes = await watching.watchNodes(event => {
        if (event.type === 'node_joined') joinedNodes.add(event.nodeId)
        else leftNodes.add(event.nodeId)
      })

      const first = makeAllocationTable('books')
      expect(await writer.putAllocation('books', first, null)).toBe(true)
      await eventually(
        async () => expect(tableVersions).toContain(1),
        RECOVERY_BUDGET_MS,
        'the watch never saw the first table',
      )

      proxy.cut()
      expect(await writer.putAllocation('books', { ...first, version: 2 }, 1)).toBe(true)
      expect(await writer.putAllocation('books', { ...first, version: 3 }, 2)).toBe(true)
      await writer.registerNode(makeNodeRegistration({ nodeId: 'arriving-node' }))
      await writer.deregisterNode('departing-node')
      await compactEverything(raw, `${keyPrefix}/probe`)
      await sleep(LINK_DOWN_MS)
      proxy.restore()

      await eventually(
        async () => {
          expect(tableVersions.at(-1)).toBe(3)
          expect(joinedNodes.has('arriving-node')).toBe(true)
          expect(leftNodes.has('departing-node')).toBe(true)
        },
        RECOVERY_BUDGET_MS,
        'the watches never reported the changes made while the link was down',
      )

      expect(await writer.putAllocation('books', { ...first, version: 4 }, 3)).toBe(true)
      await eventually(
        async () => expect(tableVersions.at(-1)).toBe(4),
        RECOVERY_BUDGET_MS,
        'the reopened watch never saw a later table',
      )
      stopTables()
      stopNodes()
    } finally {
      raw.close()
      await watching.shutdown()
      await writer.shutdown()
      await proxy.close()
    }
  }, 120_000)

  it('registers its node again once the lease that held the registration has expired', async () => {
    const endpoint = requireEndpoint()
    const keyPrefix = `_narsil_link_loss_${randomUUID()}`
    const proxy = await startLinkProxy(new URL(endpoint))
    const registering: ClusterCoordinator = await createEtcdCoordinator({
      endpoints: [proxy.endpoint],
      keyPrefix,
      nodeHeartbeatTtlSeconds: HEARTBEAT_TTL_SECONDS,
    })
    const observer = await createEtcdCoordinator({ endpoints: [endpoint], keyPrefix })

    try {
      await registering.registerNode(makeNodeRegistration({ nodeId: 'cut-off-node' }))
      proxy.cut()
      await eventually(
        async () => expect((await observer.listNodes()).map(node => node.nodeId)).not.toContain('cut-off-node'),
        RECOVERY_BUDGET_MS,
        'the registration outlived its lease',
      )
      proxy.restore()

      await eventually(
        async () => expect((await observer.listNodes()).map(node => node.nodeId)).toContain('cut-off-node'),
        RECOVERY_BUDGET_MS,
        'the coordinator never registered its node again',
      )
    } finally {
      await registering.shutdown()
      await observer.shutdown()
      await proxy.close()
    }
  }, 120_000)
})
