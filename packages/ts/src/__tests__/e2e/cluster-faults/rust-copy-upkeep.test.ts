import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterCoordinator } from '../../../distribution/coordinator'
import type { PartitionAssignment } from '../../../distribution/coordinator/types/allocation'
import { createNarsil } from '../../../narsil'
import { generateTlsBundles, type TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'
import { type EtcdMembers, startEtcdMembers } from './etcd-members'
import { type Fleet, RUST_NODE_VARIABLE, startFleet } from './fleet'
import { connectCoordinator } from './mixed-cluster'
import { answer, idsOf, raw, settled } from './route-parity'

const TYPESCRIPT_SLOT = 0
const RUST_SLOT = 1
const ROUTER_SLOT = 2
const SCORED_INDEX = 'harbour-scored'
const REOPENED_INDEX = 'harbour-reopened'
const BATCH_SIZE = 10
const BM25_CHANGE = { k1: 0.4, b: 0.1 }
const TIDE_QUERY = { term: 'tide', limit: 10 }
const TIDE_DOCUMENTS = [
  { id: 'tide-short', title: 'tide' },
  { id: 'tide-middle', title: 'tide harbour crane' },
  { id: 'tide-long', title: 'tide tide harbour crane anchor rope mooring' },
]
const SCORE_TOLERANCE = 1e-9
const SETTLE_MS = 90_000
const TEST_TIMEOUT_MS = 240_000
const plain = process.env.NARSIL_FAULT_PLAIN === '1'

type Scores = Array<[string, number]>

function scoresOf(body: unknown): Scores {
  const hits = (body as { hits?: Array<{ id?: string; score?: number }> }).hits ?? []
  return hits.map(hit => [String(hit.id), Number(hit.score)])
}

function sameScores(found: Scores, expected: Scores): boolean {
  return (
    found.length === expected.length &&
    found.every(
      ([id, score], at) =>
        id === expected[at]?.[0] && Math.abs(score - (expected[at]?.[1] ?? Number.NaN)) <= SCORE_TOLERANCE,
    )
  )
}

async function embeddedScores(bm25?: { k1: number; b: number }): Promise<Scores> {
  const engine = await createNarsil({ workers: { enabled: false } })
  try {
    await engine.createIndex(SCORED_INDEX, { schema: { title: 'string' } })
    for (const document of TIDE_DOCUMENTS) await engine.insert(SCORED_INDEX, { title: document.title }, document.id)
    if (bm25 !== undefined) await engine.updateBM25(SCORED_INDEX, bm25)
    const result = await engine.query(SCORED_INDEX, TIDE_QUERY)
    return result.hits.map(hit => [hit.id, Number(hit.score)])
  } finally {
    await engine.shutdown()
  }
}

function sampleOf(text: string, name: string, labels: Record<string, string>): number | undefined {
  const wanted = Object.entries(labels).map(([key, value]) => `${key}="${value}"`)
  const line = text
    .split('\n')
    .find(entry => entry.startsWith(`${name}{`) && wanted.every(label => entry.includes(label)))
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1))
}

