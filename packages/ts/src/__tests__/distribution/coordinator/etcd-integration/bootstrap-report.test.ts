import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../../distribution/cluster-node'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import { createEtcdCoordinator } from '../../../../distribution/coordinator'
import { createTcpTransport } from '../../../../distribution/transport/tcp'
import { NarsilError } from '../../../../errors'
import {
  type EtcdContainerHandle,
  eventually,
  MANAGED_ETCD_ENDPOINT,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from './fixtures'
import { type LinkProxy, startLinkProxy } from './link-proxy'

const INDEX = 'catalogue'
const FIRST_HEARTBEAT_OVER_MS = 12_000
const PLACEMENT_SETTLED_MS = 1_500
const COORDINATOR_DOWN_MS = 5_500
const ACTIVE_WITHIN_MS = 30_000
const REPORTS_EXHAUSTED_WITHIN_MS = 120_000

interface Member {
  node: ClusterNode
  peerLink: LinkProxy
  coordinatorLink: LinkProxy
  failures: NarsilError[]
}

describe('a primary that loses the coordinator while it reports a finished bootstrap', () => {
  let container: EtcdContainerHandle | null = null
  const closers: Array<() => Promise<void>> = []

  function requireEndpoint(): string {
    if (container === null) throw new Error('etcd is not available')
    return container.endpoint
  }

  async function startMember(nodeId: string, roles: ClusterNode['roles'], keyPrefix: string): Promise<Member> {
    const transport = createTcpTransport(nodeId, { host: '127.0.0.1', port: 0 })
    closers.push(() => transport.shutdown())
    const peerLink = await startLinkProxy(() => new URL(`http://127.0.0.1:${transport.getPort()}`))
    closers.push(peerLink.close)
    const coordinatorLink = await startLinkProxy(new URL(requireEndpoint()))
    closers.push(coordinatorLink.close)
    const coordinator = await createEtcdCoordinator({ endpoints: [coordinatorLink.endpoint], keyPrefix })
    closers.push(() => coordinator.shutdown())
    const failures: NarsilError[] = []
    const node = await createClusterNode({
      coordinator,
      transport,
      nodeId,
      address: new URL(peerLink.endpoint).host,
      roles: [...roles],
      engine: { workers: { enabled: false } },
      onError: error => {
        if (error instanceof NarsilError && error.code === 'NODE_BOOTSTRAP_FAILED') failures.push(error)
      },
    })
    closers.push(() => node.shutdown())
    await node.start()
    return { node, peerLink, coordinatorLink, failures }
  }

  async function reportingPrimary() {
    const keyPrefix = `_narsil_bootstrap_report_${randomUUID()}`
    const observer = await createEtcdCoordinator({ endpoints: [requireEndpoint()], keyPrefix })
    closers.push(() => observer.shutdown())
    const controller = await startMember('warehouse-controller', ['controller'], keyPrefix)
    const primary = await startMember('warehouse-primary', ['data', 'coordinator'], keyPrefix)
    await sleep(FIRST_HEARTBEAT_OVER_MS)

    controller.peerLink.cut()
    await primary.node.createIndex(
      INDEX,
      { language: 'english', schema: { title: 'string' } },
      { partitionCount: 1, replicationFactor: 0, waitForServingMs: 0 },
    )
    await eventually(
      async () => expect(controller.peerLink.refusedConnections()).toBeGreaterThan(0),
      ACTIVE_WITHIN_MS,
      'the primary never tried to report its bootstrap',
    )
    await sleep(PLACEMENT_SETTLED_MS)
    primary.coordinatorLink.cut()
    const stateOfPartition = async () => (await observer.getAllocation(INDEX))?.assignments.get(0)?.state
    return { controller, primary, stateOfPartition }
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
    for (const close of closers.reverse()) await close().catch(() => undefined)
    await stopEtcdContainer(container?.name ?? null)
    container = null
  }, 60_000)

  it('keeps retrying through the outage and takes writes once both links return', async () => {
    const { controller, primary, stateOfPartition } = await reportingPrimary()
    await sleep(COORDINATOR_DOWN_MS)
    expect(await stateOfPartition()).toBe('INITIALISING')

    primary.coordinatorLink.restore()
    controller.peerLink.restore()

    await eventually(
      async () => expect(await stateOfPartition()).toBe('ACTIVE'),
      ACTIVE_WITHIN_MS,
      'the primary stopped reporting its finished bootstrap',
    )
    const documentId = await primary.node.insert(INDEX, { title: 'cedar shelf' })
    expect(await primary.node.get(INDEX, documentId)).toMatchObject({ title: 'cedar shelf' })
    expect(primary.failures).toEqual([])
  }, 120_000)

  it('reports the code of the outage once its last retry fails', async () => {
    const { primary, stateOfPartition } = await reportingPrimary()

    await eventually(
      async () => expect(primary.failures).toHaveLength(1),
      REPORTS_EXHAUSTED_WITHIN_MS,
      'the primary gave up without a report',
    )
    expect(primary.failures[0]?.details).toMatchObject({ indexName: INDEX, innerCode: 'COORDINATOR_UNAVAILABLE' })
    expect(await stateOfPartition()).toBe('INITIALISING')
  }, 180_000)
})
