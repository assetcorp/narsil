import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_TRANSPORT_CONFIG } from '../../../distribution/transport/types'
import { type ClusterUnderTest, startClusterUnderTest } from './cluster-under-test'
import {
  ALLOCATION_READ_TIMEOUT_MS,
  CAMPAIGN_WRITE_TIMEOUT_MARGIN_MS,
  MAX_FAULT_SEED,
  QUIET_WINDOW_MS,
} from './constants'
import {
  campaignPlan,
  describeFault,
  type FaultPlan,
  isEtcdFault,
  isWipe,
  type PlannedFault,
  pullRequestPlan,
  seededRandom,
} from './fault-plan'
import { RUST_NODE_VARIABLE } from './fleet'
import { createLedger } from './oracle'
import { type FaultState, NO_FAULT, type QuietWrite, SEARCH_TERM, send, startWorkload, type Workload } from './workload'

const SEED = Number(process.env.NARSIL_FAULT_SEED ?? Math.floor(Math.random() * 2 ** 31))
if (
  (process.env.NARSIL_FAULT_SEED !== undefined && !/^(0|[1-9]\d*)$/.test(process.env.NARSIL_FAULT_SEED)) ||
  !Number.isSafeInteger(SEED) ||
  SEED < 0 ||
  SEED > MAX_FAULT_SEED
) {
  throw new Error('NARSIL_FAULT_SEED must be an integer from 0 to 2147483647')
}
const CAMPAIGN = process.env.NARSIL_FAULT_CAMPAIGN === '1'
const NODE_COUNT = 3
const PARTITION_COUNT = 3
const REPLICATION_FACTOR = 1
const INDEX_NAME = 'ledger'
const ETCD_OUTAGE_MEMBERS = [1, 2]
const WORKLOAD_STREAM_SALT = 0x5bd1e995
const REST_AFTER_RESTART_MS = 15_000
const EVERY_NODE_SEARCH_CHECK = 'every node answers a search with every stored document'
const SLOW_WRITE_MEDIAN_MULTIPLE = 100
const SLOW_WRITE_FLOOR_MS = 5_000
const MIN_QUIET_WRITES_FOR_LATENCY = 20
const SOCKETS_LEFT_OPEN_LINE = 'SOCKETS LEFT OPEN AT SHUTDOWN'
const CLEAN_EXIT_LINE = 'exited with code 0 and signal null'
const CAMPAIGN_WRITE_TIMEOUT_MS = DEFAULT_TRANSPORT_CONFIG.requestTimeout + CAMPAIGN_WRITE_TIMEOUT_MARGIN_MS
const SETTLE_AFTER_LAST_FAULT_MS = DEFAULT_TRANSPORT_CONFIG.requestTimeout
const RUST_SLOT_STREAM_SALT = 0x27d4eb2f
const RUST_SLOTS = rustSlotsOf(process.env.NARSIL_FAULT_RUST_SLOTS)

function campaignRustSlots(): number[] {
  const random = seededRandom(SEED ^ RUST_SLOT_STREAM_SALT)
  const layouts = [[], [Math.floor(random() * NODE_COUNT)], Array.from({ length: NODE_COUNT }, (_, slot) => slot)]
  return layouts[Math.floor(random() * layouts.length)] ?? []
}

