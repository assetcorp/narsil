import { decode, encode } from '@msgpack/msgpack'
import { afterEach, describe, expect, it } from 'vitest'
import { createClusterNode } from '../../../distribution/cluster-node'
import type { ClusterNode } from '../../../distribution/cluster-node/types'
import { createInMemoryCoordinator } from '../../../distribution/coordinator'
import type { ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../distribution/transport/in-memory'
import type { NodeTransport } from '../../../distribution/transport/types'
import { type FaultyTransport, faultyTransport, ofType, waitUntil } from './acknowledged-writes/harness'

const INDEX = 'handover-ledger'
const REPLICATION_TIMEOUT_MS = 500
const WRITE_WAIT_MS = 2_000

function allocationGate(inner: ClusterCoordinator) {
  let paused: Promise<void> | undefined
  let release: () => void = () => undefined
  let waiting = 0
  return {
    coordinator: new Proxy(inner, {
      get(target, property, receiver) {
        if (property !== 'getAllocation') return Reflect.get(target, property, receiver)
        return async (indexName: string) => {
          if (paused !== undefined) {
            waiting += 1
            await paused
          }
          return target.getAllocation(indexName)
        }
      },
    }),
    hold() {
      paused = new Promise<void>(resolve => {
        release = resolve
      })
    },
    release() {
      paused = undefined
      release()
    },
    waiting: () => waiting,
  }
}

describe('lead handover through live cluster nodes', () => {
  const nodes = new Map<string, ClusterNode>()
  const transports = new Map<string, FaultyTransport>()
  const gates: Array<ReturnType<typeof allocationGate>> = []
  let coordinator: ClusterCoordinator | undefined
  let probe: NodeTransport | undefined

  afterEach(async () => {
    for (const gate of gates.splice(0)) gate.release()
    for (const node of [...nodes.values()].reverse()) await node.shutdown()
    nodes.clear()
    transports.clear()
    await probe?.shutdown()
    await coordinator?.shutdown()
  })

  async function start(replicationFactor: number) {
    const shared = createInMemoryCoordinator()
    coordinator = shared
    const gate = allocationGate(shared)
    gates.push(gate)
    const network = createInMemoryNetwork()
    const reader = createInMemoryTransport('handover-reader', network)
    probe = reader
    for (const nodeId of ['data-first', 'data-second', 'controller']) {
      const transport = faultyTransport(
        createInMemoryTransport(nodeId, network, { replicationTimeout: REPLICATION_TIMEOUT_MS }),
        nodeId,
      )
      const node = await createClusterNode({
        nodeId,
        address: nodeId,
        coordinator: nodeId === 'controller' ? shared : gate.coordinator,
        transport,
        roles: nodeId === 'controller' ? ['controller', 'coordinator'] : ['data'],
        engine: { workers: { enabled: false } },
      })
      nodes.set(nodeId, node)
      transports.set(nodeId, transport)
      await node.start()
    }
    const router = nodes.get('controller')
    if (router === undefined) throw new Error('The controller did not start')
    await router.createIndex(INDEX, { schema: { title: 'string' } }, { partitionCount: 1, replicationFactor })
    const assignment = await waitUntil('the partition to become writable', async () => {
      const current = (await shared.getAllocation(INDEX))?.assignments.get(0)
      return current?.state === 'ACTIVE' && current.primary !== null && current.inSyncSet.length === replicationFactor
        ? current
        : null
    })
    const primary = assignment.primary
    if (primary === null) throw new Error('The partition has no primary')
    await router.insert(INDEX, { title: 'settled transfer' }, 'settled')
    async function handover(action: 'block' | 'lift') {
      if (primary === null) throw new Error('The partition has no primary')
      const targetNodeId = assignment.inSyncSet[0]
      if (targetNodeId === undefined) throw new Error('The partition has no in-sync replica')
      return reader.send(primary, {
        type: 'cluster.lead_handoff',
        sourceId: 'handover-reader',
        requestId: `handover-${action}`,
        payload: encode({
          indexName: INDEX,
          partitionId: 0,
          primaryTerm: assignment.primaryTerm,
          targetNodeId,
          action,
        }),
      })
    }
    return { router, primary, assignment, gate, handover }
  }

  it('hands over a draining primary before removing its last copy at replication factor zero', async () => {
    const { router, primary } = await start(0)
    const node = nodes.get(primary)
    const transport = transports.get(primary)
    if (node === undefined || transport === undefined) throw new Error('The primary did not start')
    const handovers = transport.recordArrivalsWhen(ofType('cluster.lead_handoff'))

    await node.decommission()

    expect(handovers.map(message => decode(message.payload))).toContainEqual(
      expect.objectContaining({ indexName: INDEX, partitionId: 0, action: 'block' }),
    )
    expect((await router.get(INDEX, 'settled'))?.title).toBe('settled transfer')
    await router.insert(INDEX, { title: 'after the drain' }, 'after-drain')
    expect((await router.get(INDEX, 'after-drain'))?.title).toBe('after the drain')
  }, 30_000)

  it('releases queued writes on lift while the expiry read waits for the coordinator', async () => {
    const { router, gate, handover } = await start(1)
    const blocked = await handover('block')
    expect(blocked.type).toBe('cluster.lead_handoff')
    gate.hold()
    await waitUntil('the expiry read to reach the coordinator', () => gate.waiting() > 0)
    const lifted = await handover('lift')
    expect(lifted.type).toBe('cluster.lead_handoff')
    let written = false
    const write = router.insert(INDEX, { title: 'after the lift' }, 'after-lift').then(() => {
      written = true
    })
    try {
      await waitUntil('the lifted write to finish before the coordinator answers', () => written, WRITE_WAIT_MS)
    } finally {
      gate.release()
      await write
    }
    expect((await router.get(INDEX, 'after-lift'))?.title).toBe('after the lift')
  }, 30_000)
})
