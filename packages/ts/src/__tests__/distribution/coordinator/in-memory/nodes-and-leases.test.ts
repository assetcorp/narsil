import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClusterCoordinator, NodeEvent } from '../../../../distribution/coordinator'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import { makeNodeRegistration } from './fixtures'

describe('InMemoryCoordinator', () => {
  let coordinator: ClusterCoordinator

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
  })

  afterEach(async () => {
    await coordinator.shutdown()
  })

  describe('node registration', () => {
    it('registers a node and lists it', async () => {
      const reg = makeNodeRegistration()
      await coordinator.registerNode(reg)

      const listed = await coordinator.listNodes()
      expect(listed).toHaveLength(1)
      expect(listed[0].nodeId).toBe('node-1')
      expect(listed[0].address).toBe('127.0.0.1:9200')
    })

    it('registers multiple nodes', async () => {
      await coordinator.registerNode(makeNodeRegistration({ nodeId: 'node-1' }))
      await coordinator.registerNode(makeNodeRegistration({ nodeId: 'node-2', address: '127.0.0.1:9201' }))

      const listed = await coordinator.listNodes()
      expect(listed).toHaveLength(2)
      const ids = listed.map(n => n.nodeId).sort()
      expect(ids).toEqual(['node-1', 'node-2'])
    })

    it('re-registers a node with the same nodeId (updates registration)', async () => {
      await coordinator.registerNode(makeNodeRegistration({ nodeId: 'node-1', address: '127.0.0.1:9200' }))
      await coordinator.registerNode(makeNodeRegistration({ nodeId: 'node-1', address: '127.0.0.1:9999' }))

      const listed = await coordinator.listNodes()
      expect(listed).toHaveLength(1)
      expect(listed[0].address).toBe('127.0.0.1:9999')
    })

    it('deregisters a node and removes it from the list', async () => {
      await coordinator.registerNode(makeNodeRegistration())
      await coordinator.deregisterNode('node-1')

      const listed = await coordinator.listNodes()
      expect(listed).toHaveLength(0)
    })

    it('deregistering a non-existent node does not throw', async () => {
      await expect(coordinator.deregisterNode('non-existent')).resolves.toBeUndefined()
    })
  })

  describe('node watchers', () => {
    it('fires node_joined on registration', async () => {
      const events: NodeEvent[] = []
      await coordinator.watchNodes(event => events.push(event))

      const reg = makeNodeRegistration()
      await coordinator.registerNode(reg)

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('node_joined')
      expect(events[0].nodeId).toBe('node-1')
      expect(events[0].registration).toEqual(reg)
    })

    it('fires node_left on deregistration', async () => {
      await coordinator.registerNode(makeNodeRegistration())

      const events: NodeEvent[] = []
      await coordinator.watchNodes(event => events.push(event))

      await coordinator.deregisterNode('node-1')

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('node_left')
      expect(events[0].nodeId).toBe('node-1')
      expect(events[0].registration).toBeNull()
    })

    it('does not fire node_left when deregistering a non-existent node', async () => {
      const events: NodeEvent[] = []
      await coordinator.watchNodes(event => events.push(event))

      await coordinator.deregisterNode('ghost-node')

      expect(events).toHaveLength(0)
    })
  })

  describe('leases', () => {
    it('acquires a lease when no one holds it', async () => {
      const acquired = await coordinator.acquireLease('test-key', 'node-1', 10_000)
      expect(acquired).toBe(true)
    })

    it('fails to acquire a lease held by another node', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      const acquired = await coordinator.acquireLease('test-key', 'node-2', 10_000)
      expect(acquired).toBe(false)
    })

    it('allows the same node to re-acquire its own lease', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      const acquired = await coordinator.acquireLease('test-key', 'node-1', 10_000)
      expect(acquired).toBe(true)
    })

    it('renews a lease for the holder', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      const renewed = await coordinator.renewLease('test-key', 'node-1', 10_000)
      expect(renewed).toBe(true)
    })

    it('fails to renew a lease for a non-holder', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      const renewed = await coordinator.renewLease('test-key', 'node-2', 10_000)
      expect(renewed).toBe(false)
    })

    it('fails to renew a lease that does not exist', async () => {
      const renewed = await coordinator.renewLease('no-such-key', 'node-1', 10_000)
      expect(renewed).toBe(false)
    })

    it('releases a lease and allows re-acquisition', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      await coordinator.releaseLease('test-key')

      const acquired = await coordinator.acquireLease('test-key', 'node-2', 10_000)
      expect(acquired).toBe(true)
    })

    it('releasing a non-existent lease does not throw', async () => {
      await expect(coordinator.releaseLease('no-such-key')).resolves.toBeUndefined()
    })

    it('getLeaseHolder returns the holder nodeId', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      const holder = await coordinator.getLeaseHolder('test-key')
      expect(holder).toBe('node-1')
    })

    it('getLeaseHolder returns null when no lease exists', async () => {
      const holder = await coordinator.getLeaseHolder('test-key')
      expect(holder).toBeNull()
    })

    it('getLeaseHolder returns null after lease is released', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 10_000)
      await coordinator.releaseLease('test-key')
      const holder = await coordinator.getLeaseHolder('test-key')
      expect(holder).toBeNull()
    })
  })

  describe('lease expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('expires a lease after the TTL and allows re-acquisition', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 5_000)

      vi.advanceTimersByTime(5_001)

      const acquired = await coordinator.acquireLease('test-key', 'node-2', 10_000)
      expect(acquired).toBe(true)
    })

    it('fires node_left when a node heartbeat lease expires', async () => {
      const events: NodeEvent[] = []
      await coordinator.watchNodes(event => events.push(event))

      await coordinator.registerNode(makeNodeRegistration({ nodeId: 'node-expiring' }))
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe('node_joined')

      vi.advanceTimersByTime(30_001)

      expect(events).toHaveLength(2)
      expect(events[1].type).toBe('node_left')
      expect(events[1].nodeId).toBe('node-expiring')
      expect(events[1].registration).toBeNull()

      const listed = await coordinator.listNodes()
      expect(listed).toHaveLength(0)
    })

    it('renewing a lease prevents expiry', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 5_000)

      vi.advanceTimersByTime(3_000)
      await coordinator.renewLease('test-key', 'node-1', 5_000)

      vi.advanceTimersByTime(3_000)
      const holder = await coordinator.getLeaseHolder('test-key')
      expect(holder).toBe('node-1')
    })

    it('fails to renew an expired lease', async () => {
      await coordinator.acquireLease('test-key', 'node-1', 5_000)

      vi.advanceTimersByTime(5_001)

      const renewed = await coordinator.renewLease('test-key', 'node-1', 5_000)
      expect(renewed).toBe(false)
    })
  })
})
