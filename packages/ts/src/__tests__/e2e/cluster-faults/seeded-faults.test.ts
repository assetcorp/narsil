import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ClusterUnderTest, startClusterUnderTest } from './cluster-under-test'
import {
  campaignPlan,
  describeFault,
  type FaultPlan,
  isEtcdFault,
  type PlannedFault,
  pullRequestPlan,
  seededRandom,
} from './fault-plan'
import { createLedger } from './oracle'
import { type FaultState, NO_FAULT, type QuietWrite, SEARCH_TERM, send, startWorkload } from './workload'

const SEED = Number(process.env.NARSIL_FAULT_SEED ?? Math.floor(Math.random() * 2 ** 31))
const CAMPAIGN = process.env.NARSIL_FAULT_CAMPAIGN === '1'
const NODE_COUNT = 3
const PARTITION_COUNT = 3
const REPLICATION_FACTOR = 1
const INDEX_NAME = 'ledger'
const ETCD_OUTAGE_MEMBERS = [1, 2]
const WORKLOAD_STREAM_SALT = 0x5bd1e995
const SLOW_WRITE_MEDIAN_MULTIPLE = 100
const SLOW_WRITE_FLOOR_MS = 5_000
const MIN_QUIET_WRITES_FOR_LATENCY = 20
const SOCKETS_LEFT_OPEN_LINE = 'SOCKETS LEFT OPEN AT SHUTDOWN'
const CLEAN_EXIT_LINE = 'exited with code 0 and signal null'

function slowWrites(quiet: readonly QuietWrite[]): string[] {
  if (quiet.length < MIN_QUIET_WRITES_FOR_LATENCY) return []
  const sorted = quiet.map(write => write.durationMs).sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const bound = Math.max(median * SLOW_WRITE_MEDIAN_MULTIPLE, SLOW_WRITE_FLOOR_MS)
  return quiet
    .filter(write => write.durationMs > bound)
    .map(
      write =>
        `${write.docId} on slot ${write.slot} took ${Math.round(write.durationMs)} ms outside a fault, past ${Math.round(bound)} ms, against a median of ${median.toFixed(1)} ms over ${quiet.length} writes`,
    )
}

