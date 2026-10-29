import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type ClusterUnderTest, clock, startClusterUnderTest } from './cluster-under-test'
import { createLedger, type Ledger, type LedgerDocument, REFUSED_FOR_CERTAIN } from './oracle'
import { type FaultState, type Reply, SEARCH_TERM, send, startWorkload } from './workload'

const PLAIN = process.env.NARSIL_FAULT_PLAIN === '1'
const NODE_COUNT = 3
const PARTITION_COUNT = 3
const REPLICATION_FACTOR = 1
const BATCH_SIZE = 6_000
const BATCH_TIMEOUT_MS = 180_000
const FAULT_HOLD_MS = 15_000
const CUT_WRITE_MS = 8_000
const HEALED_WRITE_MS = 10_000
const STALE_DOCUMENTS = 40
const PROBE_WRITES = 10
const PROBE_WINDOW_MS = 60_000
const PROBE_PAUSE_MS = 250

function workloadRandom(): () => number {
  let state = 0x2545f491
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0
    return state / 4_294_967_296
  }
}

function settleBatch(
  ledger: Ledger,
  intended: ReadonlyMap<string, LedgerDocument | null>,
  reply: Reply | null,
): Record<string, number> {
  const codes: Record<string, number> = {}
  const tally = (code: string) => {
    codes[code] = (codes[code] ?? 0) + 1
  }
  if (reply === null || reply.status !== 200) {
    tally(reply === null ? 'no reply' : `${reply.status} ${reply.code ?? ''}`)
    for (const [docId, next] of intended) ledger.record(docId, next, 'unanswered')
    return codes
  }
  const body = JSON.parse(reply.text) as {
    succeeded: string[]
    failed: Array<{ docId: string; error: { code: string } }>
  }
  for (const docId of body.succeeded) {
    tally('succeeded')
    ledger.record(docId, intended.get(docId) ?? null, 'acknowledged')
  }
  for (const failure of body.failed) {
    tally(failure.error.code)
    const next = intended.get(failure.docId) ?? null
    if (REFUSED_FOR_CERTAIN.has(failure.error.code)) ledger.record(failure.docId, next, 'refused')
    else if (failure.error.code === 'DOC_ALREADY_EXISTS' || failure.error.code === 'DOC_NOT_FOUND') {
      ledger.contradict(`${failure.docId}: the batch answered ${failure.error.code}`)
      ledger.record(failure.docId, next, 'refused')
    } else ledger.record(failure.docId, next, 'unanswered')
  }
  const answered = body.succeeded.length + body.failed.length
  if (answered !== intended.size) ledger.contradict(`the batch answered ${answered} of ${intended.size} documents`)
  return codes
}

async function searchCounts(cluster: ClusterUnderTest, indexName: string): Promise<Array<number | string>> {
  return Promise.all(
    cluster.fleet.nodes.map(async node => {
      const reply = await send(
        node.base,
        'POST',
        `/indexes/${indexName}/search`,
        { term: SEARCH_TERM, limit: 1 },
        30_000,
      )
      if (reply.status !== 200) return `${reply.status} ${reply.text.slice(0, 200)}`
      return Number((JSON.parse(reply.text) as { count?: unknown }).count)
    }),
  )
}