function rustSlotsOf(raw: string | undefined): number[] {
  if (raw === undefined || raw === '') {
    return CAMPAIGN && process.env[RUST_NODE_VARIABLE] !== undefined ? campaignRustSlots() : []
  }
  const slots = raw.split(',').map(slot => (/^\d+$/.test(slot) ? Number(slot) : -1))
  if (slots.some(slot => slot < 0 || slot >= NODE_COUNT)) {
    throw new Error(`NARSIL_FAULT_RUST_SLOTS must list slots from 0 to ${NODE_COUNT - 1}, separated by commas`)
  }
  return [...new Set(slots)]
}

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
      `NARSIL_FAULT_SEED=${SEED}${CAMPAIGN ? ' NARSIL_FAULT_CAMPAIGN=1' : plan.plain ? ' NARSIL_FAULT_PLAIN=1' : ''}${RUST_SLOTS.length > 0 ? ` NARSIL_FAULT_RUST_SLOTS=${RUST_SLOTS.join(',')}` : ''}: ${plan.transport} carrier${plan.plain ? '' : ' over TLS'}, ${plan.writers} writers, ${plan.searchers} searchers`,
    )
    cluster = await startClusterUnderTest(NODE_COUNT, plan.plain, {
      rustSlots: RUST_SLOTS,
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

  async function unsafeToWipe(slot: number, unhealed: ReadonlySet<number>): Promise<string | null> {
    if (cluster === null) return 'the cluster never started'
    const { fleet, coordinator } = cluster
    const nodeId = fleet.nodes[slot]?.nodeId() ?? ''
    const table = await Promise.race([
      coordinator.getAllocation(INDEX_NAME).catch(() => null),
      sleep(ALLOCATION_READ_TIMEOUT_MS, null),
    ])
    if (table === null) return `the allocation table gave no answer within ${ALLOCATION_READ_TIMEOUT_MS} ms`
    for (const [partitionId, assignment] of table.assignments) {
      const holders = [assignment.primary, ...assignment.replicas].filter(holder => holder !== null)
      if (!holders.includes(nodeId)) continue
      const others = holders.filter(holder => holder !== nodeId)
      if (others.length === 0) return `partition ${partitionId} keeps its only copy on slot ${slot}`
      for (const other of others) {
        const node = fleet.nodes.find(candidate => candidate.nodeId() === other)
        const current = other === assignment.primary || assignment.inSyncSet.includes(other)
        if (node === undefined || !node.running() || unhealed.has(node.slot) || !current) {
          return `partition ${partitionId} keeps its other copy on ${node === undefined ? other : `slot ${node.slot}`}, which is faulted, not yet confirmed healed, or outside the in-sync set`
        }
      }
    }
    const slotOf = (holder: string): string =>
      String(fleet.nodes.find(candidate => candidate.nodeId() === holder)?.slot ?? holder)
    const shown = [...table.assignments].map(
      ([partitionId, assignment]) =>
        `p${partitionId} primary ${assignment.primary === null ? 'none' : slotOf(assignment.primary)} replicas [${assignment.replicas.map(slotOf).join(' ')}] in-sync [${assignment.inSyncSet.map(slotOf).join(' ')}]`,
    )
    console.log(`slot ${slot} is wiped while table version ${table.version} shows ${shown.join('; ')}`)
    return null
  }

  async function injectFault(
    fault: PlannedFault,
    faults: FaultState,
    workload: Workload,
    alone: boolean,
    unhealed: Set<number>,
  ): Promise<void> {
    if (cluster === null) return
    const { fleet, etcd } = cluster
    const { kind, holdMs } = fault
    const slot = isWipe(kind) && alone ? await primarySlotOf(fault.slot % PARTITION_COUNT, fault.slot) : fault.slot
    if (slot !== fault.slot)
      console.log(`the wipe goes to slot ${slot}, the primary of partition ${fault.slot % PARTITION_COUNT}`)
    if (fault.startAfterMs > 0) await sleep(fault.startAfterMs)
    if (!isEtcdFault(kind)) {
      unhealed.add(slot)
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
      } else if (kind === 'kill' || isWipe(kind)) {
        if (fault.clientsRest === true) {
          await workload.rest()
        }
        if (kind === 'stop-wipe') await fleet.stop(slot)
        else await fleet.kill(slot)
        if (isWipe(kind)) {
          const unsafe = await unsafeToWipe(slot, unhealed)
          if (unsafe === null) await fleet.wipe(slot)
          else console.log(`slot ${slot} restarts with its data, because ${unsafe}`)
        }
        await sleep(holdMs)
        await fleet.start(slot)
        if (fault.clientsRest === true) {
          await sleep(REST_AFTER_RESTART_MS)
          faults.resting = false
        }
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
      if (!isEtcdFault(kind)) faults.unavailable.delete(slot)
      if (fault.clientsRest === true) faults.resting = false
    }
  }

  async function shutdownProblems(): Promise<string[]> {
    if (cluster === null) return ['The cluster never started']
    await cluster.fleet.stopAll()
    const problems: string[] = []
    for (const node of cluster.fleet.nodes) {
      const output = node.output()
      const lastStart = output.slice(output.lastIndexOf('--- start'))
      for (const line of output.split('\n').filter(text => text.includes(SOCKETS_LEFT_OPEN_LINE)))
        problems.push(`slot ${node.slot}: ${line}`)
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
      ...(CAMPAIGN ? { writeTimeoutMs: CAMPAIGN_WRITE_TIMEOUT_MS } : {}),
    })
    const applied: string[] = []
    const unhealed = new Set<number>()
    try {
      if (CAMPAIGN) await sleep(QUIET_WINDOW_MS)
      for (const [at, round] of plan.rounds.entries()) {
        const shown = round.map(describeFault).join(' while ')
        applied.push(shown)
        enter(shown)
        console.log(`fault ${at + 1} of ${plan.rounds.length}: ${shown}`)
        const outcomes = await Promise.allSettled(
          round.map(fault => injectFault(fault, faults, workload, round.length === 1, unhealed)),
        )
        for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason
        enter(`healing after ${shown}`)
        await untilHealed(`after ${shown}`)
        unhealed.clear()
        enter(NO_FAULT)
      }
      if (CAMPAIGN) {
        enter('settling after the last fault')
        await sleep(SETTLE_AFTER_LAST_FAULT_MS)
        enter(NO_FAULT)
        await sleep(QUIET_WINDOW_MS)
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
    expect(counts.acknowledged, 'the cluster acknowledges writes').toBeGreaterThan(0)
    expect(unequal, 'every copy equals its primary').toEqual([])
    expect(ledger.check(stored), 'every acknowledged write survives').toEqual([])
    expect(workload.searchFailures(), 'every search outside a fault answers').toEqual([])

    for (const node of fleet.nodes) {
      const reply = await send(
        node.base,
        'POST',
        `/indexes/${INDEX_NAME}/search`,
        { term: SEARCH_TERM, limit: 1 },
        30_000,
      )
      expect(reply.status, `${EVERY_NODE_SEARCH_CHECK}: slot ${node.slot} answered ${reply.text}`).toBe(200)
      expect(
        (JSON.parse(reply.text) as { count?: unknown }).count,
        `${EVERY_NODE_SEARCH_CHECK}: the search from slot ${node.slot}`,
      ).toBe(stored.size)
    }

    if (CAMPAIGN) {
      expect(workload.unansweredQuietWrites(), 'every write outside a fault answers').toEqual([])
      expect(workload.quietWrites().length, 'enough writes complete outside a fault').toBeGreaterThanOrEqual(
        MIN_QUIET_WRITES_FOR_LATENCY,
      )
      expect(slowWrites(workload.quietWrites()), 'no write is far slower than the median').toEqual([])
      expect(await shutdownProblems(), 'no node leaves sockets open at shutdown').toEqual([])
    }
  }, 1_500_000)
})
