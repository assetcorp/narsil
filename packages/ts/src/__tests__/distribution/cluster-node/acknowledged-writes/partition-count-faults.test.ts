import { setTimeout as sleep } from 'node:timers/promises'
import { decode } from '@msgpack/msgpack'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClusterNode, ClusterNodeConfig } from '../../../../distribution/cluster-node/types'
import { NarsilError } from '../../../../errors'
import { createTestCluster, INDEX, readCopy, SCHEMA, type TestCluster, waitUntil } from './harness'

const NODE_IDS = ['ledger-a', 'ledger-b', 'ledger-c']
const SOURCE_PARTITIONS = 3
const TARGET_PARTITIONS = 5
const SEEDED_ENTRIES = 300
const WRITES_WHILE_HELD = 150
const WRITE_BUDGET = 6_000
const WRITE_PAUSE_MS = 2
const SEARCH_PAUSE_MS = 50
const SEARCH_LIMIT = 10_000
const RECORD_KEY = `_narsil/index/${INDEX}/rebalance`
const FORWARD = 'cluster.reshard_forward'
const CUTOVER = 'cluster.reshard_cutover'
const PURGE = 'cluster.reshard_purge'
const SEARCH = 'query.search'
const REFUSED_BEFORE_THE_WRITE = new Set(['PARTITION_REBALANCING_BACKPRESSURE', 'PARTITION_NOT_PRIMARY'])

interface Ledger {
  acknowledged: string[]
  refused: Set<string>
  unanswered: Set<string>
  failedSearches: string[]
  stop: boolean
}

function entryTitle(id: string): string {
  return `ledger entry ${id} with sedge`
}

function newLedger(): Ledger {
  return { acknowledged: [], refused: new Set(), unanswered: new Set(), failedSearches: [], stop: false }
}

async function writeUntilStopped(node: ClusterNode, ledger: Ledger): Promise<void> {
  let sequence = 0
  while (!ledger.stop) {
    await sleep(WRITE_PAUSE_MS)
    if (sequence >= WRITE_BUDGET) continue
    const id = `entry-${sequence}`
    sequence += 1
    try {
      await node.insert(INDEX, { title: entryTitle(id), amount: sequence }, id)
      ledger.acknowledged.push(id)
    } catch (error) {
      if (error instanceof NarsilError && REFUSED_BEFORE_THE_WRITE.has(error.code)) ledger.refused.add(id)
      else ledger.unanswered.add(id)
      await sleep(5)
    }
  }
}

async function searchUntilStopped(node: ClusterNode, ledger: Ledger): Promise<void> {
  while (!ledger.stop) {
    await new Promise(resolve => setImmediate(resolve))
    const expected = ledger.acknowledged.slice()
    try {
      const found = new Set((await node.query(INDEX, { term: 'sedge', limit: SEARCH_LIMIT })).hits.map(hit => hit.id))
      const missing = expected.filter(id => !found.has(id))
      if (missing.length > 0) ledger.failedSearches.push(`missed ${missing.length}, first ${missing[0]}`)
    } catch (error) {
      ledger.failedSearches.push(error instanceof Error ? error.message : String(error))
    }
    await sleep(SEARCH_PAUSE_MS)
  }
}

async function recordPhase(cluster: TestCluster): Promise<string | null> {
  const bytes = await cluster.coordinator.get(RECORD_KEY)
  if (bytes === null || bytes.byteLength === 0) return null
  const record = decode(bytes) as { phase?: unknown }
  return typeof record.phase === 'string' ? record.phase : null
}

async function controllerId(cluster: TestCluster): Promise<string> {
  return waitUntil('a controller', () => cluster.coordinator.getLeaseHolder('_narsil/controller'))
}