describe('a three-node cluster on three etcd members under seeded faults', () => {
  const random = seededRandom(SEED)
  const workloadRandom = seededRandom(SEED ^ WORKLOAD_STREAM_SALT)
  const plan: FaultPlan = CAMPAIGN
    ? campaignPlan(random, NODE_COUNT)
    : pullRequestPlan(random, NODE_COUNT, process.env.NARSIL_FAULT_PLAIN === '1')
  let cluster: ClusterUnderTest | null = null

  beforeAll(async () => {
    console.log(
      `NARSIL_FAULT_SEED=${SEED}${CAMPAIGN ? ' NARSIL_FAULT_CAMPAIGN=1' : plan.plain ? ' NARSIL_FAULT_PLAIN=1' : ''}: ${plan.transport} carrier${plan.plain ? '' : ' over TLS'}, ${plan.writers} writers, ${plan.searchers} searchers`,
    )
    cluster = await startClusterUnderTest(NODE_COUNT, plan.plain, {
      partitionCount: PARTITION_COUNT,
      replicationFactor: REPLICATION_FACTOR,
      heartbeatTtlSeconds: 10,
      controllerLeaseTtlMs: 5_000,
      standbyRetryMs: 1_000,
      waitForServingMs: 30_000,
      ...(plan.transport === 'grpc' ? { transport: 'grpc' as const } : {}),
    })
  }, 240_000)

  afterAll(async () => {
    await cluster?.close()
  }, 120_000)

  function untilHealed(reason: string): Promise<void> {
    if (cluster === null) throw new Error('The cluster never started')
    return cluster.untilHealed(INDEX_NAME, PARTITION_COUNT, REPLICATION_FACTOR, reason)
  }

  async function primarySlotOf(partitionId: number, fallback: number): Promise<number> {
    if (cluster === null) return fallback
    const { fleet, coordinator } = cluster
    const table = await coordinator.getAllocation(INDEX_NAME).catch(() => null)
    const primary = table?.assignments.get(partitionId)?.primary ?? null
    return fleet.nodes.find(node => primary !== null && node.nodeId() === primary)?.slot ?? fallback
  }

  async function injectFault(fault: PlannedFault, faults: FaultState, alone: boolean): Promise<void> {
    if (cluster === null) return
    const { fleet, etcd } = cluster
    const { kind, holdMs } = fault
    const slot = kind === 'wipe' && alone ? await primarySlotOf(fault.slot % PARTITION_COUNT, fault.slot) : fault.slot
    if (slot !== fault.slot)
      console.log(`the wipe goes to slot ${slot}, the primary of partition ${fault.slot % PARTITION_COUNT}`)
    await sleep(fault.startAfterMs)
    if (!isEtcdFault(kind)) {
      faults.unavailable.add(slot)
      faults.startedOn[slot] = (faults.startedOn[slot] ?? 0) + 1
    }
    try {
      if (kind === 'etcd-restart') {
        await etcd.restart(slot % etcd.endpoints.length)
      } else if (kind === 'etcd-outage') {
        for (const member of ETCD_OUTAGE_MEMBERS) await etcd.stop(member)
        await sleep(holdMs)
        for (const member of ETCD_OUTAGE_MEMBERS) await etcd.start(member)
      } else if (kind === 'kill' || kind === 'wipe') {
        await fleet.kill(slot)
        if (kind === 'wipe') await fleet.wipe(slot)
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
      } else {
        fleet.blackhole(slot)
        await sleep(holdMs)
        fleet.reconnect(slot)
      }
    } finally {
      faults.unavailable.delete(slot)
    }
  }

  async function shutdownProblems(): Promise<string[]> {
    if (cluster === null) return ['The cluster never started']
    await cluster.fleet.stopAll()
    const problems: string[] = []
    for (const node of cluster.fleet.nodes) {
      const output = node.output()
      const lastStart = output.slice(output.lastIndexOf('--- start'))
      if (lastStart.includes(SOCKETS_LEFT_OPEN_LINE)) {
        const line = lastStart.split('\n').find(text => text.includes(SOCKETS_LEFT_OPEN_LINE)) ?? ''
        problems.push(`slot ${node.slot}: ${line}`)
      }
      if (!lastStart.includes(CLEAN_EXIT_LINE)) problems.push(`slot ${node.slot} did not exit cleanly on SIGTERM`)
    }
    return problems
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
    let current = NO_FAULT
    const faults: FaultState = { unavailable: new Set(), startedOn: [], generation: 0, describe: () => current }
    function enter(state: string): void {
      current = state
      faults.generation += 1
    }
    const workload = startWorkload({
      fleet,
      ledger,
      faults,
      indexName: INDEX_NAME,
      writers: plan.writers,
      searchers: plan.searchers,
      random: workloadRandom,
    })
    const applied: string[] = []
    try {
      for (const [at, round] of plan.rounds.entries()) {
        const shown = round.map(describeFault).join(' while ')
        applied.push(shown)
        enter(shown)
        console.log(`fault ${at + 1} of ${plan.rounds.length}: ${shown}`)
        await Promise.all(round.map(fault => injectFault(fault, faults, round.length === 1)))
        enter(`healing after ${shown}`)
        await untilHealed(`after ${shown}`)
        enter(NO_FAULT)
      }
    } finally {
      await workload.stop()
    }
    await untilHealed('once the writers stopped')

    const { stored, unequal } = await cluster.readStored(INDEX_NAME)

    const counts = ledger.counts()
    console.log(
      `seed ${SEED}, faults ${applied.join('; ')}, writes ${JSON.stringify(counts)}, searches ${workload.searches()}`,
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

    if (CAMPAIGN) {
      expect(workload.unansweredQuietWrites()).toEqual([])
      expect(slowWrites(workload.quietWrites())).toEqual([])
      expect(await shutdownProblems()).toEqual([])
    }
  }, 1_500_000)
})
