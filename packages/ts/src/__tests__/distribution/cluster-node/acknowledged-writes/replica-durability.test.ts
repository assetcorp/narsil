import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil } from '../../../../index'
import {
  createTestCluster,
  INDEX,
  partitionAssignment,
  SCHEMA,
  type TestCluster,
  waitForCopies,
  waitUntil,
} from './harness'

const ACKNOWLEDGED_WRITES = 40

describe('a replica keeps every entry it acknowledged on its own disk', () => {
  let cluster: TestCluster
  const copies: string[] = []

  afterEach(async () => {
    await cluster.dispose()
    for (const directory of copies.splice(0)) await rm(directory, { recursive: true, force: true })
  })

  it('holds every acknowledged write on disk at the moment the power fails', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start('node-a')
    await cluster.start('node-b')
    await cluster.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    const table = await waitUntil('both data nodes to hold the partition in sync', async () => {
      const current = await cluster.coordinator.getAllocation(INDEX)
      const assignment = partitionAssignment(current)
      return assignment?.state === 'ACTIVE' && assignment.inSyncSet.length === 1 ? current : null
    })
    const primary = partitionAssignment(table)?.primary ?? ''
    const replica = partitionAssignment(table)?.inSyncSet[0] ?? ''

    const acknowledged = new Map<string, { title: string; amount: number }>()
    for (let i = 0; i < ACKNOWLEDGED_WRITES; i++) {
      const account = { title: `payment ${i}`, amount: i * 3 }
      await cluster.node(primary).insert(INDEX, account, `payment-${i}`)
      acknowledged.set(`payment-${i}`, account)
    }
    await cluster.node(primary).remove(INDEX, 'payment-7')
    acknowledged.delete('payment-7')
    await waitForCopies(cluster.coordinator, primary, [replica])

    const replicaDirectory = cluster.directories.get(replica) ?? ''
    const diskAtPowerCut = await mkdtemp(join(tmpdir(), 'narsil-replica-disk-'))
    copies.push(diskAtPowerCut)
    await cp(replicaDirectory, diskAtPowerCut, { recursive: true, filter: source => !source.endsWith('.narsil.lock') })

    const recovered = await createNarsil({ workers: { enabled: false }, durability: { directory: diskAtPowerCut } })
    try {
      const found = new Map<string, unknown>()
      for (const id of [...acknowledged.keys(), 'payment-7']) {
        const document = await recovered.get(INDEX, id)
        if (document !== undefined) found.set(id, document)
      }
      expect([...found.keys()].sort()).toEqual([...acknowledged.keys()].sort())
      for (const [id, account] of acknowledged) expect(found.get(id)).toMatchObject(account)
    } finally {
      await recovered.shutdown()
    }
  })
})
