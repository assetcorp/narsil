import { randomUUID } from 'node:crypto'
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
import { startLinkProxy } from './link-proxy'

const HEARTBEAT_TTL_SECONDS = 2
const LINK_DOWN_MS = 5_000
const RECOVERY_BUDGET_MS = 30_000

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

      expect(await writer.acquireLease('_narsil/controller', 'writer', 30_000)).toBe(true)
      const first = makeAllocationTable('books')
      expect(await writer.putAllocation('books', first, null, 'writer')).toBe(true)
      await eventually(
        async () => expect(tableVersions).toContain(1),
        RECOVERY_BUDGET_MS,
        'the watch never saw the first table',
      )

      proxy.cut()
      expect(await writer.putAllocation('books', { ...first, version: 2 }, 1, 'writer')).toBe(true)
      expect(await writer.putAllocation('books', { ...first, version: 3 }, 2, 'writer')).toBe(true)
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

      expect(await writer.putAllocation('books', { ...first, version: 4 }, 3, 'writer')).toBe(true)
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
