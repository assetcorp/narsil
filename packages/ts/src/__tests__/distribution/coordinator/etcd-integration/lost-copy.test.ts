import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ClusterNode } from '../../../../distribution/cluster-node/types'
import type { PartitionAssignment } from '../../../../distribution/coordinator/types'
import { createNarsil } from '../../../../narsil'
import {
  type EtcdContainerHandle,
  eventually,
  MANAGED_ETCD_ENDPOINT,
  makeNodeRegistration,
  runDocker,
  startEtcdContainer,
  stopEtcdContainer,
  waitForEtcdReady,
} from './fixtures'
import { createLinkedCluster, type LinkedCluster, type LinkedMember } from './linked-cluster'

const INDEX = 'catalogue'
const CONFIG = { language: 'english', schema: { title: 'string' } } as const
const SETTLED_WITHIN_MS = 60_000
const NOTHING_CHANGES_FOR_MS = 4_000
const SHUTDOWN_WITHIN_MS = 15_000
const PRODUCTS = new Map(
  Array.from({ length: 24 }, (_, at): [string, string] => [`product-${at}`, `cedar shelf ${at}`]),
)

const active = (assignment: PartitionAssignment) => assignment.state === 'ACTIVE'
const replicated = (assignment: PartitionAssignment) => active(assignment) && assignment.inSyncSet.length === 1
const unassigned = (assignment: PartitionAssignment) => assignment.state === 'UNASSIGNED'

async function seedProducts(node: ClusterNode): Promise<void> {
  const documents = [...PRODUCTS].map(([id, title]) => ({ id, title }))
  expect((await node.insertBatch(INDEX, documents)).failed).toEqual([])
}

async function expectEveryProduct(node: ClusterNode): Promise<void> {
  await eventually(
    async () => {
      const stored = await node.getMultiple(INDEX, [...PRODUCTS.keys()])
      expect(new Map([...stored].map(([id, document]) => [id, document.title]))).toEqual(PRODUCTS)
      expect(await node.countDocuments(INDEX)).toBe(PRODUCTS.size)
    },
    SETTLED_WITHIN_MS,
    'an acknowledged product is missing',
  )
}

async function expectNoEmptyCopy(node: ClusterNode): Promise<void> {
  await expect(node.countDocuments(INDEX)).rejects.toMatchObject({ code: 'QUERY_NO_ACTIVE_REPLICA' })
  await expect(node.insert(INDEX, { title: 'oak bench' }, 'bench')).rejects.toMatchObject({
    code: 'PARTITION_UNASSIGNED',
  })
}

function missingPartitions(member: LinkedMember): unknown[] {
  return member.errors
    .filter(error => error.code === 'NODE_COPY_MISSING')
    .map(error => {
      expect(error.details).toMatchObject({ indexName: INDEX })
      return error.details.partitionId
    })
    .sort()
}