describe('a node cut from etcd while its index is dropped and created again', () => {
  const INDEX_NAME = 'ledger'
  let cluster: ClusterUnderTest | null = null

  beforeAll(async () => {
    cluster = await startClusterUnderTest(NODE_COUNT, PLAIN, {
      partitionCount: PARTITION_COUNT,
      replicationFactor: REPLICATION_FACTOR,
      heartbeatTtlSeconds: 60,
      controllerLeaseTtlMs: 5_000,
      standbyRetryMs: 1_000,
      waitForServingMs: 30_000,
    })
  }, 240_000)

  afterAll(async () => {
    await cluster?.close()
  }, 120_000)

  it('serves the new index alone on every node once the cut node sees etcd again', async () => {
    if (cluster === null) throw new Error('The cluster never started')
    const { fleet, coordinator } = cluster
    const front = fleet.nodes[0]?.base ?? ''
    const indexConfig = { name: INDEX_NAME, config: { schema: { title: 'string', version: 'number' } } }
    const created = await send(front, 'POST', '/indexes', indexConfig, 60_000)
    expect(created.status, created.text).toBe(201)
    await cluster.untilHealed(INDEX_NAME, PARTITION_COUNT, REPLICATION_FACTOR, 'after the first create')
    const stale = await send(
      front,
      'POST',
      `/indexes/${INDEX_NAME}/documents/_batch`,
      {
        documents: Array.from({ length: STALE_DOCUMENTS }, (_, at) => ({
          id: `stale-${at}`,
          title: `${SEARCH_TERM} stale ${at}`,
          version: 0,
        })),
      },
      60_000,
    )
    expect(stale.status, stale.text).toBe(200)
    expect((JSON.parse(stale.text) as { failed: unknown[] }).failed).toEqual([])

    const table = await coordinator.getAllocation(INDEX_NAME)
    const primaries = new Set([...(table?.assignments.values() ?? [])].map(assignment => assignment.primary))
    const cut = fleet.nodes.find(node => node.slot !== 0 && primaries.has(node.nodeId()))?.slot ?? 1
    const faults: FaultState = { unavailable: new Set([cut]), startedOn: [], describe: () => `etcd cut on slot ${cut}` }
    const stopWatching = cluster.watchTable(INDEX_NAME)
    console.log(`${clock()} cutting etcd from slot ${cut}`)
    fleet.cutCoordinator(cut)
    const cutAt = Date.now()

    const dropped = await send(front, 'DELETE', `/indexes/${INDEX_NAME}`, undefined, 90_000)
    console.log(`drop answered ${dropped.status} after ${Date.now() - cutAt} ms: ${dropped.text.slice(0, 300)}`)
    expect(dropped.status === 200 || dropped.code === 'QUERY_NODE_TIMEOUT', dropped.text).toBe(true)
    const recreated = await send(front, 'POST', '/indexes', indexConfig, 90_000)
    console.log(`create answered ${recreated.status} after ${Date.now() - cutAt} ms`)
    expect(recreated.status, recreated.text).toBe(201)

    const ledger = createLedger()
    const workload = startWorkload({
      fleet,
      ledger,
      faults,
      indexName: INDEX_NAME,
      writers: 4,
      searchers: 2,
      random: workloadRandom(),
    })
    const probeLatencies: number[] = []
    try {
      await sleep(CUT_WRITE_MS)
      fleet.healCoordinator(cut)
      console.log(`${clock()} etcd healed for slot ${cut} after ${Date.now() - cutAt} ms`)
      faults.unavailable.delete(cut)
      for (let at = 0; at < PROBE_WRITES; at++) {
        const document = { title: `${SEARCH_TERM} probe ${at}`, version: 1 }
        const startedAt = Date.now()
        let reply: Reply | null = null
        while (Date.now() - startedAt < PROBE_WINDOW_MS) {
          reply = await send(
            front,
            'POST',
            `/indexes/${INDEX_NAME}/documents`,
            { id: `probe-${at}`, document },
            60_000,
          ).catch(() => null)
          if (
            reply?.status === 201 ||
            (reply?.code !== undefined && reply.code !== null && !REFUSED_FOR_CERTAIN.has(reply.code))
          )
            break
          await sleep(PROBE_PAUSE_MS)
        }
        probeLatencies.push(Date.now() - startedAt)
        const ok = reply !== null && reply.status === 201
        ledger.record(`probe-${at}`, document, ok ? 'acknowledged' : reply === null ? 'unanswered' : 'refused')
        expect(ok, `${clock()} ${reply?.text}`).toBe(true)
      }
      await sleep(HEALED_WRITE_MS)
    } finally {
      fleet.healCoordinator(cut)
      await workload.stop()
      console.log((await stopWatching()).join('\n'))
    }
    await cluster.untilHealed(INDEX_NAME, PARTITION_COUNT, REPLICATION_FACTOR, 'after the cut healed')

    const { stored, unequal } = await cluster.readStored(INDEX_NAME)
    console.log(
      `writes ${JSON.stringify(ledger.counts())}, searches ${workload.searches()}, probe write ms ${probeLatencies.join(' ')}`,
    )
    expect(unequal).toEqual([])
    expect([...stored.keys()].filter(docId => docId.startsWith('stale-'))).toEqual([])
    expect(ledger.check(stored)).toEqual([])
    expect(workload.searchFailures()).toEqual([])
    expect(await searchCounts(cluster, INDEX_NAME)).toEqual(fleet.nodes.map(() => stored.size))
  }, 900_000)
})