async function expectLedgerKept(cluster: TestCluster, router: ClusterNode, ledger: Ledger): Promise<void> {
  const generation = await waitUntil('the index to serve from a new layout', async () => {
    const served = (await cluster.coordinator.getAllocation(INDEX))?.generation
    if (served === undefined) return null
    const table = await cluster.coordinator.getAllocation(served)
    if (table?.assignments.size !== TARGET_PARTITIONS) return null
    const settled = [...table.assignments.values()].every(
      assignment => assignment.state === 'ACTIVE' && assignment.replicas.every(id => assignment.inSyncSet.includes(id)),
    )
    return settled ? served : null
  })

  const written = [...ledger.acknowledged, ...ledger.refused, ...ledger.unanswered]
  const stored = await router.getMultiple(INDEX, written)
  expect(ledger.acknowledged.filter(id => !stored.has(id))).toEqual([])
  expect([...ledger.refused].filter(id => stored.has(id))).toEqual([])
  for (const [id, document] of stored) expect(document.title).toBe(entryTitle(id))
  expect(await router.countDocuments(INDEX)).toBe(stored.size)
  const found = (await router.query(INDEX, { term: 'sedge', limit: SEARCH_LIMIT })).hits.map(hit => hit.id)
  expect(found.sort()).toEqual([...stored.keys()].sort())

  await waitUntil('every copy of the new layout to hold the same entries', async () => {
    const table = await cluster.coordinator.getAllocation(generation)
    const held = new Set<string>()
    for (const [partitionId, assignment] of table?.assignments ?? []) {
      const copies: string[][] = []
      for (const holder of new Set([assignment.primary, ...assignment.replicas])) {
        if (holder === null) return false
        const copy = await readCopy(cluster.probe, holder, partitionId, generation)
        copies.push([...copy.keys()].sort())
      }
      if (copies.some(copy => copy.join() !== copies[0]?.join())) return false
      for (const id of copies[0] ?? []) held.add(id)
    }
    return held.size === stored.size && [...stored.keys()].every(id => held.has(id))
  })
}