describe.skipIf(process.env[RUST_NODE_VARIABLE] === undefined)(
  'a Rust copy keeps the BM25 setting and the entry numbering that a TypeScript copy keeps',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const keyPrefix = `_narsil_rust_copy_upkeep_${randomUUID()}`
    let bundles: TlsBundles | null = null
    let etcd: EtcdMembers | null = null
    let fleet: Fleet | null = null
    let coordinator: ClusterCoordinator | null = null

    function started(): { fleet: Fleet; coordinator: ClusterCoordinator } {
      if (fleet === null || coordinator === null) throw new Error('The mixed cluster never started')
      return { fleet, coordinator }
    }

    function baseOf(slot: number): string {
      return started().fleet.nodes[slot]?.base ?? ''
    }

    function nodeIdOf(slot: number): string {
      return started().fleet.nodes[slot]?.nodeId() ?? ''
    }

    async function placed(
      indexName: string,
      description: string,
      done: (assignment: PartitionAssignment) => boolean,
    ): Promise<PartitionAssignment | undefined> {
      return settled(
        description,
        SETTLE_MS,
        async () => (await started().coordinator.getAllocation(indexName))?.assignments.get(0),
        assignment => assignment !== undefined && done(assignment),
      )
    }

    async function bothInSync(indexName: string): Promise<void> {
      await placed(indexName, `Both data nodes did not hold ${indexName} in sync`, assignment =>
        [TYPESCRIPT_SLOT, RUST_SLOT].every(slot =>
          [assignment.primary, ...assignment.inSyncSet].includes(nodeIdOf(slot)),
        ),
      )
    }

    async function routerScores(expected: Scores, description: string): Promise<Scores> {
      return settled(
        description,
        SETTLE_MS,
        async () =>
          scoresOf((await answer(baseOf(ROUTER_SLOT), 'POST', `/indexes/${SCORED_INDEX}/search`, TIDE_QUERY)).body),
        found => sameScores(found, expected),
      )
    }

    beforeAll(async () => {
      bundles = plain ? null : await generateTlsBundles()
      etcd = await startEtcdMembers(bundles)
      fleet = await startFleet(3, etcd, bundles, {
        keyPrefix,
        partitionCount: 1,
        replicationFactor: 2,
        heartbeatTtlSeconds: 10,
        controllerLeaseTtlMs: 5_000,
        standbyRetryMs: 1_000,
        waitForServingMs: 30_000,
        nodeLeftDelayMs: 1_000,
        fixedNodeIds: false,
        transport: 'tcp',
        rustSlots: [RUST_SLOT],
        slotSettings: { [ROUTER_SLOT]: { roles: ['coordinator'] } },
      })
      await fleet.start(RUST_SLOT)
      coordinator = await connectCoordinator(etcd, bundles, keyPrefix)
      for (const name of [SCORED_INDEX, REOPENED_INDEX]) {
        const created = await answer(baseOf(RUST_SLOT), 'POST', '/indexes', {
          name,
          config: { schema: { title: 'string' } },
        })
        expect(created.status, JSON.stringify(created.body)).toBe(201)
      }
      await fleet.start(TYPESCRIPT_SLOT)
      await fleet.start(ROUTER_SLOT)
      await bothInSync(SCORED_INDEX)
      await bothInSync(REOPENED_INDEX)
    }, 300_000)

    afterAll(async () => {
      await coordinator?.shutdown().catch(() => {})
      await fleet?.remove()
      await etcd?.remove()
    }, 120_000)

    it('scores a search that a TypeScript router sends to a Rust copy under a stored BM25 change, before and after the Rust node restarts', async () => {
      for (const document of TIDE_DOCUMENTS) {
        const inserted = await answer(baseOf(ROUTER_SLOT), 'POST', `/indexes/${SCORED_INDEX}/documents`, {
          id: document.id,
          document: { title: document.title },
        })
        expect(inserted.status, JSON.stringify(inserted.body)).toBe(201)
      }
      await started().fleet.stop(TYPESCRIPT_SLOT)
      await placed(SCORED_INDEX, 'The Rust copy did not serve the scored index alone', assignment => {
        return assignment.primary === nodeIdOf(RUST_SLOT) && assignment.inSyncSet.length === 0
      })
      const before = await embeddedScores()
      const changed = await embeddedScores(BM25_CHANGE)
      expect(sameScores(changed, before)).toBe(false)
      await routerScores(before, 'The Rust copy did not score under the default setting')

      const stored = await answer(baseOf(ROUTER_SLOT), 'POST', `/indexes/${SCORED_INDEX}/bm25`, BM25_CHANGE)
      expect(stored.body).toEqual({ ok: true })
      await routerScores(changed, 'The Rust copy did not score under the stored change')

      await started().fleet.stop(RUST_SLOT)
      await started().fleet.start(RUST_SLOT)
      await routerScores(changed, 'The restarted Rust copy did not score under the stored change')

      await started().fleet.start(TYPESCRIPT_SLOT)
      await bothInSync(SCORED_INDEX)
      await bothInSync(REOPENED_INDEX)
    })

    it('numbers every entry in turn after a promoted Rust primary closes and reopens its copy, so a replica that missed the reopen catches up and holds every write', async () => {
      const rust = (): string => baseOf(RUST_SLOT)
      const written = new Map<string, string>()
      async function write(prefix: string, base = rust(), count = BATCH_SIZE): Promise<void> {
        for (const id of idsOf(prefix, count)) {
          const title = `ledger entry ${id}`
          const inserted = await answer(base, 'POST', `/indexes/${REOPENED_INDEX}/documents`, {
            id,
            document: { title },
          })
          expect(inserted.status, JSON.stringify(inserted.body)).toBe(201)
          written.set(id, title)
        }
      }
      async function readsEveryWrite(base: string): Promise<void> {
        for (const [id, title] of written) {
          const read = await answer(base, 'GET', `/indexes/${REOPENED_INDEX}/documents/${id}`)
          expect(read.status, `${id}: ${JSON.stringify(read.body)}`).toBe(200)
          expect((read.body as { document?: { title?: unknown } }).document?.title).toBe(title)
        }
      }
      async function reportsEveryEntry(slot: number): Promise<void> {
        await settled(
          `Slot ${slot} did not report a commit point at the number of writes`,
          SETTLE_MS,
          async () =>
            sampleOf((await raw(baseOf(slot), 'GET', '/metrics')).text, 'narsil_commit_point', {
              index: REOPENED_INDEX,
              partition: '0',
            }),
          point => point === written.size,
        )
      }

      const typescriptId = nodeIdOf(TYPESCRIPT_SLOT)
      await placed(REOPENED_INDEX, 'The Rust node did not lead the reopened index', assignment => {
        return assignment.primary === nodeIdOf(RUST_SLOT)
      })
      await write('first-term')
      await started().fleet.stop(RUST_SLOT)
      await placed(REOPENED_INDEX, 'The controller did not promote the TypeScript copy', assignment => {
        return assignment.primary === typescriptId
      })
      await write('typescript-term', baseOf(ROUTER_SLOT))
      await started().fleet.start(RUST_SLOT)
      await bothInSync(REOPENED_INDEX)
      await started().fleet.stop(TYPESCRIPT_SLOT)
      await placed(REOPENED_INDEX, 'The controller did not promote the Rust replica', assignment => {
        return assignment.primary === nodeIdOf(RUST_SLOT)
      })
      await started().fleet.start(TYPESCRIPT_SLOT)
      await bothInSync(REOPENED_INDEX)
      await write('before-close')
      await started().fleet.stop(TYPESCRIPT_SLOT)
      await placed(REOPENED_INDEX, 'The stopped replica stayed in the in-sync set', assignment => {
        return !assignment.inSyncSet.includes(typescriptId)
      })
      expect((await answer(rust(), 'POST', `/indexes/${REOPENED_INDEX}/_close`)).status).toBe(200)
      expect((await answer(rust(), 'POST', `/indexes/${REOPENED_INDEX}/_open`)).status).toBe(200)
      await write('after-reopen')

      await started().fleet.start(TYPESCRIPT_SLOT)
      await bothInSync(REOPENED_INDEX)
      await write('after-return')
      await reportsEveryEntry(RUST_SLOT)
      await settled(
        'The returning replica stayed behind the Rust primary',
        SETTLE_MS,
        async () =>
          sampleOf((await raw(rust(), 'GET', '/metrics')).text, 'narsil_replication_lag', {
            index: REOPENED_INDEX,
            replica: nodeIdOf(TYPESCRIPT_SLOT),
          }),
        lag => lag === 0,
      )
      await readsEveryWrite(rust())

      await started().fleet.stop(RUST_SLOT)
      await placed(REOPENED_INDEX, 'The controller did not promote the TypeScript replica', assignment => {
        return assignment.primary === nodeIdOf(TYPESCRIPT_SLOT)
      })
      await write('after-promotion', baseOf(ROUTER_SLOT), 1)
      await reportsEveryEntry(TYPESCRIPT_SLOT)
      await readsEveryWrite(baseOf(ROUTER_SLOT))
      await started().fleet.start(RUST_SLOT)
      await bothInSync(REOPENED_INDEX)
    })
  },
)
