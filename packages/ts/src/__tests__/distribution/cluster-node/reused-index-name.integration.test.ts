import { decode, encode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationEvent, ClusterCoordinator, SchemaEvent } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import type { NodeTransport } from '../../../distribution/transport/types'
import { waitForSettledReplica } from './cluster-harness'

const POLL_INTERVAL_MS = 25
const POLL_BUDGET_MS = 15_000
const SCHEMA = { title: 'string', price: 'number' } as const
const OLD_IDS = Array.from({ length: 15 }, (_, index) => `gadget-${index}`)

function pause(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function pollUntil(predicate: () => Promise<boolean> | boolean): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < POLL_BUDGET_MS) {
    if (await predicate()) return true
    await pause(POLL_INTERVAL_MS)
  }
  return false
}

function withWatchOutage(coordinator: ClusterCoordinator) {
  let down = false
  const allocationHandlers = new Set<(event: AllocationEvent) => void>()
  const schemaHandlers = new Set<(event: SchemaEvent) => void>()
  const wrapped = new Proxy(coordinator, {
    get(target, property, receiver) {
      if (property === 'watchAllocation') {
        return async (handler: (event: AllocationEvent) => void) => {
          allocationHandlers.add(handler)
          const unwatch = await target.watchAllocation(event => {
            if (!down) handler(event)
          })
          return () => {
            allocationHandlers.delete(handler)
            unwatch()
          }
        }
      }
      if (property === 'watchSchemas') {
        return async (handler: (event: SchemaEvent) => void) => {
          schemaHandlers.add(handler)
          const unwatch = await target.watchSchemas(event => {
            if (!down) handler(event)
          })
          return () => {
            schemaHandlers.delete(handler)
            unwatch()
          }
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return {
    coordinator: wrapped,
    disconnect() {
      down = true
    },
    async reconnect(indexName: string) {
      down = false
      const table = await coordinator.getAllocation(indexName)
      if (table !== null) for (const handler of allocationHandlers) handler({ indexName, table })
      const schema = await coordinator.getSchema(indexName)
      if (schema !== null) {
        for (const handler of schemaHandlers) handler({ type: 'schema_created', indexName, schema })
      }
    },
  }
}

function withHeldDeletes(coordinator: ClusterCoordinator) {
  let held: { reached: () => void; released: Promise<void> } | null = null
  const wrapped = new Proxy(coordinator, {
    get(target, property, receiver) {
      if (property === 'deleteAllocation') {
        return async (indexName: string) => {
          const gate = held
          if (gate !== null) {
            held = null
            gate.reached()
            await gate.released
          }
          return target.deleteAllocation(indexName)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return {
    coordinator: wrapped,
    holdNext() {
      let release = () => {}
      let reached = () => {}
      const reachedPromise = new Promise<void>(resolve => {
        reached = resolve
      })
      const released = new Promise<void>(resolve => {
        release = resolve
      })
      held = { reached, released }
      return { reached: reachedPromise, release }
    },
  }
}

async function servedIds(node: ClusterNode): Promise<string[] | null> {
  try {
    const result = await node.query('products', { term: 'Gadget', limit: 100 })
    return result.hits.map(hit => hit.id).sort()
  } catch {
    return null
  }
}

async function storedIndexUuid(coordinator: ClusterCoordinator): Promise<string> {
  const stored = await coordinator.get('_narsil/index/products/config')
  if (stored === null || stored.byteLength === 0) throw new Error('products has no stored metadata')
  const metadata = decode(stored) as { indexUuid?: unknown }
  if (typeof metadata.indexUuid !== 'string') throw new Error('products metadata holds no indexUuid')
  return metadata.indexUuid
}

async function heldIndexUuid(transport: NodeTransport, nodeId: string): Promise<string | null> {
  const response = await transport.send(nodeId, {
    type: 'cluster.partition_stores',
    sourceId: 'probe',
    requestId: `probe-${Date.now()}-${Math.random()}`,
    payload: encode({ indexName: 'products' }),
  })
  const answer = decode(response.payload) as { indexUuid?: unknown }
  return typeof answer.indexUuid === 'string' ? answer.indexUuid : null
}

describe('a name reused by a new index', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeA: ClusterNode | undefined
  let nodeB: ClusterNode | undefined
  let transportA: NodeTransport
  let transportB: NodeTransport
  let probe: NodeTransport
  let controllerSide: ReturnType<typeof withHeldDeletes>
  let outage: ReturnType<typeof withWatchOutage>

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transportA = createInMemoryTransport('node-a', network)
    transportB = createInMemoryTransport('node-b', network)
    probe = createInMemoryTransport('probe', network)
    controllerSide = withHeldDeletes(coordinator)
    outage = withWatchOutage(coordinator)

    nodeA = await createClusterNode({
      coordinator: controllerSide.coordinator,
      transport: transportA,
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'coordinator', 'controller'],
    })
    await nodeA.start()
    await nodeA.createIndex('products', { schema: SCHEMA })

    nodeB = await createClusterNode({
      coordinator: outage.coordinator,
      transport: transportB,
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['data', 'coordinator'],
    })
    await nodeB.start()
    await waitForSettledReplica(coordinator, 'products', 'node-b')

    const inserted = await nodeA.insertBatch(
      'products',
      OLD_IDS.map((id, index) => ({ id, title: `Foldable Gadget ${index}`, price: index })),
    )
    expect(inserted.failed).toEqual([])
    expect((await servedIds(nodeB))?.length).toBe(OLD_IDS.length)
  }, 30_000)

  afterEach(async () => {
    if (nodeA !== undefined) {
      await nodeA.shutdown()
      nodeA = undefined
    }
    if (nodeB !== undefined) {
      await nodeB.shutdown()
      nodeB = undefined
    }
    await transportA.shutdown()
    await transportB.shutdown()
    await probe.shutdown()
    await coordinator.shutdown()
  })

  it('drops the old copy and keeps every acknowledged write once a watch that missed the drop and the create reconnects', async () => {
    if (nodeA === undefined || nodeB === undefined) throw new Error('nodes missing')
    const first = nodeA
    const second = nodeB
    const droppedUuid = await storedIndexUuid(coordinator)

    outage.disconnect()
    const dropped = await first.dropIndex('products').then(
      () => null,
      (error: unknown) => error,
    )
    expect(dropped).toMatchObject({ code: 'QUERY_NODE_TIMEOUT', details: { pendingNodeIds: ['node-b'] } })

    const creating = first.createIndex('products', { schema: SCHEMA }, { partitionCount: 2 }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(await pollUntil(async () => (await coordinator.getAllocation('products'))?.assignments.size === 2)).toBe(
      true,
    )
    const createdUuid = await storedIndexUuid(coordinator)
    expect(createdUuid).not.toBe(droppedUuid)

    const fromA = Array.from({ length: 10 }, (_, index) => `rebuilt-a-${index}`)
    const writing = first.insertBatch(
      'products',
      fromA.map((id, index) => ({ id, title: `Rebuilt Gadget ${index}`, price: index })),
    )
    await pause(500)
    await outage.reconnect('products')

    const insertedByA = await writing
    expect(await creating).toBeNull()
    expect(insertedByA.failed).toEqual([])
    expect([...insertedByA.succeeded].sort()).toEqual([...fromA].sort())

    expect(await pollUntil(async () => (await heldIndexUuid(probe, 'node-b')) === createdUuid)).toBe(true)

    const seen = new Set<string>()
    const routed = await pollUntil(async () => {
      const ids = await servedIds(second)
      for (const id of ids ?? []) seen.add(id)
      return ids !== null && JSON.stringify(ids) === JSON.stringify([...fromA].sort())
    })
    expect(routed).toBe(true)

    const fromB = Array.from({ length: 10 }, (_, index) => `rebuilt-b-${index}`)
    const insertedByB = await second.insertBatch(
      'products',
      fromB.map((id, index) => ({ id, title: `Rebuilt Gadget ${index}`, price: index })),
    )
    expect(insertedByB.failed).toEqual([])

    const expected = [...fromA, ...fromB].sort()
    for (const node of [first, second]) {
      const ids = await servedIds(node)
      expect(ids).toEqual(expected)
      expect(await node.countDocuments('products')).toBe(expected.length)
      expect([...(await node.getMultiple('products', OLD_IDS)).keys()]).toEqual([])
    }
    expect([...seen].filter(id => OLD_IDS.includes(id))).toEqual([])
  }, 120_000)

  it('allocates and serves a name created again while the controller still tears down the old table', async () => {
    if (nodeA === undefined || nodeB === undefined) throw new Error('nodes missing')
    const first = nodeA
    const second = nodeB

    const teardown = controllerSide.holdNext()
    const dropping = first.dropIndex('products').then(
      () => null,
      (error: unknown) => error,
    )
    await teardown.reached

    const creating = second.createIndex('products', { schema: SCHEMA }, { partitionCount: 2 })
    expect(await pollUntil(async () => (await coordinator.getSchema('products')) !== null)).toBe(true)
    await pause(300)
    teardown.release()
    await creating
    expect(await dropping).toBeNull()

    const fresh = Array.from({ length: 10 }, (_, index) => `rebuilt-${index}`)
    const inserted = await second.insertBatch(
      'products',
      fresh.map((id, index) => ({ id, title: `Rebuilt Gadget ${index}`, price: index })),
    )
    expect(inserted.failed).toEqual([])

    const seen = new Set<string>()
    for (const node of [first, second]) {
      const served = await pollUntil(async () => {
        const ids = await servedIds(node)
        for (const id of ids ?? []) seen.add(id)
        return ids !== null && JSON.stringify(ids) === JSON.stringify([...fresh].sort())
      })
      expect(served).toBe(true)
      expect(await node.countDocuments('products')).toBe(fresh.length)
      expect([...(await node.getMultiple('products', OLD_IDS)).keys()]).toEqual([])
    }
    expect([...seen].filter(id => OLD_IDS.includes(id))).toEqual([])

    const table = await coordinator.getAllocation('products')
    expect(table?.assignments.size).toBe(2)
    for (const assignment of table?.assignments.values() ?? []) expect(assignment.state).toBe('ACTIVE')
  }, 60_000)
})