describe('a primary that fails over in the middle of a batch', () => {
  const INDEX_NAME = 'handover'
  let cluster: ClusterUnderTest | null = null

  beforeAll(async () => {
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

  it('keeps every write each batch acknowledged through a kill, a pause, and an isolation', async () => {
    if (cluster === null) throw new Error('The cluster never started')
    const { fleet, coordinator } = cluster
    const front = fleet.nodes[0]?.base ?? ''
    const created = await send(
      front,
      'POST',
      '/indexes',
      { name: INDEX_NAME, config: { schema: { title: 'string', version: 'number' } } },
      60_000,
    )
    expect(created.status, created.text).toBe(201)
    await cluster.untilHealed(INDEX_NAME, PARTITION_COUNT, REPLICATION_FACTOR, 'after the create')

    const ledger = createLedger()
    const stopWatching = cluster.watchTable(INDEX_NAME)
    const phases = [
      { action: 'insert', fault: 'kill' },
      { action: 'update', fault: 'pause' },
      { action: 'delete', fault: 'isolate' },
    ] as const
    try {
      for (const [at, phase] of phases.entries()) {
        const intended = new Map<string, LedgerDocument | null>()
        let body: unknown
        if (phase.action === 'insert') {
          const documents = Array.from({ length: BATCH_SIZE }, (_, n) => {
            const document = { title: `${SEARCH_TERM} batch ${n}`, version: 1 }
            intended.set(`b-${n}`, document)
            return { id: `b-${n}`, ...document }
          })
          body = { documents }
        } else {
          const present = Array.from({ length: BATCH_SIZE }, (_, n) => `b-${n}`).filter(
            docId => ledger.certainState(docId) !== null && !ledger.isRetired(docId),
          )
          if (phase.action === 'update') {
            for (const docId of present) intended.set(docId, { title: `${SEARCH_TERM} batch ${docId}`, version: 2 })
            body = {
              action: 'update',
              updates: present.map(docId => ({ docId, document: intended.get(docId) })),
            }
          } else {
            for (const docId of present.filter((_, n) => n % 2 === 0)) intended.set(docId, null)
            body = { action: 'delete', docIds: [...intended.keys()] }
          }
        }

        const table = await coordinator.getAllocation(INDEX_NAME)
        const front0 = fleet.nodes[0]?.nodeId()
        const victimId = [...(table?.assignments.values() ?? [])]
          .map(assignment => assignment.primary)
          .find(primary => primary !== null && primary !== front0)
        const victim = fleet.nodes.find(node => node.nodeId() === victimId)?.slot ?? 1

        const sentAt = Date.now()
        let answeredAt = 0
        const pending = send(front, 'POST', `/indexes/${INDEX_NAME}/documents/_batch`, body, BATCH_TIMEOUT_MS)
          .catch(() => null)
          .then(reply => {
            answeredAt = Date.now()
            return reply
          })
        await sleep(150)
        const faultAt = Date.now()
        console.log(`${clock()} phase ${at + 1}: ${phase.fault} on slot ${victim}`)
        if (phase.fault === 'kill') await fleet.kill(victim)
        else if (phase.fault === 'pause') fleet.pause(victim)
        else fleet.isolate(victim)
        const reply = await pending
        if (phase.fault === 'kill') await fleet.start(victim)
        else if (phase.fault === 'pause') {
          await sleep(Math.max(0, FAULT_HOLD_MS - (Date.now() - faultAt)))
          fleet.resume(victim)
        } else {
          await sleep(Math.max(0, FAULT_HOLD_MS - (Date.now() - faultAt)))
          fleet.reconnect(victim)
        }
        const codes = settleBatch(ledger, intended, reply)
        console.log(
          `phase ${at + 1}: ${phase.action} of ${intended.size} with ${phase.fault} on slot ${victim} at ${faultAt - sentAt} ms, answered at ${answeredAt - sentAt} ms: ${JSON.stringify(codes)}`,
        )
        expect(answeredAt, `the ${phase.action} batch answered before the ${phase.fault}`).toBeGreaterThan(faultAt)
        await cluster.untilHealed(INDEX_NAME, PARTITION_COUNT, REPLICATION_FACTOR, `after phase ${at + 1}`)
      }
    } finally {
      console.log((await stopWatching()).join('\n'))
    }

    const { stored, unequal } = await cluster.readStored(INDEX_NAME)
    console.log(`writes ${JSON.stringify(ledger.counts())}, stored ${stored.size}`)
    expect(ledger.counts().acknowledged).toBeGreaterThan(0)
    expect(unequal).toEqual([])
    expect(ledger.check(stored)).toEqual([])
    expect(await searchCounts(cluster, INDEX_NAME)).toEqual(fleet.nodes.map(() => stored.size))
  }, 1_200_000)
})
