import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { indexConfigKey } from '../../../distribution/cluster/index-metadata'
import type { ClusterCoordinator } from '../../../distribution/coordinator'
import { generateTlsBundles, type TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'
import { type EtcdMembers, startEtcdMembers } from './etcd-members'
import { type Fleet, RUST_NODE_VARIABLE, startFleet } from './fleet'
import { connectCoordinator } from './mixed-cluster'
import { type Answer, answer, countOf, errorCode, idsOf, insertBatch, rawAnswer, settled } from './route-parity'

const TYPESCRIPT_SLOT = 0
const RUST_SLOT = 1
const LEAVING_SLOT = 2
const INDEX_NAME = 'harbour-ledger'
const DOCUMENT_COUNT = 3_000
const CLEAR_HEAD_START_MS = 150
const SETTLE_MS = 90_000
const plain = process.env.NARSIL_FAULT_PLAIN === '1'

type Departure = 'kill' | 'stop'

interface ClearOutcome {
  status: number
  code: string | undefined
  remaining: number
}

describe.skipIf(process.env[RUST_NODE_VARIABLE] === undefined)(
  'a Rust node meets a node that leaves mid-clear and an orphaned copy as a TypeScript node does',
  () => {
    const keyPrefix = `_narsil_rust_route_faults_${randomUUID()}`
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

    async function healthy(): Promise<void> {
      await settled(
        'The cluster did not return to green health',
        SETTLE_MS,
        async () => (await answer(baseOf(TYPESCRIPT_SLOT), 'GET', '/cluster/health')).body as { status?: string },
        health => health.status === 'green',
      )
    }

    async function clearWhileLeaving(clearingSlot: number, departure: Departure, round: string): Promise<ClearOutcome> {
      await insertBatch(baseOf(clearingSlot), INDEX_NAME, idsOf(round, DOCUMENT_COUNT))
      const clearing = answer(baseOf(clearingSlot), 'POST', `/indexes/${INDEX_NAME}/_clear`)
      await sleep(CLEAR_HEAD_START_MS)
      if (departure === 'kill') await started().fleet.kill(LEAVING_SLOT)
      else await started().fleet.stop(LEAVING_SLOT)
      const cleared: Answer = await clearing
      const remaining = await countOf(baseOf(clearingSlot), INDEX_NAME)
      await started().fleet.start(LEAVING_SLOT)
      await healthy()
      return { status: cleared.status, code: errorCode(cleared), remaining }
    }

    beforeAll(async () => {
      bundles = plain ? null : await generateTlsBundles()
      etcd = await startEtcdMembers(bundles)
      fleet = await startFleet(3, etcd, bundles, {
        keyPrefix,
        partitionCount: 2,
        replicationFactor: 2,
        heartbeatTtlSeconds: 10,
        controllerLeaseTtlMs: 5_000,
        standbyRetryMs: 1_000,
        waitForServingMs: 30_000,
        nodeLeftDelayMs: 1_000,
        fixedNodeIds: false,
        transport: 'tcp',
        rustSlots: [RUST_SLOT],
      })
      await fleet.start(TYPESCRIPT_SLOT)
      await fleet.start(RUST_SLOT)
      await fleet.start(LEAVING_SLOT)
      coordinator = await connectCoordinator(etcd, bundles, keyPrefix)
      const created = await answer(baseOf(TYPESCRIPT_SLOT), 'POST', '/indexes', {
        name: INDEX_NAME,
        config: { schema: { title: 'string' } },
      })
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      await healthy()
    }, 300_000)

    afterAll(async () => {
      await coordinator?.shutdown().catch(() => {})
      await fleet?.remove()
      await etcd?.remove()
    }, 120_000)

    it.each([
      'kill',
      'stop',
    ] as const)('finishes or refuses a clear alike when a copy holder departs by %s partway through', async departure => {
      const typescript = await clearWhileLeaving(TYPESCRIPT_SLOT, departure, `${departure}-typescript`)
      const rust = await clearWhileLeaving(RUST_SLOT, departure, `${departure}-rust`)
      expect(rust).toEqual(typescript)
      expect(typescript).toEqual({ status: 200, code: undefined, remaining: 0 })
    }, 300_000)

    it('refuses every route on a copy that the cluster stopped claiming with the same code', async () => {
      await insertBatch(baseOf(RUST_SLOT), INDEX_NAME, idsOf('orphan', 10))
      await started().fleet.stopAll()
      await started().coordinator.dropSchema(INDEX_NAME)
      await started().coordinator.deleteAllocation(INDEX_NAME)
      await started().coordinator.delete(indexConfigKey(INDEX_NAME))
      await started().fleet.start(TYPESCRIPT_SLOT)
      await started().fleet.start(RUST_SLOT)
      const requests: Array<[string, string, unknown]> = [
        ['POST', `/indexes/${INDEX_NAME}/_checkpoint`, undefined],
        ['POST', `/indexes/${INDEX_NAME}/_clear`, undefined],
        ['POST', `/indexes/${INDEX_NAME}/_open`, undefined],
        ['GET', `/indexes/${INDEX_NAME}/synonyms`, undefined],
        ['POST', `/indexes/${INDEX_NAME}/synonyms`, { synonyms: [] }],
        ['POST', `/indexes/${INDEX_NAME}/bm25`, { k1: 1 }],
        ['POST', `/indexes/${INDEX_NAME}/_rebuild-analysis`, undefined],
      ]
      const withoutNodeId = (slot: number, reply: Answer): unknown =>
        JSON.parse(JSON.stringify(reply).replaceAll(started().fleet.nodes[slot]?.nodeId() ?? '', 'answering-node'))
      for (const [method, path, body] of requests) {
        const replies = await Promise.all(
          [TYPESCRIPT_SLOT, RUST_SLOT].map(async slot =>
            withoutNodeId(slot, await answer(baseOf(slot), method, path, body)),
          ),
        )
        expect(replies[1], `${method} ${path}`).toEqual(replies[0])
        expect(errorCode(replies[1] as Answer), `${method} ${path}`).toBe('INDEX_ORPHANED')
      }
      const imports = await Promise.all(
        [TYPESCRIPT_SLOT, RUST_SLOT].map(async slot =>
          withoutNodeId(
            slot,
            await rawAnswer(
              baseOf(slot),
              'POST',
              `/indexes/${INDEX_NAME}/documents/_import`,
              '{"id":"late","title":"late"}',
            ),
          ),
        ),
      )
      expect(imports[1]).toEqual(imports[0])
      expect(errorCode(imports[1] as Answer)).toBe('INDEX_ORPHANED')
    }, 300_000)
  },
)
