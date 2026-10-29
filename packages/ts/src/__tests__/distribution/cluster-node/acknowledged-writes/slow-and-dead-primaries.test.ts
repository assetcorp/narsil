import { afterEach, describe, expect, it } from 'vitest'
import type { AllocationTable } from '../../../../distribution/coordinator/types'
import {
  createTestCluster,
  INDEX,
  ofType,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitUntil,
} from './harness'

const ROUTER = 'router'
const DATA_NODES = ['node-a', 'node-b', 'node-c']
const PARTITIONS = [0, 1]
const BATCH = 40
const WELL_INSIDE_WINDOW_MS = 15_000

interface Roles {
  slow: { partitionId: number; primary: string }
  dead: { partitionId: number; primary: string; replica: string }
}

function chooseRoles(table: AllocationTable): Roles | null {
  for (const deadId of PARTITIONS) {
    for (const slowId of PARTITIONS) {
      const dead = partitionAssignment(table, deadId)
      const slow = partitionAssignment(table, slowId)
      const replica = dead?.inSyncSet[0]
      if (deadId === slowId || replica === undefined) continue
      if (dead === undefined || slow === undefined || dead.primary === null || slow.primary === null) continue
      if (dead.primary === slow.primary || replica === slow.primary) continue
      return {
        slow: { partitionId: slowId, primary: slow.primary },
        dead: { partitionId: deadId, primary: dead.primary, replica },
      }
    }
  }
  return null
}

describe('a batch spread over a partition with a slow primary and a partition with a dead one', () => {
  let cluster: TestCluster | undefined

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
  })

  it('stores the dead partition on its new primary while the slow primary still holds its share', async () => {
    cluster = await createTestCluster()
    const started = cluster
    await started.start(ROUTER, { roles: ['controller', 'coordinator'], durable: false })
    for (const nodeId of DATA_NODES) await started.start(nodeId, { durable: false })
    const router = started.node(ROUTER)
    await router.createIndex(INDEX, { schema: SCHEMA }, { partitionCount: PARTITIONS.length, replicationFactor: 1 })
    const roles = await waitUntil('both partitions to settle on distinct primaries', async () => {
      const table = await started.coordinator.getAllocation(INDEX)
      if (table === null) return null
      const settled = PARTITIONS.every(partitionId => {
        const assignment = partitionAssignment(table, partitionId)
        return assignment?.state === 'ACTIVE' && assignment.inSyncSet.length === 1
      })
      return settled ? chooseRoles(table) : null
    })

    const documents = Array.from({ length: BATCH }, (_, i) => ({ id: `doc-${i}`, title: `transfer ${i}`, amount: i }))
    const transport = started.transport(ROUTER)
    const held = transport.holdWhen(ofType('replication.forward_batch', roles.slow.primary))
    transport.dropWhen(ofType('replication.forward_batch', roles.dead.primary))
    let answered = false
    const inserted = router.insertBatch(INDEX, documents).finally(() => {
      answered = true
    })
    await waitUntil('the slow primary to hold its share of the batch', () => held.count() > 0)
    const stoppedAt = Date.now()
    await started.stop(roles.dead.primary)

    let lastSize = -1
    const whileHeld = await waitUntil(
      'the dead partition to reach its new primary',
      async () => {
        const table = await started.coordinator.getAllocation(INDEX)
        if (partitionAssignment(table, roles.dead.partitionId)?.primary !== roles.dead.replica) return null
        const copy = await readCopy(started.probe, roles.dead.replica, roles.dead.partitionId)
        const stable = copy.size > 0 && copy.size === lastSize
        lastSize = copy.size
        return stable ? copy : null
      },
      WELL_INSIDE_WINDOW_MS,
    )
    const landedAfterMs = Date.now() - stoppedAt
    expect(answered).toBe(false)
    held.release()
    const result = await inserted

    expect(result.failed).toEqual([])
    expect(new Set(result.succeeded)).toEqual(new Set(documents.map(document => document.id)))
    const finalDead = await readCopy(started.probe, roles.dead.replica, roles.dead.partitionId)
    const finalSlow = await readCopy(started.probe, roles.slow.primary, roles.slow.partitionId)
    expect([...whileHeld.keys()].sort()).toEqual([...finalDead.keys()].sort())
    expect(Object.fromEntries([...finalDead, ...finalSlow])).toEqual(
      Object.fromEntries(documents.map(({ id, ...fields }) => [id, fields])),
    )
    expect(landedAfterMs).toBeLessThan(WELL_INSIDE_WINDOW_MS)
  }, 90_000)
})
