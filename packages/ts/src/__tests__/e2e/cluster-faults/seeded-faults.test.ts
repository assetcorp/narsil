import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ClusterUnderTest, startClusterUnderTest } from './cluster-under-test'
import { createLedger } from './oracle'
import { type FaultState, SEARCH_TERM, send, startWorkload } from './workload'

const SEED = Number(process.env.NARSIL_FAULT_SEED ?? Math.floor(Math.random() * 2 ** 31))
const PLAIN = process.env.NARSIL_FAULT_PLAIN === '1'
const NODE_COUNT = 3
const PARTITION_COUNT = 3
const REPLICATION_FACTOR = 1
const FAULT_COUNT = 6
const WRITERS = 4
const SEARCHERS = 2
const INDEX_NAME = 'ledger'
const MIN_HOLD_MS = 3_000
const MAX_HOLD_MS = 14_000
const ETCD_OUTAGE_MEMBERS = [1, 2]
const FAULT_KINDS = ['kill', 'pause', 'isolate', 'etcd-restart', 'etcd-outage'] as const

type FaultKind = (typeof FAULT_KINDS)[number]

const WORKLOAD_STREAM_SALT = 0x5bd1e995

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

describe('a three-node cluster on three etcd members under seeded faults', () => {
  const random = seededRandom(SEED)
  const workloadRandom = seededRandom(SEED ^ WORKLOAD_STREAM_SALT)
  let cluster: ClusterUnderTest | null = null

  beforeAll(async () => {
    console.log(`NARSIL_FAULT_SEED=${SEED}${PLAIN ? ' NARSIL_FAULT_PLAIN=1' : ''}`)
    cluster = await startClusterUnderTest(NODE_COUNT, PLAIN, {
      partitionCount: PARTITION_COUNT,
      replicationFactor: REPLICATION_FACTOR,
      heartbeatTtlSeconds: 10,
      controllerLeaseTtlMs: 5_000,
      standbyRetryMs: 1_000,
      waitForServingMs: 30_000,
    })
  }, 240_000)

  afterAll(async () => {
    await cluster?.close()
  }, 120_000)

  function untilHealed(reason: string): Promise<void> {
    if (cluster === null) throw new Error('The cluster never started')
    return cluster.untilHealed(INDEX_NAME, PARTITION_COUNT, REPLICATION_FACTOR, reason)
  }

  async function injectFault(kind: FaultKind, slot: number, holdMs: number, faults: FaultState): Promise<void> {
    if (cluster === null) return
    const { fleet, etcd } = cluster
    if (kind === 'kill' || kind === 'pause' || kind === 'isolate') {
      faults.unavailable.add(slot)
      faults.startedOn[slot] = (faults.startedOn[slot] ?? 0) + 1
    }
    try {
      if (kind === 'kill') {
        await fleet.kill(slot)
        await sleep(holdMs)
        await fleet.start(slot)
      } else if (kind === 'pause') {
        fleet.pause(slot)
        await sleep(holdMs)
        fleet.resume(slot)
      } else if (kind === 'isolate') {
        fleet.isolate(slot)
        await sleep(holdMs)
        fleet.reconnect(slot)
      } else if (kind === 'etcd-restart') {
        await etcd.restart(slot % etcd.endpoints.length)
      } else {
        for (const member of ETCD_OUTAGE_MEMBERS) await etcd.stop(member)
        await sleep(holdMs)
        for (const member of ETCD_OUTAGE_MEMBERS) await etcd.start(member)
      }
    } finally {
      faults.unavailable.delete(slot)
    }
  }

  it('keeps every acknowledged write, refuses nothing that it applied, and answers every search', async () => {
    if (cluster === null) throw new Error('The cluster never started')
    const { fleet } = cluster
    const first = fleet.nodes[0]?.base ?? ''
    const created = await send(
      first,
      'POST',
      '/indexes',
      { name: INDEX_NAME, config: { schema: { title: 'string', version: 'number' } } },
      60_000,
    )
    expect(created.status, created.text).toBe(201)
    await untilHealed('after the index was created')

    const ledger = createLedger()
    let current = 'no fault'
    const faults: FaultState = { unavailable: new Set(), startedOn: [], describe: () => current }
    const workload = startWorkload({
      fleet,
      ledger,
      faults,
      indexName: INDEX_NAME,
      writers: WRITERS,
      searchers: SEARCHERS,
      random: workloadRandom,
    })
    const plan: string[] = []
    try {
      for (let at = 0; at < FAULT_COUNT; at++) {
        const kind = FAULT_KINDS[Math.floor(random() * FAULT_KINDS.length)] ?? 'kill'
        const slot = Math.floor(random() * NODE_COUNT)
        const holdMs = MIN_HOLD_MS + Math.floor(random() * (MAX_HOLD_MS - MIN_HOLD_MS))
        current = `${kind} on ${kind.startsWith('etcd') ? `etcd member ${slot}` : `slot ${slot}`} for ${holdMs} ms`
        plan.push(current)
        console.log(`fault ${at + 1} of ${FAULT_COUNT}: ${current}`)
        await injectFault(kind, slot, holdMs, faults)
        current = `healing after ${plan[plan.length - 1]}`
        await untilHealed(`after ${plan[plan.length - 1]}`)
        current = 'no fault'
      }
    } finally {
      await workload.stop()
    }
    await untilHealed('once the writers stopped')

    const { stored, unequal } = await cluster.readStored(INDEX_NAME)

    const counts = ledger.counts()
    console.log(
      `seed ${SEED}, faults ${plan.join('; ')}, writes ${JSON.stringify(counts)}, searches ${workload.searches()}`,
    )
    expect(counts.acknowledged).toBeGreaterThan(0)
    expect(unequal).toEqual([])
    expect(ledger.check(stored)).toEqual([])
    expect(workload.searchFailures()).toEqual([])

    for (const node of fleet.nodes) {
      const reply = await send(
        node.base,
        'POST',
        `/indexes/${INDEX_NAME}/search`,
        { term: SEARCH_TERM, limit: 1 },
        30_000,
      )
      expect(reply.status, reply.text).toBe(200)
      expect((JSON.parse(reply.text) as { count?: unknown }).count, `the search from slot ${node.slot}`).toBe(
        stored.size,
      )
    }
  }, 1_500_000)
})
