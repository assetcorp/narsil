import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AllocationTable, ClusterCoordinator } from '../../../../distribution/coordinator'
import { createInMemoryCoordinator } from '../../../../distribution/coordinator'
import { makeAllocationTable } from './fixtures'

const CONTROLLER_LEASE = '_narsil/controller'
const INDEX = 'orchards'
const SHORT_LEASE_MS = 40

function nextVersionOf(table: AllocationTable): AllocationTable {
  return { ...table, version: table.version + 1 }
}

describe('an allocation write from a node that lost the controller lease', () => {
  let coordinator: ClusterCoordinator

  beforeEach(() => {
    coordinator = createInMemoryCoordinator()
  })

  afterEach(async () => {
    await coordinator.shutdown()
  })

  it('refuses the old controller once its lease expires and another node takes it', async () => {
    expect(await coordinator.acquireLease(CONTROLLER_LEASE, 'controller-a', SHORT_LEASE_MS)).toBe(true)
    const first = makeAllocationTable(INDEX)
    expect(await coordinator.putAllocation(INDEX, first, null, 'controller-a')).toBe(true)

    await sleep(SHORT_LEASE_MS * 2)
    expect(await coordinator.acquireLease(CONTROLLER_LEASE, 'controller-b', 30_000)).toBe(true)

    expect(await coordinator.putAllocation(INDEX, nextVersionOf(first), first.version, 'controller-a')).toBe(false)
    expect((await coordinator.getAllocation(INDEX))?.version).toBe(1)

    expect(await coordinator.putAllocation(INDEX, nextVersionOf(first), first.version, 'controller-b')).toBe(true)
    expect((await coordinator.getAllocation(INDEX))?.version).toBe(2)
  })

  it('refuses a writer whose lease expired while no other node holds it', async () => {
    expect(await coordinator.acquireLease(CONTROLLER_LEASE, 'controller-a', SHORT_LEASE_MS)).toBe(true)
    const first = makeAllocationTable(INDEX)
    expect(await coordinator.putAllocation(INDEX, first, null, 'controller-a')).toBe(true)

    await sleep(SHORT_LEASE_MS * 2)

    expect(await coordinator.putAllocation(INDEX, nextVersionOf(first), first.version, 'controller-a')).toBe(false)
    expect((await coordinator.getAllocation(INDEX))?.version).toBe(1)
  })

  it('refuses a first table from a node that never held the lease', async () => {
    expect(await coordinator.acquireLease(CONTROLLER_LEASE, 'controller-a', 30_000)).toBe(true)

    expect(await coordinator.putAllocation(INDEX, makeAllocationTable(INDEX), null, 'intruder')).toBe(false)
    expect(await coordinator.putAllocation(INDEX, makeAllocationTable(INDEX), null, '')).toBe(false)
    expect(await coordinator.getAllocation(INDEX)).toBeNull()
  })

  it('refuses the holder of a different lease', async () => {
    expect(await coordinator.acquireLease('_narsil/elsewhere', 'controller-a', 30_000)).toBe(true)

    expect(await coordinator.putAllocation(INDEX, makeAllocationTable(INDEX), null, 'controller-a')).toBe(false)
    expect(await coordinator.getAllocation(INDEX)).toBeNull()
  })
})
