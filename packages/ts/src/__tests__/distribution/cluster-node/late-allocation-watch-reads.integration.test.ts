import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { AllocationEvent, ClusterCoordinator } from '../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport'
import { waitForActiveAllocation } from './cluster-harness'

const INDEX_NAME = 'pantry'

function withAllocationWatchesStuckOnInitialising(coordinator: ClusterCoordinator): ClusterCoordinator {
  return new Proxy(coordinator, {
    get(target, property, receiver) {
      if (property === 'watchAllocation') {
        return (handler: (event: AllocationEvent) => void) => {
          let stuck = false
          return target.watchAllocation(event => {
            if (stuck) return
            handler(event)
            if ([...event.table.assignments.values()].some(assignment => assignment.state !== 'ACTIVE')) stuck = true
          })
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

describe('a coordinator node whose allocation watch has yet to deliver the ACTIVE table', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let transports: NodeTransport[]
  let holder: ClusterNode
  let router: ClusterNode

  beforeEach(async () => {
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    transports = [createInMemoryTransport('node-a', network), createInMemoryTransport('node-b', network)]
    holder = await createClusterNode({
      coordinator,
      transport: transports[0],
      address: 'node-a:9200',
      nodeId: 'node-a',
      roles: ['data', 'controller', 'coordinator'],
    })
    router = await createClusterNode({
      coordinator: withAllocationWatchesStuckOnInitialising(coordinator),
      transport: transports[1],
      address: 'node-b:9200',
      nodeId: 'node-b',
      roles: ['coordinator'],
    })
    await holder.start()
    await router.start()
  }, 30_000)

  afterEach(async () => {
    await router.shutdown()
    await holder.shutdown()
    for (const transport of transports) await transport.shutdown()
    await coordinator.shutdown()
  })

  it('reads the live table before refusing a document read, a count, and a list', async () => {
    await holder.createIndex(INDEX_NAME, { schema: { title: 'string', price: 'number' } })
    await waitForActiveAllocation(coordinator, INDEX_NAME)
    await holder.insert(INDEX_NAME, { title: 'smoked paprika', price: 4 }, 'paprika')

    expect(await router.get(INDEX_NAME, 'paprika')).toEqual({ title: 'smoked paprika', price: 4 })
    expect(await router.countDocuments(INDEX_NAME)).toBe(1)
    expect((await router.listDocuments(INDEX_NAME)).documents.map(entry => entry.id)).toEqual(['paprika'])
  }, 30_000)
})
