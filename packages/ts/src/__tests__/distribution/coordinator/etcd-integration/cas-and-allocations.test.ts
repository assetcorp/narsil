import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AllocationEvent, ClusterCoordinator, SchemaEvent } from '../../../../distribution/coordinator'
import { createEtcdCoordinator } from '../../../../distribution/coordinator'
import {
  type EtcdContainerHandle,
  eventually,
  MANAGED_ETCD_ENDPOINT,
  makeAllocationTable,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  testSchema,
  waitForEtcdReady,
} from './fixtures'

describe('EtcdCoordinator integration - CAS and allocations', () => {
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

  it('executes compare-and-set transactions against real etcd', async () => {
    const coordinator = getCoordinator()
    const original = new Uint8Array([1, 2, 3])
    const updated = new Uint8Array([4, 5, 6])

    const created = await coordinator.compareAndSet('cas-key', null, original)
    expect(created).toBe(true)

    const staleCreate = await coordinator.compareAndSet('cas-key', null, updated)
    expect(staleCreate).toBe(false)

    const wrongExpected = await coordinator.compareAndSet('cas-key', new Uint8Array([9, 9, 9]), updated)
    expect(wrongExpected).toBe(false)

    const updatedResult = await coordinator.compareAndSet('cas-key', original, updated)
    expect(updatedResult).toBe(true)

    const stored = await coordinator.get('cas-key')
    expect(Array.from(stored ?? [])).toEqual(Array.from(updated))
  }, 20_000)

  it('round-trips allocations, partition states, schemas, and watch events against real etcd', async () => {
    const coordinator = getCoordinator()
    const allocationEvents: AllocationEvent[] = []
    const schemaEvents: SchemaEvent[] = []
    const stopAllocationWatch = await coordinator.watchAllocation(event => allocationEvents.push(event))
    const stopSchemaWatch = await coordinator.watchSchemas(event => schemaEvents.push(event))

    try {
      const initialTable = makeAllocationTable('products')
      const created = await coordinator.putAllocation('products', initialTable, null)
      expect(created).toBe(true)

      await eventually(
        async () => {
          expect(allocationEvents).toHaveLength(1)
          expect(allocationEvents[0]?.indexName).toBe('products')
          expect(allocationEvents[0]?.table.version).toBe(1)
        },
        5_000,
        'Timed out waiting for allocation watch event',
      )

      const updatedTable = makeAllocationTable('products')
      updatedTable.version = 2

      const staleUpdate = await coordinator.putAllocation('products', updatedTable, 99)
      expect(staleUpdate).toBe(false)

      const versionedUpdate = await coordinator.putAllocation('products', updatedTable, 1)
      expect(versionedUpdate).toBe(true)

      await eventually(
        async () => {
          expect(allocationEvents).toHaveLength(2)
          expect(allocationEvents[1]?.table.version).toBe(2)
        },
        5_000,
        'Timed out waiting for versioned allocation watch event',
      )

      const allocation = await coordinator.getAllocation('products')
      expect(allocation?.version).toBe(2)
      expect(allocation?.assignments.get(0)?.primary).toBe('node-1')

      await coordinator.putPartitionState('products', 0, 'ACTIVE')
      expect(await coordinator.getPartitionState('products', 0)).toBe('ACTIVE')

      await coordinator.putSchema('products', testSchema)

      await eventually(
        async () => {
          expect(schemaEvents).toHaveLength(1)
          expect(schemaEvents[0]?.type).toBe('schema_created')
          expect(schemaEvents[0]?.indexName).toBe('products')
          expect(schemaEvents[0]?.schema).toEqual(testSchema)
        },
        5_000,
        'Timed out waiting for schema watch event',
      )

      expect(await coordinator.getSchema('products')).toEqual(testSchema)
    } finally {
      stopAllocationWatch()
      stopSchemaWatch()
    }
  }, 20_000)
})
