import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import type { AnyDocument } from '../../../../types/schema'
import {
  type EtcdContainerHandle,
  eventually,
  MANAGED_ETCD_ENDPOINT,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from './fixtures'
import { createLinkedCluster, type LinkedCluster, type LinkedMember } from './linked-cluster'

const INDEX = 'catalogue'
const CONFIG = { language: 'english', schema: { title: 'string' } } as const
const SETTLED_WITHIN_MS = 30_000
const UNANSWERED_FOR_MS = 2_500
const WATCH_DELIVERED_MS = 750
const RETRY_WINDOW_MS = 30_000
const WINDOW_MARGIN_MS = 3_000
const SHUTDOWN_WITHIN_MS = 10_000
const REFUSED_WHILE_INITIALISING = { code: 'PARTITION_NOT_PRIMARY', state: 'INITIALISING' }
const REFUSED_AS_DUPLICATE = { code: 'DOC_ALREADY_EXISTS', state: undefined }

interface Answer {
  write: string
  refusals: Array<{ code: unknown; state: unknown }>
  acknowledged?: string[]
}

function refusalOf(error: unknown): { code: unknown; state: unknown } {
  const { code, details } = error as { code?: unknown; details?: { state?: unknown } }
  return { code, state: details?.state }
}

async function singleAnswer(write: string, writing: Promise<unknown>): Promise<Answer> {
  return writing.then(
    () => ({ write, refusals: [] }),
    error => ({ write, refusals: [refusalOf(error)] }),
  )
}

async function batchAnswer(
  write: string,
  writing: Promise<{ succeeded: string[]; failed: Array<{ error: unknown }> }>,
): Promise<Answer> {
  return writing.then(
    result => ({
      write,
      refusals: result.failed.map(failure => refusalOf(failure.error)),
      acknowledged: result.succeeded,
    }),
    error => ({ write, refusals: [refusalOf(error)] }),
  )
}

function seededDocuments(origin: string): AnyDocument[] {
  return [
    'updated',
    'removed',
    'batch-updated-a',
    'batch-updated-b',
    'batch-removed-a',
    'batch-removed-b',
    'existing-equal',
    'existing-different',
    'batch-existing-equal',
    'batch-existing-different',
  ].map(name => ({ id: `${origin}-${name}`, title: `${origin} original` }))
}

function writesOfEveryKind(node: ClusterNode, origin: string): Array<Promise<Answer>> {
  const title = `${origin} replacement`
  const original = `${origin} original`
  return [
    singleAnswer(
      `${origin} equal duplicate`,
      node.insert(INDEX, { id: `${origin}-existing-equal`, title: original }, `${origin}-existing-equal`),
    ),
    singleAnswer(
      `${origin} different duplicate`,
      node.insert(INDEX, { id: `${origin}-existing-different`, title }, `${origin}-existing-different`),
    ),
    batchAnswer(
      `${origin} duplicate insert batch`,
      node.insertBatch(INDEX, [
        { id: `${origin}-batch-existing-equal`, title: original },
        { id: `${origin}-batch-existing-different`, title },
      ]),
    ),
    batchAnswer(
      `${origin} repeated insert batch`,
      node.insertBatch(INDEX, [
        { id: `${origin}-repeated`, title },
        { id: `${origin}-repeated`, title: `${origin} repeat` },
      ]),
    ),
    singleAnswer(`${origin} insert`, node.insert(INDEX, { title }, `${origin}-inserted`)),
    singleAnswer(`${origin} update`, node.update(INDEX, `${origin}-updated`, { title })),
    singleAnswer(`${origin} remove`, node.remove(INDEX, `${origin}-removed`)),
    batchAnswer(
      `${origin} insert batch`,
      node.insertBatch(INDEX, [
        { id: `${origin}-batch-inserted-a`, title },
        { id: `${origin}-batch-inserted-b`, title },
      ]),
    ),
    batchAnswer(
      `${origin} update batch`,
      node.updateBatch(INDEX, [
        { docId: `${origin}-batch-updated-a`, document: { title } },
        { docId: `${origin}-batch-updated-b`, document: { title } },
      ]),
    ),
    batchAnswer(
      `${origin} remove batch`,
      node.removeBatch(INDEX, [`${origin}-batch-removed-a`, `${origin}-batch-removed-b`]),
    ),
  ]
}

function titlesBeforeWrites(): Map<string, string> {
  return new Map(
    ['local', 'forwarded'].flatMap(origin =>
      seededDocuments(origin).map((document): [string, string] => [String(document.id), `${origin} original`]),
    ),
  )
}

function titlesAfterWrites(): Map<string, string> {
  return new Map(
    ['local', 'forwarded'].flatMap(origin => [
      ...[
        'inserted',
        'updated',
        'repeated',
        'batch-inserted-a',
        'batch-inserted-b',
        'batch-updated-a',
        'batch-updated-b',
      ].map((name): [string, string] => [`${origin}-${name}`, `${origin} replacement`]),
      ...['existing-equal', 'existing-different', 'batch-existing-equal', 'batch-existing-different'].map(
        (name): [string, string] => [`${origin}-${name}`, `${origin} original`],
      ),
    ]),
  )
}

function answersOnceActive(origin: string): Answer[] {
  return [
    { write: `${origin} equal duplicate`, refusals: [REFUSED_AS_DUPLICATE] },
    { write: `${origin} different duplicate`, refusals: [REFUSED_AS_DUPLICATE] },
    {
      write: `${origin} duplicate insert batch`,
      refusals: [REFUSED_AS_DUPLICATE, REFUSED_AS_DUPLICATE],
      acknowledged: [],
    },
    {
      write: `${origin} repeated insert batch`,
      refusals: [REFUSED_AS_DUPLICATE],
      acknowledged: [`${origin}-repeated`],
    },
    { write: `${origin} insert`, refusals: [] },
    { write: `${origin} update`, refusals: [] },
    { write: `${origin} remove`, refusals: [] },
    {
      write: `${origin} insert batch`,
      refusals: [],
      acknowledged: [`${origin}-batch-inserted-a`, `${origin}-batch-inserted-b`],
    },
    {
      write: `${origin} update batch`,
      refusals: [],
      acknowledged: [`${origin}-batch-updated-a`, `${origin}-batch-updated-b`],
    },
    {
      write: `${origin} remove batch`,
      refusals: [],
      acknowledged: [`${origin}-batch-removed-a`, `${origin}-batch-removed-b`],
    },
  ]
}

async function expectTitles(node: ClusterNode, expected: ReadonlyMap<string, string>): Promise<void> {
  const ids = new Set([...titlesBeforeWrites().keys(), ...titlesAfterWrites().keys()])
  const stored = await node.getMultiple(INDEX, [...ids])
  expect(new Map([...stored].map(([id, document]) => [id, document.title]))).toEqual(expected)
  expect(await node.countDocuments(INDEX)).toBe(expected.size)
}

describe('writes to a partition that is INITIALISING', () => {
  let container: EtcdContainerHandle | null = null
  let cluster: LinkedCluster | undefined

  beforeAll(async () => {
    if (MANAGED_ETCD_ENDPOINT !== null) {
      container = { endpoint: MANAGED_ETCD_ENDPOINT, name: null }
      await waitForEtcdReady(MANAGED_ETCD_ENDPOINT)
      return
    }
    await runDocker(['version'])
    container = await startEtcdContainer()
  }, 90_000)

  afterEach(async () => {
    await cluster?.dispose()
    cluster = undefined
  }, 90_000)

  afterAll(async () => {
    await stopEtcdContainer(container?.name ?? null)
    container = null
  }, 60_000)

  async function startCluster(): Promise<{ linked: LinkedCluster; controller: LinkedMember; router: LinkedMember }> {
    if (container === null) throw new Error('etcd is not available')
    const linked = await createLinkedCluster(container.endpoint)
    cluster = linked
    const controller = await linked.start('depot-controller', ['controller'])
    const router = await linked.start('depot-router', ['coordinator'])
    return { linked, controller, router }
  }

  async function stoppedAndUnassigned(linked: LinkedCluster, holder: LinkedMember): Promise<void> {
    await holder.stop()
    const spare = await linked.start('depot-spare', ['data'])
    await linked.waitForPartitions(
      INDEX,
      assignment => assignment.state === 'UNASSIGNED',
      SETTLED_WITHIN_MS,
      'the stopped holder kept its partition',
    )
    await spare.stop()
  }

  async function promotedWhileTheControllerIsUnreachable() {
    const { linked, controller, router } = await startCluster()
    const holder = await linked.start('depot-holder', ['data', 'coordinator'])
    await router.node.createIndex(INDEX, CONFIG, { partitionCount: 1, replicationFactor: 0 })
    await linked.waitForPartitions(
      INDEX,
      assignment => assignment.state === 'ACTIVE',
      SETTLED_WITHIN_MS,
      'the index never became active',
    )
    const seeded = await router.node.insertBatch(INDEX, [...seededDocuments('local'), ...seededDocuments('forwarded')])
    expect(seeded.failed).toEqual([])
    await stoppedAndUnassigned(linked, holder)

    controller.peerLink.cut()
    const promoted = await linked.start('depot-holder', ['data', 'coordinator'])
    await linked.waitForPartitions(
      INDEX,
      assignment => assignment.state === 'INITIALISING' && assignment.primary === 'depot-holder',
      SETTLED_WITHIN_MS,
      'the last holder was never promoted',
    )
    return { linked, controller, router, promoted }
  }

  it('loses no acknowledged write when the primary fails before the partition ever served', async () => {
    const { linked, controller, router } = await startCluster()
    const first = await linked.start('depot-first', ['data', 'coordinator'])
    controller.peerLink.cut()
    await router.node.createIndex(INDEX, CONFIG, { partitionCount: 1, replicationFactor: 0, waitForServingMs: 0 })
    await eventually(
      async () => expect(controller.peerLink.refusedConnections()).toBeGreaterThan(0),
      SETTLED_WITHIN_MS,
      'the primary never prepared its copy',
    )

    const writing = singleAnswer('insert', first.node.insert(INDEX, { title: 'cedar shelf' }, 'shelf'))
    await sleep(UNANSWERED_FOR_MS)
    await linked.start('depot-successor', ['data', 'coordinator'])
    const stoppingAt = Date.now()
    await first.stop()
    const stoppedAfterMs = Date.now() - stoppingAt
    const answer = await writing

    await linked.waitForPartitions(
      INDEX,
      assignment => assignment.primary === 'depot-successor',
      SETTLED_WITHIN_MS,
      'no other node took the partition',
    )
    controller.peerLink.restore()
    await linked.waitForPartitions(
      INDEX,
      assignment => assignment.state === 'ACTIVE',
      SETTLED_WITHIN_MS,
      'the successor never served the partition',
    )

    if (answer.refusals.length === 0) {
      expect(await router.node.get(INDEX, 'shelf'), 'an acknowledged write is missing after the failover').toBeDefined()
    }
    expect(answer.refusals).toEqual([REFUSED_WHILE_INITIALISING])
    expect(stoppedAfterMs).toBeLessThan(SHUTDOWN_WITHIN_MS)
    expect(await router.node.get(INDEX, 'shelf')).toBeUndefined()
    await router.node.insert(INDEX, { title: 'cedar shelf' }, 'shelf')
    expect(await router.node.get(INDEX, 'shelf')).toMatchObject({ title: 'cedar shelf' })
  }, 180_000)

  it('holds every kind of write until a promoted last holder is ACTIVE, and then applies each', async () => {
    const { linked, controller, router, promoted } = await promotedWhileTheControllerIsUnreachable()
    let answered = 0
    const writing = [...writesOfEveryKind(promoted.node, 'local'), ...writesOfEveryKind(router.node, 'forwarded')].map(
      pending =>
        pending.then(answer => {
          answered += 1
          return answer
        }),
    )
    await sleep(UNANSWERED_FOR_MS)
    expect(answered, 'a write was answered while its partition was INITIALISING').toBe(0)

    controller.peerLink.restore()
    expect(await Promise.all(writing)).toEqual([...answersOnceActive('local'), ...answersOnceActive('forwarded')])
    await linked.waitForPartitions(
      INDEX,
      assignment => assignment.state === 'ACTIVE',
      SETTLED_WITHIN_MS,
      'the promoted holder never served the partition',
    )
    await expectTitles(router.node, titlesAfterWrites())
  }, 180_000)

  it('answers every kind of write with the last refusal when the retry window ends', async () => {
    const { linked, controller, router, promoted } = await promotedWhileTheControllerIsUnreachable()
    const startedAt = Date.now()
    const answers = await Promise.all([
      ...writesOfEveryKind(promoted.node, 'local'),
      ...writesOfEveryKind(router.node, 'forwarded'),
    ])
    const answeredAfterMs = Date.now() - startedAt

    for (const answer of answers) {
      const operations = answer.write.endsWith('batch') ? 2 : 1
      expect(answer.refusals, answer.write).toEqual(Array(operations).fill(REFUSED_WHILE_INITIALISING))
    }
    expect(answeredAfterMs).toBeGreaterThanOrEqual(RETRY_WINDOW_MS - WINDOW_MARGIN_MS)
    expect(answeredAfterMs).toBeLessThan(RETRY_WINDOW_MS + WINDOW_MARGIN_MS)

    await stoppedAndUnassigned(linked, promoted)
    controller.peerLink.restore()
    await linked.start('depot-holder', ['data', 'coordinator'])
    await linked.waitForPartitions(
      INDEX,
      assignment => assignment.state === 'ACTIVE',
      SETTLED_WITHIN_MS,
      'the restarted holder never served the partition',
    )
    await expectTitles(router.node, titlesBeforeWrites())
  }, 180_000)

  it('takes a write on every node straight after createIndex on a healthy cluster', async () => {
    const { linked, router } = await startCluster()
    const first = await linked.start('depot-first', ['data', 'coordinator'])
    const second = await linked.start('depot-second', ['data', 'coordinator'])
    await first.node.createIndex(INDEX, CONFIG, { partitionCount: 4, replicationFactor: 1 })

    const writers = [first, second, router]
    const answers = await Promise.all(
      writers.flatMap(({ node }) => [
        singleAnswer(`${node.nodeId} insert`, node.insert(INDEX, { title: 'cedar shelf' }, `${node.nodeId}-single`)),
        batchAnswer(
          `${node.nodeId} insert batch`,
          node.insertBatch(INDEX, [
            { id: `${node.nodeId}-batch-a`, title: 'oak bench' },
            { id: `${node.nodeId}-batch-b`, title: 'oak bench' },
          ]),
        ),
      ]),
    )
    for (const answer of answers) expect(answer.refusals, answer.write).toEqual([])
    expect(await router.node.countDocuments(INDEX)).toBe(writers.length * 3)
  }, 120_000)

  it('copies no document into a starting target partition, and finishes the rebalance once it is ACTIVE', async () => {
    const { linked, controller, router } = await startCluster()
    const source = await linked.start('depot-source', ['data', 'coordinator'])
    await router.node.createIndex(INDEX, CONFIG, { partitionCount: 2, replicationFactor: 0 })
    const documents = Array.from({ length: 40 }, (_, at) => ({ id: `item-${at}`, title: `cedar shelf ${at}` }))
    expect((await router.node.insertBatch(INDEX, documents)).failed).toEqual([])

    const target = await linked.start('depot-target', ['data', 'coordinator'])
    target.peerLink.cut()
    const rebalanced = router.node.rebalance(INDEX, 4).then(
      () => null,
      (error: unknown) => error,
    )
    let generation = ''
    await eventually(
      async () => {
        generation = (await linked.observer.listSchemas()).find(name => name.startsWith('narsil-generation-')) ?? ''
        expect(generation).not.toBe('')
      },
      SETTLED_WITHIN_MS,
      'the rebalance never created its target',
    )
    const placed = await linked.waitForPartitions(
      generation,
      assignment => assignment.state === 'ACTIVE',
      SETTLED_WITHIN_MS,
      'the target never became active',
    )
    expect(placed.map(assignment => assignment.primary)).toContain('depot-target')
    const refusedBefore = target.peerLink.refusedConnections()
    await eventually(
      async () => expect(target.peerLink.refusedConnections()).toBeGreaterThan(refusedBefore),
      SETTLED_WITHIN_MS,
      'the source never started its copy',
    )

    async function writeTargetState(state: 'ACTIVE' | 'INITIALISING'): Promise<void> {
      await eventually(
        async () => {
          const table = await linked.observer.getAllocation(generation)
          if (table === null) throw new Error('the target has no table')
          const assignments = new Map(
            [...table.assignments].map(([partitionId, assignment]) => [
              partitionId,
              assignment.primary === 'depot-target' ? { ...assignment, state } : assignment,
            ]),
          )
          const writer = (await linked.observer.getLeaseHolder('_narsil/controller')) ?? ''
          const next = { ...table, version: table.version + 1, assignments }
          expect(await linked.observer.putAllocation(generation, next, table.version, writer)).toBe(true)
        },
        SETTLED_WITHIN_MS,
        `the target's state never became ${state}`,
      )
    }

    controller.peerLink.cut()
    await writeTargetState('INITIALISING')
    await sleep(WATCH_DELIVERED_MS)
    target.peerLink.restore()
    await eventually(
      async () => expect(source.errors.map(refusalOf)).toContainEqual(REFUSED_WHILE_INITIALISING),
      SETTLED_WITHIN_MS,
      'the starting target took copied documents',
    )

    await writeTargetState('ACTIVE')
    controller.peerLink.restore()
    expect(await rebalanced).toBeNull()
    const stored = await router.node.getMultiple(
      INDEX,
      documents.map(document => document.id),
    )
    expect(new Map([...stored].map(([id, document]) => [id, document.title]))).toEqual(
      new Map(documents.map(document => [document.id, document.title])),
    )
    expect(await router.node.countDocuments(INDEX)).toBe(documents.length)
  }, 180_000)
})
