import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { indexConfigKey } from '../../../distribution/cluster/index-metadata'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import { ErrorCodes, NarsilError } from '../../../errors'
import { makeAllocationTable, makeAssignment } from '../query/routing/fixtures'

const INDEX_NAME = 'shop'
const ABSENT_PRIMARY = 'node-z'

async function codeOf(work: Promise<unknown>): Promise<string | null> {
  try {
    await work
    return null
  } catch (error) {
    return error instanceof NarsilError ? error.code : String(error)
  }
}

describe('a node reading and writing an index the cluster owns', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transport: NodeTransport
  let node: ClusterNode

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transport = createInMemoryTransport('node-a', network)
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator'],
    })
    await node.start()
    await node.createIndex(INDEX_NAME, { schema: { title: 'string', price: 'number' } })
  }, 30_000)

  afterEach(async () => {
    await node.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
  })

  it('refuses every read and write while the coordinator holds no allocation table for it', async () => {
    expect(await coordinator.getAllocation(INDEX_NAME)).toBeNull()

    const document = { title: 'portable grinder', price: 40 }
    expect(await codeOf(node.insert(INDEX_NAME, document, 'item-1'))).toBe(ErrorCodes.QUERY_ROUTING_FAILED)
    expect(await codeOf(node.insertBatch(INDEX_NAME, [document]))).toBe(ErrorCodes.QUERY_ROUTING_FAILED)
    expect(await codeOf(node.update(INDEX_NAME, 'item-1', document))).toBe(ErrorCodes.QUERY_ROUTING_FAILED)
    expect(await codeOf(node.remove(INDEX_NAME, 'item-1'))).toBe(ErrorCodes.QUERY_ROUTING_FAILED)
    expect(await codeOf(node.query(INDEX_NAME, { term: 'portable' }))).toBe(ErrorCodes.QUERY_ROUTING_FAILED)
    expect(await codeOf(node.countDocuments(INDEX_NAME))).toBe(ErrorCodes.QUERY_ROUTING_FAILED)
    expect(await codeOf(node.getStats(INDEX_NAME))).toBe(ErrorCodes.QUERY_ROUTING_FAILED)
    expect(await codeOf(node.listDocuments(INDEX_NAME))).toBe(ErrorCodes.QUERY_ROUTING_FAILED)
    expect(await codeOf(node.get(INDEX_NAME, 'item-1'))).toBe(ErrorCodes.QUERY_ROUTING_FAILED)
    expect(await codeOf(node.suggest(INDEX_NAME, { prefix: 'po' }))).toBe(ErrorCodes.QUERY_ROUTING_FAILED)
  }, 30_000)

  it('refuses an exact read while no partition has a copy in service, where a search reports every partition failed', async () => {
    const table = makeAllocationTable(
      [
        [0, makeAssignment({ primary: ABSENT_PRIMARY, inSyncSet: [], state: 'INITIALISING' })],
        [1, makeAssignment({ primary: ABSENT_PRIMARY, inSyncSet: [], state: 'INITIALISING' })],
      ],
      INDEX_NAME,
    )
    expect(await coordinator.putAllocation(INDEX_NAME, table, null)).toBe(true)

    expect(await codeOf(node.countDocuments(INDEX_NAME))).toBe(ErrorCodes.QUERY_NO_ACTIVE_REPLICA)
    expect(await codeOf(node.getStats(INDEX_NAME))).toBe(ErrorCodes.QUERY_NO_ACTIVE_REPLICA)
    expect(await codeOf(node.getPartitionStats(INDEX_NAME))).toBe(ErrorCodes.QUERY_NO_ACTIVE_REPLICA)
    expect(await codeOf(node.listDocuments(INDEX_NAME))).toBe(ErrorCodes.QUERY_NO_ACTIVE_REPLICA)
    expect(await codeOf(node.getMultiple(INDEX_NAME, ['item-1']))).toBe(ErrorCodes.QUERY_NO_ACTIVE_REPLICA)

    const search = await node.query(INDEX_NAME, { term: 'portable' })
    expect(search.hits).toEqual([])
    expect(search.coverage).toEqual({
      totalPartitions: 2,
      queriedPartitions: 0,
      timedOutPartitions: 0,
      failedPartitions: 2,
    })
  }, 30_000)
})

describe('a node that refuses partial results reading an index the cluster owns', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transport: NodeTransport
  let node: ClusterNode

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transport = createInMemoryTransport('node-a', network)
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator'],
      query: { allowPartialResults: false },
    })
    await node.start()
    await node.createIndex(INDEX_NAME, { schema: { title: 'string', price: 'number' } })
  }, 30_000)

  afterEach(async () => {
    await node.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
  })

  it('refuses the search while no partition has a copy in service', async () => {
    const table = makeAllocationTable(
      [[0, makeAssignment({ primary: ABSENT_PRIMARY, inSyncSet: [], state: 'INITIALISING' })]],
      INDEX_NAME,
    )
    expect(await coordinator.putAllocation(INDEX_NAME, table, null)).toBe(true)

    expect(await codeOf(node.query(INDEX_NAME, { term: 'portable' }))).toBe(ErrorCodes.QUERY_PARTIAL_FAILURE)
  }, 30_000)
})

describe('a node holding an index the coordinator has no metadata for', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transport: NodeTransport
  let node: ClusterNode

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transport = createInMemoryTransport('node-a', network)
    node = await createClusterNode({
      coordinator,
      transport,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator'],
    })
    await node.start()
    await node.createIndex(INDEX_NAME, { schema: { title: 'string', price: 'number' } })
    const metadata = await coordinator.get(indexConfigKey(INDEX_NAME))
    expect(await coordinator.compareAndSet(indexConfigKey(INDEX_NAME), metadata, new Uint8Array(0))).toBe(true)
  }, 30_000)

  afterEach(async () => {
    await node.shutdown()
    await transport.shutdown()
    await coordinator.shutdown()
  })

  it('serves reads and writes from its own copy', async () => {
    await node.insert(INDEX_NAME, { title: 'portable grinder', price: 40 }, 'item-1')

    const search = await node.query(INDEX_NAME, { term: 'portable' })
    expect(search.count).toBe(1)
    expect(search.coverage.failedPartitions).toBe(0)
    expect(await node.countDocuments(INDEX_NAME)).toBe(1)
    expect(await node.get(INDEX_NAME, 'item-1')).toEqual({ title: 'portable grinder', price: 40 })
  }, 30_000)
})