describe('a node that returns without the copy that the cluster assigns to it', () => {
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

  async function newCluster(): Promise<LinkedCluster> {
    if (container === null) throw new Error('etcd is not available')
    cluster = await createLinkedCluster(container.endpoint)
    return cluster
  }

  async function replicatedIndex() {
    const linked = await newCluster()
    const controller = await linked.start('depot-controller', ['controller'])
    const router = await linked.start('depot-router', ['coordinator'])
    const first = await linked.start('depot-first', ['data'])
    const second = await linked.start('depot-second', ['data'])
    await router.node.createIndex(INDEX, CONFIG, { partitionCount: 2, replicationFactor: 1 })
    await linked.waitForPartitions(INDEX, replicated, SETTLED_WITHIN_MS, 'the index was never replicated')
    await seedProducts(router.node)
    return { linked, controller, router, first, second }
  }

  async function singleCopyIndex() {
    const linked = await newCluster()
    const controller = await linked.start('depot-controller', ['controller'])
    const router = await linked.start('depot-router', ['coordinator'])
    const holder = await linked.start('depot-holder', ['data'])
    await router.node.createIndex(INDEX, CONFIG, { partitionCount: 1, replicationFactor: 0 })
    await linked.waitForPartitions(INDEX, active, SETTLED_WITHIN_MS, 'the index never became active')
    await seedProducts(router.node)
    return { linked, controller, router, holder }
  }

  async function waitingWithoutCopy(linked: LinkedCluster, nodeId: string, partitions: number[]) {
    const waiting = await linked.launch(nodeId, ['data'], { storage: `${nodeId}-empty` })
    await eventually(
      async () => expect(missingPartitions(waiting)).toEqual(partitions),
      SETTLED_WITHIN_MS,
      'the node never reported its missing copy',
    )
    return waiting
  }

  async function expectUnregistered(linked: LinkedCluster, nodeId: string): Promise<void> {
    expect((await linked.observer.listNodes()).map(node => node.nodeId)).not.toContain(nodeId)
  }

  it('waits through an outage until the controller fails over, and keeps every acknowledged write', async () => {
    const { linked, controller, router, first, second } = await replicatedIndex()
    await controller.stop()
    await first.stop()

    const returned = await waitingWithoutCopy(linked, 'depot-first', [0, 1])
    returned.coordinatorLink.cut()
    await sleep(NOTHING_CHANGES_FOR_MS)
    returned.coordinatorLink.restore()
    await expectUnregistered(linked, 'depot-first')
    expect(missingPartitions(returned)).toEqual([0, 1])

    await linked.start('depot-controller', ['controller'])
    await returned.started
    await linked.waitForPartitions(INDEX, replicated, SETTLED_WITHIN_MS, 'the returned node never caught up')
    await expectEveryProduct(router.node)

    await second.stop()
    await linked.waitForPartitions(
      INDEX,
      assignment => active(assignment) && assignment.primary === 'depot-first',
      SETTLED_WITHIN_MS,
      'the returned node never took the lead',
    )
    await expectEveryProduct(router.node)
  }, 240_000)

  it('keeps every write through the loss of all data nodes and gives the partitions back to intact disks', async () => {
    const { linked, router, first, second } = await replicatedIndex()
    await first.stop()
    await second.stop()
    const lost = await linked.waitForPartitions(INDEX, unassigned, SETTLED_WITHIN_MS, 'a lost partition kept a primary')
    for (const assignment of lost) expect(assignment.lastHolders).toContain('depot-second')

    const empty = await linked.start('depot-second', ['data'], { storage: 'depot-second-empty' })
    await sleep(NOTHING_CHANGES_FOR_MS)
    await linked.waitForPartitions(INDEX, unassigned, SETTLED_WITHIN_MS, 'an empty copy took a partition')
    await expectNoEmptyCopy(router.node)
    await empty.stop()

    await linked.start('depot-second', ['data'])
    await linked.waitForPartitions(INDEX, active, SETTLED_WITHIN_MS, 'the intact copy never came back')
    await expectEveryProduct(router.node)
  }, 240_000)

  it('serves every write after a whole cluster restarts on intact disks, controller first', async () => {
    const { linked, controller, router, first, second } = await replicatedIndex()
    await controller.stop()
    await first.stop()
    await second.stop()

    await linked.start('depot-controller', ['controller'])
    await linked.waitForPartitions(INDEX, unassigned, SETTLED_WITHIN_MS, 'the controller kept departed primaries')
    const returned = [await linked.start('depot-first', ['data']), await linked.start('depot-second', ['data'])]
    await linked.waitForPartitions(INDEX, replicated, SETTLED_WITHIN_MS, 'the cluster never recovered')
    await expectEveryProduct(router.node)
    for (const member of returned) expect(missingPartitions(member)).toEqual([])
  }, 240_000)

  it('restarts at once on an intact disk while no controller exists', async () => {
    const { linked, controller, router, holder } = await singleCopyIndex()
    await controller.stop()
    await holder.stop()

    const restarted = await linked.start('depot-holder', ['data'])
    await expectEveryProduct(router.node)
    expect(missingPartitions(restarted)).toEqual([])
  }, 180_000)

  it('lets a sole node of every role register without data and recover from its directory later', async () => {
    const linked = await newCluster()
    const roles = ['data', 'coordinator', 'controller'] as const
    const sole = await linked.start('depot-sole', roles)
    await sole.node.createIndex(INDEX, CONFIG, { partitionCount: 1, replicationFactor: 0 })
    await linked.waitForPartitions(INDEX, active, SETTLED_WITHIN_MS, 'the index never became active')
    await seedProducts(sole.node)
    await sole.stop()

    const memoryOnly = await linked.start('depot-sole', roles, { storage: null })
    expect(missingPartitions(memoryOnly)).toEqual([0])
    await linked.waitForPartitions(INDEX, unassigned, SETTLED_WITHIN_MS, 'an empty copy took the partition')
    await sleep(NOTHING_CHANGES_FOR_MS)
    await expectNoEmptyCopy(memoryOnly.node)
    await memoryOnly.stop()

    const restored = await linked.start('depot-sole', roles)
    await linked.waitForPartitions(INDEX, active, SETTLED_WITHIN_MS, 'the intact copy never came back')
    await expectEveryProduct(restored.node)
  }, 180_000)

  it('waits for the registration of a crashed process to lapse before it fails the copy over', async () => {
    const { linked, router, holder } = await singleCopyIndex()
    holder.coordinatorLink.cut()
    await holder.stop()

    const returned = await linked.start('depot-holder', ['data'], { storage: 'depot-holder-empty' })
    await linked.waitForPartitions(INDEX, unassigned, SETTLED_WITHIN_MS, 'the crashed primary kept its partition')
    await sleep(NOTHING_CHANGES_FOR_MS)
    await expectNoEmptyCopy(router.node)
    await returned.stop()

    await linked.start('depot-holder', ['data'])
    await linked.waitForPartitions(INDEX, active, SETTLED_WITHIN_MS, 'the intact copy never came back')
    await expectEveryProduct(router.node)
  }, 240_000)

  it('ends the wait when the node shuts down during a coordinator outage', async () => {
    const { linked, controller, holder } = await singleCopyIndex()
    await controller.stop()
    await holder.stop()

    const waiting = await waitingWithoutCopy(linked, 'depot-holder', [0])
    waiting.coordinatorLink.cut()
    const stopping = waiting.stop()
    const outcome = await Promise.race([stopping.then(() => 'stopped'), sleep(SHUTDOWN_WITHIN_MS, 'hanging')])
    expect(outcome).toBe('stopped')
    await expect(waiting.started).rejects.toMatchObject({ code: 'NODE_NOT_JOINED' })
    await expectUnregistered(linked, 'depot-holder')
  }, 180_000)

  it('registers once an operator drops the index that it waits for', async () => {
    const { linked, controller, router, holder } = await singleCopyIndex()
    await controller.stop()
    await holder.stop()

    const waiting = await waitingWithoutCopy(linked, 'depot-holder', [0])
    router.node.dropIndex(INDEX).catch(() => undefined)
    await waiting.started
    expect((await linked.observer.listNodes()).map(node => node.nodeId)).toContain('depot-holder')
  }, 180_000)

  it('fails a partition over where only nodes of another major version are registered', async () => {
    const { linked, controller, router, holder } = await singleCopyIndex()
    await linked.observer.registerNode(makeNodeRegistration({ nodeId: 'depot-newer', roles: ['data'], version: '2.0' }))
    await holder.stop()

    const [lost] = await linked.waitForPartitions(
      INDEX,
      unassigned,
      SETTLED_WITHIN_MS,
      'the lost primary kept the lead',
    )
    expect(lost.lastHolders).toEqual(['depot-holder'])
    await expectNoEmptyCopy(router.node)
    expect(controller.errors.map(error => error.code)).not.toContain('ALLOCATION_NO_DATA_NODES')
  }, 180_000)

  it('counts a copy that records no held partitions as a copy of every partition', async () => {
    const { linked, controller, router, holder } = await singleCopyIndex()
    await controller.stop()
    await holder.stop()
    const earlier = await createNarsil({
      workers: { enabled: false },
      durability: { directory: linked.directoryOf('depot-holder-earlier'), mode: 'sync' },
    })
    await earlier.createIndex(INDEX, CONFIG)
    for (const [id, title] of PRODUCTS) await earlier.insert(INDEX, { id, title }, id)
    await earlier.shutdown()

    const restarted = await linked.start('depot-holder', ['data'], { storage: 'depot-holder-earlier' })
    await expectEveryProduct(router.node)
    expect(missingPartitions(restarted)).toEqual([])
  }, 180_000)
})
