import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CAPACITY } from '../../../../distribution'
import {
  createTestCluster,
  entryForDocument,
  INDEX,
  ofType,
  outcomeOf,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitUntil,
} from './harness'

const SETTLED_WRITES = 5
const LARGE_NODE_MEMORY_MULTIPLE = 40
const REJOIN_TIMEOUT_MS = 30_000
const WRITES_AFTER_HANDOVER = 3
const TABLE_EVENT_DELAY_MS = 2_000

describe('a primary that loses its role with a write in flight takes the new history', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  async function handOverWithStrandedWrite(strandedAt: 'the replicas' | 'the old primary'): Promise<{
    oldPrimary: string
    newPrimary: string
    expected: Map<string, Record<string, unknown>>
  }> {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    for (const nodeId of ['node-a', 'node-b', 'node-c']) await cluster.start(nodeId, { durable: false })
    await cluster.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 2 })
    const settled = await waitUntil('every data node to hold the partition in sync', async () => {
      const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return current?.state === 'ACTIVE' && current.inSyncSet.length === 2 ? current : null
    })
    const oldPrimary = settled.primary ?? ''

    const expected = new Map<string, Record<string, unknown>>()
    for (let i = 0; i < SETTLED_WRITES; i++) {
      await cluster.node(oldPrimary).insert(INDEX, { title: `settled ${i}`, amount: i }, `settled-${i}`)
      expected.set(`settled-${i}`, { title: `settled ${i}`, amount: i })
    }

    const transport = cluster.transport(oldPrimary)
    if (strandedAt === 'the replicas') transport.loseReplyWhen(entryForDocument('stranded'))
    const inFlight =
      strandedAt === 'the replicas'
        ? transport.holdWhen(ofType('replication.insync_remove'))
        : transport.holdWhen(entryForDocument('stranded'))
    const stranded = outcomeOf(
      cluster.node(oldPrimary).insert(INDEX, { title: 'stranded transfer', amount: 999 }, 'stranded'),
    )
    await waitUntil(`the stranded write to wait on ${strandedAt}`, () => inFlight.count() > 0)

    await cluster.start('node-d', {
      durable: false,
      capacity: { ...DEFAULT_CAPACITY, memoryBytes: DEFAULT_CAPACITY.memoryBytes * LARGE_NODE_MEMORY_MULTIPLE },
    })
    const handedOver = await waitUntil('the controller to hand leadership to an in-sync replica', async () => {
      const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
      return current !== undefined && current.primary !== oldPrimary && current.primaryTerm > settled.primaryTerm
        ? current
        : null
    })

    inFlight.release()
    expect(await stranded).toEqual({ state: 'acknowledged' })
    expected.set('stranded', { title: 'stranded transfer', amount: 999 })
    return { oldPrimary, newPrimary: handedOver.primary ?? '', expected }
  }

  async function expectEveryInSyncCopyHolds(
    oldPrimary: string,
    expected: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    const healed = await waitUntil(
      'the old primary to be in sync again',
      async () => {
        const current = partitionAssignment(await cluster.coordinator.getAllocation(INDEX))
        if (current?.state !== 'ACTIVE' || !current.inSyncSet.includes(oldPrimary)) return null
        const copy = await readCopy(cluster.probe, oldPrimary)
        return copy.size >= SETTLED_WRITES ? current : null
      },
      REJOIN_TIMEOUT_MS,
    )

    for (const holder of [healed.primary ?? '', ...healed.inSyncSet]) {
      expect(Object.fromEntries(await readCopy(cluster.probe, holder)), holder).toEqual(Object.fromEntries(expected))
    }
  }

  it('copies the write that the new primary acknowledged at the position of its own discarded entry', async () => {
    const { oldPrimary, newPrimary, expected } = await handOverWithStrandedWrite('the old primary')

    await cluster.node(newPrimary).insert(INDEX, { title: 'transfer after handover', amount: 42 }, 'after-handover')
    expected.set('after-handover', { title: 'transfer after handover', amount: 42 })

    await expectEveryInSyncCopyHolds(oldPrimary, expected)
  }, 60_000)

  it('resyncs the old primary that refuses one entry of the new term and is sent the next', async () => {
    const { oldPrimary, newPrimary, expected } = await handOverWithStrandedWrite('the replicas')

    const after = Array.from({ length: WRITES_AFTER_HANDOVER }, (_, i) => ({
      id: `after-handover-${i}`,
      fields: { title: `transfer after handover ${i}`, amount: 100 + i },
    }))
    const viewsCatchUp = cluster.coordinator.delayAllocationEvents(TABLE_EVENT_DELAY_MS)
    for (const write of after) {
      await cluster.node(newPrimary).insert(INDEX, write.fields, write.id)
      expected.set(write.id, write.fields)
    }
    viewsCatchUp()

    await expectEveryInSyncCopyHolds(oldPrimary, expected)
  }, 60_000)
})
