import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ClusterCoordinator, NodeEvent } from '../../../../distribution/coordinator'
import { createEtcdCoordinator } from '../../../../distribution/coordinator'
import {
  type EtcdContainerHandle,
  eventually,
  MANAGED_ETCD_ENDPOINT,
  makeNodeRegistration,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from './fixtures'

describe('EtcdCoordinator integration - nodes and leases', () => {
  let container: EtcdContainerHandle | null = null
  let coordinator: ClusterCoordinator | null = null

  function getCoordinator(): ClusterCoordinator {
    if (coordinator === null) {
      throw new Error('Etcd coordinator test instance is not initialized')
    }

    return coordinator
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
    if (container === null) {
      throw new Error('Etcd integration container is not available')
    }

    coordinator = await createEtcdCoordinator({
      endpoints: [container.endpoint],
      keyPrefix: `_narsil_etcd_integration_${randomUUID()}`,
      nodeHeartbeatTtlSeconds: 5,
      leaseTtlSeconds: 5,
    })
  })

  afterEach(async () => {
    if (coordinator === null) {
      return
    }

    await coordinator.shutdown()
    coordinator = null
  })

  afterAll(async () => {
    if (coordinator !== null) {
      await coordinator.shutdown()
      coordinator = null
    }

    await stopEtcdContainer(container?.name ?? null)
    container = null
  }, 30_000)

  it('registers nodes, lists them, and emits watch events against real etcd', async () => {
    const coordinator = getCoordinator()
    const events: NodeEvent[] = []
    const stopWatching = await coordinator.watchNodes(event => events.push(event))

    try {
      const registration = makeNodeRegistration()
      await coordinator.registerNode(registration)

      await eventually(
        async () => {
          expect(events).toHaveLength(1)
          expect(events[0]?.type).toBe('node_joined')
          expect(events[0]?.nodeId).toBe(registration.nodeId)
          expect(events[0]?.registration).toEqual(registration)
        },
        5_000,
        'Timed out waiting for node_joined watch event',
      )

      const listed = await coordinator.listNodes()
      expect(listed).toHaveLength(1)
      expect(listed[0]?.nodeId).toBe(registration.nodeId)

      await coordinator.deregisterNode(registration.nodeId)

      await eventually(
        async () => {
          expect(events).toHaveLength(2)
          expect(events[1]?.type).toBe('node_left')
          expect(events[1]?.nodeId).toBe(registration.nodeId)
          expect(events[1]?.registration).toBeNull()
        },
        5_000,
        'Timed out waiting for node_left watch event',
      )
    } finally {
      stopWatching()
    }
  }, 20_000)

  it('coordinates leases against real etcd', async () => {
    const coordinator = getCoordinator()

    const firstAcquired = await coordinator.acquireLease('controller-lock', 'node-1', 4_000)
    expect(firstAcquired).toBe(true)

    const secondAcquired = await coordinator.acquireLease('controller-lock', 'node-2', 4_000)
    expect(secondAcquired).toBe(false)

    const renewed = await coordinator.renewLease('controller-lock', 'node-1', 4_000)
    expect(renewed).toBe(true)

    const holderBeforeRelease = await coordinator.getLeaseHolder('controller-lock')
    expect(holderBeforeRelease).toBe('node-1')

    await coordinator.releaseLease('controller-lock')

    const holderAfterRelease = await coordinator.getLeaseHolder('controller-lock')
    expect(holderAfterRelease).toBeNull()

    const acquiredAfterRelease = await coordinator.acquireLease('controller-lock', 'node-2', 4_000)
    expect(acquiredAfterRelease).toBe(true)
  }, 20_000)
})
