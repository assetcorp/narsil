import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateTlsBundles, type TlsBundles } from '../../distribution/transport/tcp-tls/fixtures'
import { type EtcdMembers, startEtcdMembers } from './etcd-members'
import { type Fleet, RUST_NODE_VARIABLE, startFleet } from './fleet'
import { insertEntries } from './mixed-cluster'
import { answer, countOf, errorCode, finishedTask, raw, rawAnswer, sameAnswer, settled } from './route-parity'

const TYPESCRIPT_SLOT = 0
const RUST_SLOT = 1
const SECOND_TYPESCRIPT_SLOT = 2
const INDEX_NAME = 'harbour-ledger'
const MISSING_INDEX = 'harbour-missing'
const HIDDEN_INDEX = 'narsil-generation-harbour'
const ENTRY_COUNT = 12
const PARTITION_COUNT = 2
const REPLICATION_FACTOR = 2
const SETTLE_MS = 60_000
const TEST_TIMEOUT_MS = 120_000
const PROMETHEUS_TEXT = 'text/plain; version=0.0.4; charset=utf-8'
const FAMILIES = [
  'narsil_replication_lag',
  'narsil_commit_point',
  'narsil_commit_point_floor',
  'narsil_in_sync_replicas',
  'narsil_vector_rebuild_waiting_for_memory',
  'narsil_coordinator_request_seconds',
]
const plain = process.env.NARSIL_FAULT_PLAIN === '1'

interface Sample {
  name: string
  labels: Record<string, string>
  value: number
}

function samplesOf(text: string): Sample[] {
  return text
    .split('\n')
    .filter(line => line !== '' && !line.startsWith('#'))
    .map(line => {
      const match = /^([a-z_]+)\{(.*)\} (\S+)$/.exec(line)
      if (match === null) throw new Error(`A metrics line has no labels: ${line}`)
      const labels: Record<string, string> = {}
      for (const pair of (match[2] ?? '').matchAll(/([a-z]+)="((?:[^"\\]|\\.)*)"/g))
        labels[pair[1] ?? ''] = pair[2] ?? ''
      return { name: match[1] ?? '', labels, value: Number(match[3]) }
    })
}

function headersOf(text: string): string[] {
  return text.split('\n').filter(line => line.startsWith('#'))
}

function searchScores(body: unknown): number[] {
  const hits = (body as { hits?: Array<{ score?: number }> }).hits ?? []
  return hits.map(hit => Number(hit.score))
}

