import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NODE_LIFECYCLE_CONFIG } from '../../../../../distribution/cluster/constants'
import { createDataNodeLifecycle } from '../../../../../distribution/cluster/node-lifecycle'
import type { DataNodeHandle } from '../../../../../distribution/cluster/node-lifecycle/types'
import { createInMemoryCoordinator } from '../../../../../distribution/coordinator'
import type { ClusterCoordinator, NodeEvent } from '../../../../../distribution/coordinator/types'
import type { InMemoryNetwork, NodeTransport } from '../../../../../distribution/transport'
import { createInMemoryNetwork, createInMemoryTransport } from '../../../../../distribution/transport'
import { flushPromises, makeNode } from './fixtures'

const NODE_REGISTRATION_TTL_MS = 30_000

describe('DataNodeLifecycle registration heartbeat', () => {
  let coordinator: ClusterCoordinator
  let network: InMemoryNetwork
  let nodeTransport: NodeTransport
  let lifecycle: DataNodeHandle | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    coordinator = createInMemoryCoordinator()
    network = createInMemoryNetwork()
    nodeTransport = createInMemoryTransport('data-1', network)
  })

  afterEach(async () => {
    if (lifecycle !== undefined) {
      await lifecycle.shutdown()
      lifecycle = undefined
    }
    await nodeTransport.shutdown()
    await coordinator.shutdown()
    vi.useRealTimers()
  })

  function createLifecycle(): DataNodeHandle {
    lifecycle = createDataNodeLifecycle({
      registration: makeNode('data-1'),
      coordinator,
      transport: nodeTransport,
      knownIndexNames: [],
      bootstrapRetryBaseMs: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapRetryBaseMs,
      bootstrapRetryMaxMs: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapRetryMaxMs,
      bootstrapMaxRetries: DEFAULT_NODE_LIFECYCLE_CONFIG.bootstrapMaxRetries,
      allocationDebounceMs: DEFAULT_NODE_LIFECYCLE_CONFIG.allocationDebounceMs,
      nodeHeartbeatIntervalMs: DEFAULT_NODE_LIFECYCLE_CONFIG.nodeHeartbeatIntervalMs,
      onBootstrapPartition: vi.fn().mockResolvedValue(true),
    })
    return lifecycle
  }

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
    await flushPromises()
  }

  it('keeps the node registered past the coordinator lease', async () => {
    const handle = createLifecycle()
    await handle.join()

    await advance(NODE_REGISTRATION_TTL_MS * 3)

    const nodes = await coordinator.listNodes()
    expect(nodes.map(node => node.nodeId)).toEqual(['data-1'])
  })

  it('renews the lease without announcing the node again', async () => {
    const events: NodeEvent[] = []
    await coordinator.watchNodes(event => {
      events.push(event)
    })

    const handle = createLifecycle()
    await handle.join()
    await advance(NODE_REGISTRATION_TTL_MS * 2)

    expect(events.filter(event => event.type === 'node_joined')).toHaveLength(1)
  })

  it('waits for an in-flight heartbeat before it deregisters the node', async () => {
    const handle = createLifecycle()
    await handle.join()

    let releaseHeartbeat = (): void => {}
    const heartbeatGate = new Promise<void>(resolve => {
      releaseHeartbeat = resolve
    })
    const registerNode = coordinator.registerNode.bind(coordinator)
    let gated = false
    coordinator.registerNode = async registration => {
      if (!gated) {
        gated = true
        await heartbeatGate
      }
      await registerNode(registration)
    }

    vi.advanceTimersByTime(DEFAULT_NODE_LIFECYCLE_CONFIG.nodeHeartbeatIntervalMs)
    const leaving = handle.leave()
    releaseHeartbeat()
    await leaving
    await flushPromises()

    expect(await coordinator.listNodes()).toEqual([])
  })

  it('stops renewing once the node leaves, so the registration expires', async () => {
    const handle = createLifecycle()
    await handle.join()
    await handle.leave()

    await advance(NODE_REGISTRATION_TTL_MS * 2)

    expect(await coordinator.listNodes()).toEqual([])
  })
})
