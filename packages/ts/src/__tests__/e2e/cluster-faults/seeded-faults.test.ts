import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { decode, encode } from '@msgpack/msgpack'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ClusterCoordinator, createEtcdCoordinator } from '../../../distribution/coordinator'
import { createTcpTransport } from '../../../distribution/transport/tcp'
import { generateTlsBundles, type TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'
import { ETCD_ROOT_PASSWORD, type EtcdMembers, startEtcdMembers } from './etcd-members'
import { type Fleet, startFleet } from './fleet'
import { createLedger, type LedgerDocument } from './oracle'
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
const HEAL_TIMEOUT_MS = 120_000
const HEAL_POLL_MS = 500
const COPY_PAGE_LIMIT = 10_000
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
  const keyPrefix = `_narsil_faults_${randomUUID()}`
  let bundles: TlsBundles | null = null
  let etcd: EtcdMembers | null = null
  let fleet: Fleet | null = null
  let coordinator: ClusterCoordinator | null = null
  let probe: ReturnType<typeof createTcpTransport> | null = null

  beforeAll(async () => {
    console.log(`NARSIL_FAULT_SEED=${SEED}${PLAIN ? ' NARSIL_FAULT_PLAIN=1' : ''}`)
    bundles = PLAIN ? null : await generateTlsBundles()
    etcd = await startEtcdMembers(bundles)
    fleet = await startFleet(NODE_COUNT, etcd, bundles, {
      keyPrefix,
      partitionCount: PARTITION_COUNT,
      replicationFactor: REPLICATION_FACTOR,
      heartbeatTtlSeconds: 10,
      controllerLeaseTtlMs: 5_000,
      standbyRetryMs: 1_000,
      waitForServingMs: 30_000,
      fixedNodeIds: PLAIN,
    })
    for (const node of fleet.nodes) await fleet.start(node.slot)
    coordinator = await createEtcdCoordinator({
      endpoints: [...etcd.endpoints],
      keyPrefix,
      ...(bundles === null
        ? {}
        : {
            tls: { ca: bundles.serverBundle.ca, cert: bundles.clientBundle.cert, key: bundles.clientBundle.key },
            auth: { username: 'root', password: ETCD_ROOT_PASSWORD },
          }),
    })
    probe = createTcpTransport('fault-probe', {
      host: '127.0.0.1',
      port: 0,
      ...(bundles === null
        ? {}
        : { tls: { ca: bundles.serverBundle.ca, cert: bundles.serverBundle.cert, key: bundles.serverBundle.key } }),
    })
  }, 240_000)

  afterAll(async () => {
    if (fleet !== null) {
      for (const node of fleet.nodes)
        console.log(`--- slot ${node.slot} (${node.nodeId()})\n${node.output().slice(-400_000)}`)
    }
    await probe?.shutdown().catch(() => {})
    await coordinator?.shutdown().catch(() => {})
    await fleet?.remove()
    await etcd?.remove()
  }, 120_000)

  async function healed(): Promise<boolean> {
    if (fleet === null || coordinator === null) return false
    if (!fleet.nodes.every(node => node.running())) return false
    const running = new Set(fleet.nodes.map(node => node.nodeId()))
    const table = await coordinator.getAllocation(INDEX_NAME).catch(() => null)
    if (table === null || table.assignments.size !== PARTITION_COUNT) return false
    return [...table.assignments.values()].every(
      assignment =>
        assignment.state === 'ACTIVE' &&
        assignment.primary !== null &&
        running.has(assignment.primary) &&
        assignment.inSyncSet.length >= REPLICATION_FACTOR,
    )
  }

  async function untilHealed(reason: string): Promise<void> {
    const deadline = Date.now() + HEAL_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await healed()) return
      await sleep(HEAL_POLL_MS)
    }
    const table = await coordinator?.getAllocation(INDEX_NAME).catch(() => null)
    throw new Error(
      `The cluster did not heal within ${HEAL_TIMEOUT_MS} ms ${reason}: ${JSON.stringify([...(table?.assignments ?? [])])}\n${await replicationMetrics()}`,
    )
  }

  async function replicationMetrics(): Promise<string> {
    const reports = await Promise.all(
      (fleet?.nodes ?? []).map(async node => {
        const reply = await send(node.base, 'GET', '/metrics', undefined, 5_000).catch((error: unknown) => ({
          text: String(error),
        }))
        const lines = reply.text.split('\n').filter(line => line.startsWith('narsil_') && !line.includes('_seconds'))
        return `slot ${node.slot} (${node.nodeId()}):\n${lines.join('\n')}`
      }),
    )
    return reports.join('\n')
  }

  async function readCopy(nodeId: string, partitionId: number): Promise<Map<string, LedgerDocument>> {
    const holder = fleet?.nodes.find(node => node.nodeId() === nodeId)
    if (holder === undefined || probe === null) throw new Error(`No running node holds the id ${nodeId}`)
    const response = await probe.send(holder.transportAddress, {
      type: 'query.list',
      sourceId: 'fault-probe',
      requestId: `fault-probe-${randomUUID()}`,
      payload: encode({
        indexName: INDEX_NAME,
        partitionIds: [partitionId],
        cursor: null,
        limit: COPY_PAGE_LIMIT,
        filters: null,
        sort: null,
        fields: null,
      }),
    })
    const payload = decode(response.payload) as {
      entries?: Array<{ docId: string; document: { title?: unknown; version?: unknown } }>
      hasMore?: boolean
      message?: string
    }
    if (payload.entries === undefined) throw new Error(`${nodeId} answered ${response.type}: ${payload.message ?? ''}`)
    if (payload.hasMore === true) throw new Error(`${nodeId} holds more than ${COPY_PAGE_LIMIT} documents`)
    const copy = new Map<string, LedgerDocument>()
    for (const entry of payload.entries) {
      copy.set(entry.docId, { title: String(entry.document.title), version: Number(entry.document.version) })
    }
    return copy
  }

  async function injectFault(kind: FaultKind, slot: number, holdMs: number, faults: FaultState): Promise<void> {
    if (fleet === null || etcd === null) return
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
    if (fleet === null || coordinator === null) throw new Error('The cluster never started')
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

    const table = await coordinator.getAllocation(INDEX_NAME)
    const stored = new Map<string, LedgerDocument>()
    const unequal: string[] = []
    for (const [partitionId, assignment] of table?.assignments ?? []) {
      const holders = [assignment.primary ?? '', ...assignment.inSyncSet]
      const copies = await Promise.all(holders.map(holder => readCopy(holder, partitionId)))
      const primaryCopy = copies[0] ?? new Map<string, LedgerDocument>()
      for (let at = 1; at < copies.length; at++) {
        const copy = copies[at] ?? new Map<string, LedgerDocument>()
        const differing = [...new Set([...primaryCopy.keys(), ...copy.keys()])]
          .filter(docId => JSON.stringify(primaryCopy.get(docId)) !== JSON.stringify(copy.get(docId)))
          .sort()
        if (differing.length > 0) {
          const shown = differing
            .slice(0, 5)
            .map(
              docId =>
                `${docId} primary ${primaryCopy.get(docId)?.version ?? 'absent'} copy ${copy.get(docId)?.version ?? 'absent'}`,
            )
          unequal.push(
            `partition ${partitionId}: ${holders[at]} differs from its primary ${holders[0]} on ${differing.length} of ${primaryCopy.size} documents: ${shown.join(', ')}`,
          )
        }
      }
      for (const [docId, document] of copies[0] ?? []) stored.set(docId, document)
    }

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