describe('changing the partition count while nodes fail', () => {
  let cluster: TestCluster

  async function seededCluster(config: Partial<ClusterNodeConfig> = {}): Promise<void> {
    for (const nodeId of NODE_IDS) {
      await cluster.start(nodeId, {
        durable: false,
        roles: ['data', 'coordinator', 'controller'],
        controller: { nodeLeftDelayMs: 0 },
        ...config,
      })
    }
    const first = cluster.node(NODE_IDS[0] ?? '')
    await first.createIndex(INDEX, { schema: SCHEMA }, { partitionCount: SOURCE_PARTITIONS, replicationFactor: 1 })
    const entries = Array.from({ length: SEEDED_ENTRIES }, (_, at) => ({
      id: `seed-${at}`,
      title: entryTitle(`seed-${at}`),
      amount: at,
    }))
    expect((await first.insertBatch(INDEX, entries)).failed).toEqual([])
    await waitUntil('every partition to hold an in-sync replica', async () => {
      const table = await cluster.coordinator.getAllocation(INDEX)
      const assignments = [...(table?.assignments.values() ?? [])]
      return (
        assignments.length === SOURCE_PARTITIONS &&
        assignments.every(assignment => assignment.state === 'ACTIVE' && assignment.inSyncSet.length > 0)
      )
    })
  }

  async function routerBesides(...excluded: string[]): Promise<ClusterNode> {
    const nodeId = NODE_IDS.find(id => !excluded.includes(id) && cluster.nodes.has(id))
    if (nodeId === undefined) throw new Error('no node is left to route through')
    return cluster.node(nodeId)
  }

  function holdOnEveryNode(type: string) {
    const holds = new Map(
      [...cluster.transports].map(([nodeId, transport]) => [nodeId, transport.holdWhen((_to, m) => m.type === type)]),
    )
    return {
      count: () => [...holds.values()].reduce((total, hold) => total + hold.count(), 0),
      releaseOn: (nodeId: string) => holds.get(nodeId)?.release(),
      release: () => {
        for (const hold of holds.values()) hold.release()
      },
    }
  }

  async function stopHolding(nodeId: string, holds: { releaseOn: (nodeId: string) => void }): Promise<void> {
    holds.releaseOn(nodeId)
    await cluster.stop(nodeId)
  }

  async function runWhileWriting(router: ClusterNode, ledger: Ledger, change: () => Promise<void>): Promise<void> {
    const writing = writeUntilStopped(router, ledger)
    const searching = searchUntilStopped(router, ledger)
    try {
      await change()
    } finally {
      ledger.stop = true
      await Promise.all([writing, searching])
    }
  }

  beforeEach(async () => {
    cluster = await createTestCluster()
  })

  afterEach(async () => {
    await cluster.dispose()
  })

  it('keeps every acknowledged write when the controller fails while the copy runs', async () => {
    await seededCluster()
    const controller = await controllerId(cluster)
    const router = await routerBesides(controller)
    const ledger = newLedger()
    for (let at = 0; at < SEEDED_ENTRIES; at++) ledger.acknowledged.push(`seed-${at}`)
    const forwards = holdOnEveryNode(FORWARD)

    await runWhileWriting(router, ledger, async () => {
      const changing = router.rebalance(INDEX, TARGET_PARTITIONS)
      await waitUntil(
        'the copy to start',
        async () => (await recordPhase(cluster)) === 'copying' && forwards.count() > 0,
      )
      await stopHolding(controller, forwards)
      forwards.release()
      await changing
    })

    expect(ledger.failedSearches).toEqual([])
    await expectLedgerKept(cluster, router, ledger)
  }, 60_000)

  it('keeps every acknowledged write when the controller fails during the cutover', async () => {
    await seededCluster()
    const controller = await controllerId(cluster)
    const router = await routerBesides(controller)
    const ledger = newLedger()
    for (let at = 0; at < SEEDED_ENTRIES; at++) ledger.acknowledged.push(`seed-${at}`)
    const cutovers = cluster.transport(controller).holdWhen((_to, m) => m.type === CUTOVER)

    await runWhileWriting(router, ledger, async () => {
      const changing = router.rebalance(INDEX, TARGET_PARTITIONS)
      await waitUntil(
        'the cutover to start',
        async () => (await recordPhase(cluster)) === 'cutover' && cutovers.count() > 0,
      )
      cutovers.release()
      await cluster.stop(controller)
      await changing
    })

    expect(ledger.failedSearches).toEqual([])
    await expectLedgerKept(cluster, router, ledger)
  }, 60_000)

  it('keeps every acknowledged write when a source primary fails while the copy runs', async () => {
    await seededCluster()
    const controller = await controllerId(cluster)
    const table = await cluster.coordinator.getAllocation(INDEX)
    const routerId = NODE_IDS.find(id => id !== controller) ?? ''
    const failing = [...(table?.assignments.values() ?? [])]
      .map(assignment => assignment.primary)
      .find(primary => primary !== null && primary !== controller && primary !== routerId)
    if (failing === undefined || failing === null) throw new Error('no source primary is free to fail')
    const router = cluster.node(routerId)
    const ledger = newLedger()
    for (let at = 0; at < SEEDED_ENTRIES; at++) ledger.acknowledged.push(`seed-${at}`)
    const forwards = cluster.transport(failing).holdWhen((_to, m) => m.type === FORWARD)

    await runWhileWriting(router, ledger, async () => {
      const changing = router.rebalance(INDEX, TARGET_PARTITIONS)
      await waitUntil('the failing primary to start its copy', () => forwards.count() > 0)
      forwards.release()
      await cluster.stop(failing)
      await changing
    })

    expect(ledger.failedSearches).toEqual([])
    await expectLedgerKept(cluster, router, ledger)
  }, 60_000)

  it('answers from the new layout when the old layout goes while a search waits on it', async () => {
    await seededCluster()
    const router = cluster.node(NODE_IDS[0] ?? '')
    const seeded = Array.from({ length: SEEDED_ENTRIES }, (_, at) => `seed-${at}`).sort()
    const source = await cluster.coordinator.getAllocation(INDEX)
    const searches = cluster
      .transport(router.nodeId)
      .holdWhen((_to, m) => m.type === SEARCH && (decode(m.payload) as { indexName?: unknown }).indexName === INDEX)

    const searching = router.query(INDEX, { term: 'sedge', limit: SEARCH_LIMIT })
    await waitUntil('the search to reach its copies', () => searches.count() > 0)
    await router.rebalance(INDEX, TARGET_PARTITIONS)
    await waitUntil('every copy of the old layout to go', async () => {
      for (const [partitionId, assignment] of source?.assignments ?? []) {
        for (const holder of new Set([assignment.primary, ...assignment.replicas])) {
          if (holder === null) continue
          const held = await readCopy(cluster.probe, holder, partitionId).catch(() => new Map())
          if (held.size > 0) return false
        }
      }
      return true
    })
    searches.release()

    const answer = await searching
    expect(answer.hits.map(hit => hit.id).sort()).toEqual(seeded)
    expect(answer.coverage.failedPartitions + answer.coverage.timedOutPartitions).toBe(0)
    expect(answer.coverage.queriedPartitions).toBe(TARGET_PARTITIONS)
  }, 60_000)

  it('copies again from a fresh snapshot when the source log drops entries that the copy still needs', async () => {
    await seededCluster({ replication: { logRetentionBytes: 2_048 } })
    const controller = await controllerId(cluster)
    const router = await routerBesides(controller)
    const ledger = newLedger()
    for (let at = 0; at < SEEDED_ENTRIES; at++) ledger.acknowledged.push(`seed-${at}`)
    let purges = 0
    for (const transport of cluster.transports.values()) {
      transport.holdWhen((_to, m) => {
        if (m.type === PURGE) purges += 1
        return false
      })
    }
    const forwards = holdOnEveryNode(FORWARD)

    await runWhileWriting(router, ledger, async () => {
      const changing = router.rebalance(INDEX, TARGET_PARTITIONS)
      await waitUntil('the copy to fall behind the source log', () => {
        return forwards.count() > 0 && ledger.acknowledged.length >= SEEDED_ENTRIES + WRITES_WHILE_HELD
      })
      forwards.release()
      await changing
    })

    expect(purges).toBeGreaterThan(SOURCE_PARTITIONS)
    expect(ledger.failedSearches).toEqual([])
    await expectLedgerKept(cluster, router, ledger)
  }, 60_000)

  it('drops an index while its partition count changes, and leaves nothing behind when the controller then fails', async () => {
    await seededCluster()
    const controller = await controllerId(cluster)
    const router = await routerBesides(controller)
    const forwards = holdOnEveryNode(FORWARD)

    const changing = router.rebalance(INDEX, TARGET_PARTITIONS).then(
      () => null,
      (error: unknown) => error,
    )
    await waitUntil('the copy to start', async () => (await recordPhase(cluster)) === 'copying' && forwards.count() > 0)
    await router.dropIndex(INDEX)
    await stopHolding(controller, forwards)
    forwards.release()

    expect(await changing).toMatchObject({ code: 'ALLOCATION_FAILED' })
    await waitUntil('every trace of the index to go', async () => {
      const schemas = await cluster.coordinator.listSchemas()
      const allocation = await cluster.coordinator.getAllocation(INDEX)
      return schemas.length === 0 && allocation === null && (await recordPhase(cluster)) === null
    })
    await router.createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 2, replicationFactor: 1 })
    await router.insert(INDEX, { title: entryTitle('fresh'), amount: 1 }, 'fresh')
    expect(await router.countDocuments(INDEX)).toBe(1)
    expect([...(await router.getMultiple(INDEX, ['seed-0', 'fresh'])).keys()]).toEqual(['fresh'])
  }, 60_000)
})
