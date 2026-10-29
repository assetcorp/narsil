import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { type ClusterCoordinator, createEtcdCoordinator } from '../../../distribution/coordinator'
import type { EtcdCoordinatorConfig } from '../../../distribution/coordinator/etcd/types'
import { createTcpTransport } from '../../../distribution/transport/tcp'
import { NarsilError } from '../../../errors'
import { generateTlsBundles, type TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'
import { ETCD_ROOT_PASSWORD, type EtcdMembers, startEtcdMembers } from './etcd-members'

const FOREIGN_NODE = 'harbour-foreign'

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (error instanceof NarsilError) return error.code
    throw error
  }
  throw new Error('expected the start to fail')
}

describe.skipIf(process.env.NARSIL_FAULT_PLAIN === '1')(
  'a node that starts against a secured etcd with bad settings',
  () => {
    let bundles: TlsBundles
    let etcd: EtcdMembers | null = null
    let directory = ''
    const opened: Array<{ shutdown(): Promise<void> }> = []

    function settings(overrides: Partial<EtcdCoordinatorConfig> = {}): Partial<EtcdCoordinatorConfig> {
      return {
        endpoints: [...(etcd?.endpoints ?? [])],
        keyPrefix: `_narsil_start_errors_${randomUUID()}`,
        tls: { ca: bundles.serverBundle.ca, cert: bundles.clientBundle.cert, key: bundles.clientBundle.key },
        auth: { username: 'root', password: ETCD_ROOT_PASSWORD },
        ...overrides,
      }
    }

    async function coordinatorFor(keyPrefix: string): Promise<ClusterCoordinator> {
      const coordinator = await createEtcdCoordinator(settings({ keyPrefix }))
      opened.push(coordinator)
      return coordinator
    }

    async function nodeOn(
      coordinator: ClusterCoordinator,
      nodeId: string,
      nodeDirectory?: string,
    ): Promise<ClusterNode> {
      const ownDirectory = nodeDirectory ?? (await mkdtemp(join(directory, `${nodeId}-`)))
      const transport = createTcpTransport(nodeId, { host: '127.0.0.1', port: 0 })
      opened.push(transport)
      const node = await createClusterNode({
        coordinator,
        transport,
        address: `127.0.0.1:${transport.getPort()}`,
        nodeId,
        roles: ['data', 'coordinator', 'controller'],
        engine: { workers: { enabled: false }, durability: { directory: ownDirectory } },
      })
      opened.unshift(node)
      return node
    }

    beforeAll(async () => {
      bundles = await generateTlsBundles()
      etcd = await startEtcdMembers(bundles)
      directory = await mkdtemp(join(tmpdir(), 'narsil-start-errors-'))
    }, 240_000)

    afterAll(async () => {
      for (const resource of opened.splice(0)) await resource.shutdown().catch(() => {})
      await etcd?.remove()
      if (directory !== '') await rm(directory, { recursive: true, force: true })
    }, 120_000)

    it('fails with COORDINATOR_UNAVAILABLE where etcd presents a certificate from another authority', async () => {
      const tls = { ca: bundles.rogueBundle.ca, cert: bundles.clientBundle.cert, key: bundles.clientBundle.key }
      expect(await codeOf(createEtcdCoordinator(settings({ tls })))).toBe('COORDINATOR_UNAVAILABLE')
    }, 60_000)

    it('fails with COORDINATOR_AUTH_FAILED on a wrong password', async () => {
      expect(await codeOf(createEtcdCoordinator(settings({ auth: { username: 'root', password: 'wrong' } })))).toBe(
        'COORDINATOR_AUTH_FAILED',
      )
    }, 60_000)

    it('fails with NODE_VERSION_INCOMPATIBLE while the controller follows another major version', async () => {
      const coordinator = await coordinatorFor(`_narsil_start_errors_${randomUUID()}`)
      await coordinator.registerNode({
        nodeId: FOREIGN_NODE,
        address: `${FOREIGN_NODE}:9200`,
        roles: ['data', 'controller'],
        capacity: { memoryBytes: 64_000_000_000, cpuCores: 32, diskBytes: 1_000_000_000_000 },
        startedAt: '2026-10-01T00:00:00.000Z',
        version: '2.0',
      })
      expect(await coordinator.acquireLease('_narsil/controller', FOREIGN_NODE, 60_000)).toBe(true)

      const node = await nodeOn(coordinator, 'harbour-a')
      expect(await codeOf(node.start())).toBe('NODE_VERSION_INCOMPATIBLE')
    }, 60_000)

    it('fails with CONFIG_INVALID where another node holds its durability directory', async () => {
      const coordinator = await coordinatorFor(`_narsil_start_errors_${randomUUID()}`)
      const shared = await mkdtemp(join(directory, 'shared-'))
      const holder = await nodeOn(coordinator, 'harbour-b', shared)
      await holder.start()

      expect(await codeOf(nodeOn(coordinator, 'harbour-c', shared))).toBe('CONFIG_INVALID')
    }, 60_000)
  },
)
