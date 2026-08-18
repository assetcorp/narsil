import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import { ErrorCodes, NarsilError } from '../../../errors'
import type { SchemaDefinition } from '../../../types/schema'

const SCHEMA: SchemaDefinition = { title: 'string' }
const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000

async function pollUntil(predicate: () => Promise<boolean> | boolean): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  return false
}

describe('a node rejoining with an index the cluster dropped', () => {
  let directory: string
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let node: ClusterNode | undefined

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-orphan-'))
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
  })

  afterEach(async () => {
    if (node !== undefined) {
      await node.shutdown()
      node = undefined
    }
    await coordinator.shutdown()
    await rm(directory, { recursive: true, force: true })
  })

  async function startNode(): Promise<ClusterNode> {
    const started = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('node-a', network),
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
      engine: { durability: { directory } },
    })
    await started.start()
    return started
  }

  async function forgetIndexInCoordinator(): Promise<void> {
    await coordinator.dropSchema('products')
    await coordinator.compareAndSet(
      '_narsil/index/products/config',
      await coordinator.get('_narsil/index/products/config'),
      new Uint8Array(0),
    )
    await coordinator.deleteAllocation('products')
  }

  async function seedIndexAndStop(): Promise<void> {
    const writer = await startNode()
    await writer.createIndex('products', { schema: SCHEMA }, { partitionCount: 2, replicationFactor: 0 })
    expect(await pollUntil(async () => (await writer.cluster.getAllocation('products')) !== null)).toBe(true)
    await writer.insert('products', { title: 'stale trolley' }, 'product-1')
    await writer.checkpoint('products')
    await writer.shutdown()
  }

  it('serves nothing from a copy the coordinator no longer knows', async () => {
    await seedIndexAndStop()
    await forgetIndexInCoordinator()

    node = await startNode()

    await expect(node.countDocuments('products')).rejects.toMatchObject({ code: ErrorCodes.INDEX_ORPHANED })
    await expect(node.query('products', { term: 'trolley' })).rejects.toMatchObject({
      code: ErrorCodes.INDEX_ORPHANED,
    })
    await expect(node.insert('products', { title: 'new' })).rejects.toMatchObject({
      code: ErrorCodes.INDEX_ORPHANED,
    })
  }, 30_000)

  it('tells the operator which index it refused and why', async () => {
    await seedIndexAndStop()
    await forgetIndexInCoordinator()
    const reported: Error[] = []

    node = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('node-a', network),
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
      engine: { durability: { directory } },
      onError: error => reported.push(error),
    })
    await node.start()

    const orphanReport = reported.find(
      error => error instanceof NarsilError && error.code === ErrorCodes.INDEX_ORPHANED,
    )
    expect(orphanReport?.message).toContain('products')
  }, 30_000)

  it('serves the index again once an operator drops the copy the cluster dropped', async () => {
    await seedIndexAndStop()
    await forgetIndexInCoordinator()

    node = await startNode()
    await node.dropIndex('products')
    await node.createIndex('products', { schema: SCHEMA }, { partitionCount: 2, replicationFactor: 0 })
    expect(await pollUntil(async () => (await node?.cluster.getAllocation('products')) !== null)).toBe(true)

    expect(await node.countDocuments('products')).toBe(0)
  }, 30_000)

  it('replaces a copy the cluster created again under the same name', async () => {
    await seedIndexAndStop()
    await forgetIndexInCoordinator()

    const recreator = await createClusterNode({
      coordinator,
      transport: createInMemoryTransport('node-b', network),
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['data', 'coordinator', 'controller'],
    })
    await recreator.start()
    await recreator.createIndex('products', { schema: SCHEMA }, { partitionCount: 2, replicationFactor: 0 })
    expect(await pollUntil(async () => (await recreator.cluster.getAllocation('products')) !== null)).toBe(true)

    node = await startNode()
    const rejoined = node
    const settled = await pollUntil(async () => {
      try {
        return (await rejoined.countDocuments('products')) === 0
      } catch {
        return false
      }
    })
    await recreator.shutdown()

    expect(settled).toBe(true)
  }, 30_000)
})