describe.skipIf(process.env[RUST_NODE_VARIABLE] === undefined)(
  'every route on a Rust node answers as a TypeScript node',
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const keyPrefix = `_narsil_rust_routes_${randomUUID()}`
    let bundles: TlsBundles | null = null
    let etcd: EtcdMembers | null = null
    let fleet: Fleet | null = null

    function baseOf(slot: number): string {
      const base = fleet?.nodes[slot]?.base
      if (base === undefined) throw new Error('The mixed cluster never started')
      return base
    }

    function nodeIdOf(slot: number): string {
      return fleet?.nodes[slot]?.nodeId() ?? ''
    }

    function bases(): [string, string] {
      return [baseOf(TYPESCRIPT_SLOT), baseOf(RUST_SLOT)]
    }

    async function expectSameRefusal(method: string, path: string, body?: unknown): Promise<string | undefined> {
      const reply = await sameAnswer(bases(), method, path, body)
      expect(reply.status, `${method} ${path}`).toBeGreaterThanOrEqual(400)
      return errorCode(reply)
    }

    beforeAll(async () => {
      bundles = plain ? null : await generateTlsBundles()
      etcd = await startEtcdMembers(bundles)
      fleet = await startFleet(3, etcd, bundles, {
        keyPrefix,
        partitionCount: PARTITION_COUNT,
        replicationFactor: REPLICATION_FACTOR,
        heartbeatTtlSeconds: 10,
        controllerLeaseTtlMs: 5_000,
        standbyRetryMs: 1_000,
        waitForServingMs: 30_000,
        fixedNodeIds: false,
        transport: 'tcp',
        rustSlots: [RUST_SLOT],
      })
      await fleet.start(TYPESCRIPT_SLOT)
      await fleet.start(RUST_SLOT)
      await fleet.start(SECOND_TYPESCRIPT_SLOT)
      const created = await answer(baseOf(TYPESCRIPT_SLOT), 'POST', '/indexes', {
        name: INDEX_NAME,
        config: { schema: { title: 'string' } },
      })
      expect(created.status, JSON.stringify(created.body)).toBe(201)
      await insertEntries(baseOf(RUST_SLOT), INDEX_NAME, ENTRY_COUNT)
      await settled(
        'The index did not report every entry on both nodes',
        SETTLE_MS,
        async () => Promise.all(bases().map(base => countOf(base, INDEX_NAME))),
        counts => counts.every(count => count === ENTRY_COUNT),
      )
    }, 300_000)

    afterAll(async () => {
      await fleet?.remove()
      await etcd?.remove()
    }, 120_000)

    it('reports the same topology, with every node of the fleet and the same controller', async () => {
      const [typescript, rust] = await settled(
        'Both nodes did not report themselves serving',
        SETTLE_MS,
        async () => Promise.all(bases().map(base => answer(base, 'GET', '/cluster'))),
        replies =>
          replies.every(reply => (reply.body as { node?: { readiness?: string } }).node?.readiness === 'SERVING'),
      )
      const fleetIds = [TYPESCRIPT_SLOT, RUST_SLOT, SECOND_TYPESCRIPT_SLOT].map(nodeIdOf).sort()
      for (const [slot, reply] of [
        [TYPESCRIPT_SLOT, typescript],
        [RUST_SLOT, rust],
      ] as const) {
        expect(reply?.status).toBe(200)
        const body = reply?.body as {
          node: Record<string, unknown>
          controllerNodeId: string | null
          nodes: Array<Record<string, unknown>>
        }
        expect(Object.keys(body)).toEqual(['node', 'controllerNodeId', 'nodes'])
        expect(body.node).toEqual({
          nodeId: nodeIdOf(slot),
          roles: ['data', 'coordinator', 'controller'],
          status: 'active',
          readiness: 'SERVING',
          isController: body.controllerNodeId === nodeIdOf(slot),
        })
        expect(body.nodes.map(node => node.nodeId).sort()).toEqual(fleetIds)
        for (const node of body.nodes) {
          expect(Object.keys(node)).toEqual(['nodeId', 'address', 'roles', 'memory'])
          expect(node.address).toMatch(/^127\.0\.0\.1:\d+$/)
        }
      }
      const typescriptBody = typescript?.body as { controllerNodeId: string; nodes: Array<Record<string, unknown>> }
      const rustBody = rust?.body as { controllerNodeId: string; nodes: Array<Record<string, unknown>> }
      expect(rustBody.controllerNodeId).toBe(typescriptBody.controllerNodeId)
      expect(fleetIds).toContain(rustBody.controllerNodeId)
      const placement = (nodes: Array<Record<string, unknown>>) =>
        nodes
          .map(node => ({ nodeId: node.nodeId, address: node.address, roles: node.roles }))
          .sort((left, right) => String(left.nodeId).localeCompare(String(right.nodeId)))
      expect(placement(rustBody.nodes)).toEqual(placement(typescriptBody.nodes))
    })

    it('reports the same green health for an index whose every partition keeps a primary and two in-sync replicas', async () => {
      const expected = {
        status: 'green',
        indexes: [
          {
            indexName: INDEX_NAME,
            status: 'green',
            partitionCount: PARTITION_COUNT,
            replicationFactor: REPLICATION_FACTOR,
            partitionsWithoutPrimary: 0,
            underReplicatedPartitions: 0,
          },
        ],
      }
      await settled(
        'The cluster did not report green health from both nodes',
        SETTLE_MS,
        async () => Promise.all(bases().map(base => answer(base, 'GET', '/cluster/health'))),
        replies => replies.every(reply => JSON.stringify(reply.body) === JSON.stringify(expected)),
      )
    })

    it('reports the metric families in the same order, the same table figures, and commit points that sum to the writes', async () => {
      const replies = await settled(
        'The led partitions did not report every replica caught up',
        SETTLE_MS,
        async () =>
          Promise.all(
            [TYPESCRIPT_SLOT, RUST_SLOT, SECOND_TYPESCRIPT_SLOT].map(slot => raw(baseOf(slot), 'GET', '/metrics')),
          ),
        current =>
          current.every(reply =>
            samplesOf(reply.text)
              .filter(sample => sample.name === 'narsil_replication_lag')
              .every(sample => sample.value === 0),
          ),
      )
      const [typescript, rust] = replies
      if (typescript === undefined || rust === undefined) throw new Error('A node gave no metrics')
      expect(rust.status).toBe(200)
      expect(rust.contentType).toBe(PROMETHEUS_TEXT)
      expect(typescript.contentType).toBe(PROMETHEUS_TEXT)
      expect(headersOf(rust.text)).toEqual(headersOf(typescript.text))
      expect(
        headersOf(rust.text)
          .filter(line => line.startsWith('# TYPE'))
          .map(line => line.split(' ')[2]),
      ).toEqual(FAMILIES)
      const tableLines = (text: string) =>
        text
          .split('\n')
          .filter(line => line.startsWith('narsil_commit_point_floor{') || line.startsWith('narsil_in_sync_replicas{'))
      expect(tableLines(rust.text)).toEqual(tableLines(typescript.text))
      expect(
        samplesOf(rust.text)
          .filter(sample => sample.name === 'narsil_in_sync_replicas' && sample.labels.index === INDEX_NAME)
          .map(sample => [sample.labels.partition, sample.value]),
      ).toEqual([
        ['0', REPLICATION_FACTOR],
        ['1', REPLICATION_FACTOR],
      ])
      const commitPoints = replies.flatMap(reply =>
        samplesOf(reply.text).filter(
          sample => sample.name === 'narsil_commit_point' && sample.labels.index === INDEX_NAME,
        ),
      )
      expect(commitPoints.map(sample => sample.labels.partition).sort()).toEqual(['0', '1'])
      expect(commitPoints.reduce((total, sample) => total + sample.value, 0)).toBe(ENTRY_COUNT)
      for (const [slot, reply] of replies.entries()) {
        const nodeId = nodeIdOf(slot)
        for (const sample of samplesOf(reply.text).filter(sample => sample.name === 'narsil_replication_lag')) {
          expect(sample.labels.replica).not.toBe(nodeId)
        }
      }

      const histogram = samplesOf(rust.text).filter(sample => sample.name.startsWith('narsil_coordinator_request_'))
      const operations = [...new Set(histogram.map(sample => sample.labels.operation))]
      expect(operations).toContain('listNodes')
      expect(operations).toEqual([...operations].sort())
      const typescriptBounds = samplesOf(typescript.text)
        .filter(sample => sample.name === 'narsil_coordinator_request_seconds_bucket')
        .filter(sample => sample.labels.operation === 'listNodes')
        .map(sample => sample.labels.le)
      for (const operation of operations) {
        const buckets = histogram.filter(
          sample =>
            sample.name === 'narsil_coordinator_request_seconds_bucket' && sample.labels.operation === operation,
        )
        expect(buckets.map(sample => sample.labels.le)).toEqual(typescriptBounds)
        const counts = buckets.map(sample => sample.value)
        expect(counts).toEqual([...counts].sort((left, right) => left - right))
        const total = histogram.find(
          sample => sample.name === 'narsil_coordinator_request_seconds_count' && sample.labels.operation === operation,
        )
        expect(total?.value).toBeGreaterThan(0)
        expect(counts.at(-1)).toBe(total?.value)
      }
    })

    it('reports the memory of the local engine in the same shape, counting the one open copy', async () => {
      const [typescript, rust] = await Promise.all(bases().map(base => answer(base, 'GET', '/stats/memory')))
      expect(rust?.status).toBe(200)
      expect(Object.keys(rust?.body as object)).toEqual(Object.keys(typescript?.body as object))
      for (const reply of [typescript, rust]) {
        const body = reply?.body as { openIndexCount: number; closedIndexCount: number; reopenCount: number }
        expect([body.openIndexCount, body.closedIndexCount, body.reopenCount]).toEqual([1, 0, 0])
      }
    })

    it('checkpoints the local copy and refuses a missing or reserved index with the same codes', async () => {
      await sameAnswer(bases(), 'POST', `/indexes/${INDEX_NAME}/_checkpoint`)
      expect((await answer(baseOf(RUST_SLOT), 'POST', `/indexes/${INDEX_NAME}/_checkpoint`)).body).toEqual({ ok: true })
      expect(await expectSameRefusal('POST', `/indexes/${MISSING_INDEX}/_checkpoint`)).toBe('INDEX_NOT_FOUND')
      expect(await expectSameRefusal('POST', `/indexes/${HIDDEN_INDEX}/_checkpoint`)).toBe('CONFIG_INVALID')
    })

    it('replaces a synonym set from either node, and each node serves the set that the other stored', async () => {
      await sameAnswer(bases(), 'GET', `/indexes/${INDEX_NAME}/synonyms`)
      const fromRust = [{ words: ['ledger', 'journal'] }]
      expect(
        (await answer(baseOf(RUST_SLOT), 'POST', `/indexes/${INDEX_NAME}/synonyms`, { synonyms: fromRust })).body,
      ).toEqual({ ok: true })
      expect((await sameAnswer(bases(), 'GET', `/indexes/${INDEX_NAME}/synonyms`)).body).toEqual({ synonyms: fromRust })
      for (const base of bases()) {
        const found = await answer(base, 'POST', `/indexes/${INDEX_NAME}/search`, { term: 'journal', limit: 100 })
        expect((found.body as { count: number }).count).toBe(ENTRY_COUNT)
      }
      const fromTypescript = [{ word: 'register', synonyms: ['ledger'] }]
      const stored = await answer(baseOf(TYPESCRIPT_SLOT), 'POST', `/indexes/${INDEX_NAME}/synonyms`, {
        synonyms: fromTypescript,
      })
      expect(stored.status, JSON.stringify(stored.body)).toBe(200)
      expect((await sameAnswer(bases(), 'GET', `/indexes/${INDEX_NAME}/synonyms`)).body).toEqual({
        synonyms: fromTypescript,
      })
      const found = await answer(baseOf(RUST_SLOT), 'POST', `/indexes/${INDEX_NAME}/search`, {
        term: 'register',
        limit: 100,
      })
      expect((found.body as { count: number }).count).toBe(ENTRY_COUNT)

      expect(await expectSameRefusal('POST', `/indexes/${INDEX_NAME}/synonyms`, {})).toBe('INVALID_REQUEST')
      expect(await expectSameRefusal('POST', `/indexes/${INDEX_NAME}/synonyms`, [])).toBe('INVALID_REQUEST')
      expect(await expectSameRefusal('POST', `/indexes/${INDEX_NAME}/synonyms`, { synonyms: 'loose' })).toBe(
        'CONFIG_INVALID',
      )
      expect(
        await expectSameRefusal('POST', `/indexes/${INDEX_NAME}/synonyms`, { synonyms: [{ words: ['alone'] }] }),
      ).toBe('CONFIG_INVALID')
      expect(await expectSameRefusal('POST', `/indexes/${MISSING_INDEX}/synonyms`, { synonyms: [] })).toBe(
        'INDEX_NOT_FOUND',
      )
      expect(await expectSameRefusal('GET', `/indexes/${MISSING_INDEX}/synonyms`)).toBe('INDEX_NOT_FOUND')
      expect(await expectSameRefusal('GET', `/indexes/${HIDDEN_INDEX}/synonyms`)).toBe('CONFIG_INVALID')
      await sameAnswer(bases(), 'POST', `/indexes/${INDEX_NAME}/synonyms`, { synonyms: [] })
    })

    it('stores a BM25 setting from the Rust node that both nodes then score with, and refuses bad settings alike', async () => {
      const query = { term: 'tide', limit: 100 }
      const lengths = [
        { id: 'tide-short', title: 'tide' },
        { id: 'tide-long', title: 'tide tide harbour crane anchor rope mooring' },
      ]
      for (const document of lengths) {
        const inserted = await answer(baseOf(TYPESCRIPT_SLOT), 'POST', `/indexes/${INDEX_NAME}/documents`, {
          id: document.id,
          document: { title: document.title },
        })
        expect(inserted.status, JSON.stringify(inserted.body)).toBe(201)
      }
      const before = searchScores(
        (await answer(baseOf(TYPESCRIPT_SLOT), 'POST', `/indexes/${INDEX_NAME}/search`, query)).body,
      )
      const stored = await answer(baseOf(RUST_SLOT), 'POST', `/indexes/${INDEX_NAME}/bm25`, { k1: 0.4, b: 0.1 })
      expect(stored.body).toEqual({ ok: true })
      const [typescript, rust] = await settled(
        'The new BM25 setting did not change the scores on both nodes',
        SETTLE_MS,
        async () =>
          Promise.all(
            bases().map(async base =>
              searchScores((await answer(base, 'POST', `/indexes/${INDEX_NAME}/search`, query)).body),
            ),
          ),
        ([typescript, rust]) =>
          JSON.stringify(typescript) === JSON.stringify(rust) && JSON.stringify(typescript) !== JSON.stringify(before),
      )
      expect(rust).toEqual(typescript)
      expect(rust).toHaveLength(lengths.length)
      for (const document of lengths) {
        const removed = await answer(baseOf(RUST_SLOT), 'DELETE', `/indexes/${INDEX_NAME}/documents/${document.id}`)
        expect(removed.status).toBe(200)
      }

      for (const body of [
        { k1: -1 },
        { k1: 'steep' },
        { b: 2 },
        { fields: { nope: { k1: 1 } } },
        { surprise: 1 },
        [],
      ]) {
        expect(await expectSameRefusal('POST', `/indexes/${INDEX_NAME}/bm25`, body)).toBe('CONFIG_INVALID')
      }
      expect(await expectSameRefusal('POST', `/indexes/${MISSING_INDEX}/bm25`, { k1: 1 })).toBe('INDEX_NOT_FOUND')
      expect(await expectSameRefusal('POST', `/indexes/${MISSING_INDEX}/bm25`, { k1: -1 })).toBe('INDEX_NOT_FOUND')
      expect(await expectSameRefusal('POST', `/indexes/${HIDDEN_INDEX}/bm25`, { k1: 1 })).toBe('CONFIG_INVALID')
      await sameAnswer(bases(), 'POST', `/indexes/${INDEX_NAME}/bm25`, {})
    })

    it('imports NDJSON through the batch insert with the same tally, and refuses an empty body or a missing index alike', async () => {
      const lines = (prefix: string) =>
        [
          ...Array.from({ length: 5 }, (_, at) =>
            JSON.stringify({ id: `${prefix}-${at}`, title: `ledger import ${at}` }),
          ),
          '{not json',
          '[1, 2]',
        ].join('\n')
      const [typescript, rust] = await Promise.all([
        rawAnswer(baseOf(TYPESCRIPT_SLOT), 'POST', `/indexes/${INDEX_NAME}/documents/_import`, lines('typescript')),
        rawAnswer(baseOf(RUST_SLOT), 'POST', `/indexes/${INDEX_NAME}/documents/_import`, lines('rust')),
      ])
      expect(rust).toEqual(typescript)
      expect(rust.body).toEqual({
        indexed: 5,
        failed: 2,
        errors: [
          { line: 6, code: 'INVALID_JSON', message: 'Line is not valid JSON' },
          { line: 7, code: 'INVALID_REQUEST', message: 'Line is not a JSON object' },
        ],
        errorsTruncated: false,
      })
      const accepted = await rawAnswer(
        baseOf(RUST_SLOT),
        'POST',
        `/indexes/${INDEX_NAME}/documents/_import?async=true`,
        lines('rust-task'),
      )
      const record = (await finishedTask(baseOf(RUST_SLOT), accepted, SETTLE_MS)) as { status: string; result: unknown }
      expect(record.status).toBe('succeeded')
      expect(record.result).toEqual(rust.body)
      const imported = ENTRY_COUNT + 15
      await settled(
        'The imported documents did not reach the count of both nodes',
        SETTLE_MS,
        async () => Promise.all(bases().map(base => countOf(base, INDEX_NAME))),
        counts => counts.every(count => count === imported),
      )

      const refusals = await Promise.all(
        bases().map(async base => [
          await rawAnswer(base, 'POST', `/indexes/${INDEX_NAME}/documents/_import`, ''),
          await rawAnswer(base, 'POST', `/indexes/${MISSING_INDEX}/documents/_import`, lines('missing')),
          await rawAnswer(base, 'POST', `/indexes/${MISSING_INDEX}/documents/_import?async=true`, lines('missing')),
        ]),
      )
      expect(refusals[1]).toEqual(refusals[0])
      expect(refusals[1]?.map(errorCode)).toEqual(['EMPTY_BODY', 'INDEX_NOT_FOUND', 'INDEX_NOT_FOUND'])
    })

    it('rebuilds the analysis of every copy as a task that succeeds, and refuses a missing index alike', async () => {
      for (const base of bases()) {
        const accepted = await answer(base, 'POST', `/indexes/${INDEX_NAME}/_rebuild-analysis`)
        expect(accepted.body).toMatchObject({ type: 'rebuildAnalysis', indexName: INDEX_NAME })
        const record = (await finishedTask(base, accepted, SETTLE_MS)) as { status: string }
        expect(record.status).toBe('succeeded')
      }
      expect(await expectSameRefusal('POST', `/indexes/${MISSING_INDEX}/_rebuild-analysis`)).toBe('INDEX_NOT_FOUND')
    })

    it('clears an index from either node through every copy, and refuses a missing or reserved index alike', async () => {
      for (const base of bases()) {
        const filled = await answer(base, 'POST', `/indexes/${INDEX_NAME}/documents/_batch`, {
          documents: Array.from({ length: 1_200 }, (_, at) => ({ id: `bulk-${at}`, title: `ledger bulk ${at}` })),
        })
        expect(filled.status).toBe(200)
        const cleared = await answer(base, 'POST', `/indexes/${INDEX_NAME}/_clear`)
        expect(cleared).toEqual({ status: 200, body: { name: INDEX_NAME, cleared: true } })
        for (const reader of bases()) expect(await countOf(reader, INDEX_NAME)).toBe(0)
      }
      expect(await expectSameRefusal('POST', `/indexes/${MISSING_INDEX}/_clear`)).toBe('INDEX_NOT_FOUND')
      expect(await expectSameRefusal('POST', `/indexes/${HIDDEN_INDEX}/_clear`)).toBe('CONFIG_INVALID')
    })

    it('closes and opens the local copy, then takes writes again, and refuses a missing index alike', async () => {
      for (const base of bases()) {
        expect(await answer(base, 'POST', `/indexes/${INDEX_NAME}/_close`)).toEqual({
          status: 200,
          body: { name: INDEX_NAME, state: 'closed' },
        })
        const memory = (await answer(base, 'GET', '/stats/memory')).body as { closedIndexCount: number }
        expect(memory.closedIndexCount).toBe(1)
        expect(await answer(base, 'POST', `/indexes/${INDEX_NAME}/_open`)).toEqual({
          status: 200,
          body: { name: INDEX_NAME, state: 'open' },
        })
      }
      await insertEntries(baseOf(RUST_SLOT), INDEX_NAME, 3)
      await settled(
        'The writes after the reopen did not reach both nodes',
        SETTLE_MS,
        async () => Promise.all(bases().map(base => countOf(base, INDEX_NAME))),
        counts => counts.every(count => count === 3),
      )
      expect(await expectSameRefusal('POST', `/indexes/${MISSING_INDEX}/_close`)).toBe('INDEX_NOT_FOUND')
      expect(await expectSameRefusal('POST', `/indexes/${MISSING_INDEX}/_open`)).toBe('INDEX_NOT_FOUND')
    })
  },
)
