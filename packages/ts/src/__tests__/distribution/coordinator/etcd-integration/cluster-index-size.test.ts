import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../../distribution/cluster-node'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import type { ClusterCoordinator } from '../../../../distribution/coordinator'
import { createEtcdCoordinator } from '../../../../distribution/coordinator'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../distribution/transport'
import type { NodeTransport } from '../../../../distribution/transport/types'
import { ErrorCodes, NarsilError } from '../../../../errors'
import type { SchemaDefinition } from '../../../../types/schema'
import {
  type EtcdContainerHandle,
  MANAGED_ETCD_ENDPOINT,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from './fixtures'

const ETCD_DEFAULT_MAX_REQUEST_BYTES = 1_572_864

function stopWordsOver(bytes: number): Set<string> {
  const words = new Set<string>()
  let total = 0
  for (let word = 0; total <= bytes; word++) {
    const text = `stopword${String(word).padStart(8, '0')}`
    words.add(text)
    total += text.length + 1
  }
  return words
}

function schemaOver(bytes: number): SchemaDefinition {
  const schema: SchemaDefinition = {}
  let total = 0
  for (let field = 0; total <= bytes; field++) {
    const name = `field_${String(field).padStart(6, '0')}`
    schema[name] = 'number'
    total += name.length + 8
  }
  return schema
}

async function refusalOf(action: Promise<unknown>): Promise<NarsilError> {
  try {
    await action
  } catch (error) {
    if (error instanceof NarsilError) return error
    throw error
  }
  throw new Error('The index was created where a refusal was expected')
}

describe('EtcdCoordinator integration - cluster index larger than one etcd request', () => {
  let container: EtcdContainerHandle | null = null
  let coordinator: ClusterCoordinator | null = null
  let transport: NodeTransport | null = null
  let node: ClusterNode | null = null

  function started(): { coordinator: ClusterCoordinator; node: ClusterNode } {
    if (coordinator === null || node === null) throw new Error('The cluster node is not started')
    return { coordinator, node }
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

  beforeEach(async () => {
    if (container === null) throw new Error('Etcd integration container is not available')
    coordinator = await createEtcdCoordinator({
      endpoints: [container.endpoint],
      keyPrefix: `_narsil_cluster_size_${randomUUID()}`,
      nodeHeartbeatTtlSeconds: 5,
    })
    transport = createInMemoryTransport('node-a', createInMemoryNetwork())
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await node.start()
  }, 60_000)

  afterEach(async () => {
    await node?.shutdown()
    await transport?.shutdown()
    await coordinator?.shutdown()
    node = null
    transport = null
    coordinator = null
  }, 60_000)

  afterAll(async () => {
    await stopEtcdContainer(container?.name ?? null)
  }, 30_000)

  it('refuses a stop word list too large for one etcd request and leaves the name free', async () => {
    const cluster = started()
    const refused = await refusalOf(
      cluster.node.createIndex('products', {
        schema: { title: 'string' },
        stopWords: stopWordsOver(ETCD_DEFAULT_MAX_REQUEST_BYTES),
      }),
    )
    expect(refused.code).toBe(ErrorCodes.CONFIG_INVALID)
    expect(await cluster.coordinator.getSchema('products')).toBeNull()

    await cluster.node.createIndex('products', { schema: { title: 'string' } })
    expect(await cluster.coordinator.getSchema('products')).toEqual({ title: 'string' })
  }, 120_000)

  it('refuses a schema too large for one etcd request and withdraws the index', async () => {
    const cluster = started()
    const refused = await refusalOf(
      cluster.node.createIndex('products', { schema: schemaOver(ETCD_DEFAULT_MAX_REQUEST_BYTES) }),
    )
    expect(refused.code).toBe(ErrorCodes.CONFIG_INVALID)
    expect(await cluster.coordinator.getSchema('products')).toBeNull()
    expect(await cluster.coordinator.listSchemas()).toEqual([])

    await cluster.node.createIndex('products', { schema: { title: 'string' } })
    expect(await cluster.coordinator.getSchema('products')).toEqual({ title: 'string' })
  }, 120_000)
})
