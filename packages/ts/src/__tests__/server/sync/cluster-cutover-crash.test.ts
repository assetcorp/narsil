import { afterEach, describe, expect, it } from 'vitest'
import { readRebalanceRecord, updateRebalanceRecord } from '../../../distribution/cluster/rebalance/records'
import type { AllocationTable, ClusterCoordinator } from '../../../distribution/coordinator/types'
import { createNarsil, type Narsil } from '../../../narsil'
import {
  activeTable,
  catchUp,
  documentsOf,
  type Note,
  note,
  positionMap,
  SYNC_PARTITION_COUNT,
  type SyncCluster,
  startSyncCluster,
  waitFor,
} from './cluster-fixtures'
import { archivePositions, download, openFeed, ownerHook } from './fixtures'

const SCHEMA = { schema: { title: 'string', body: 'string' } } as const
const FIRST_DOCUMENTS = 150
const TARGET_PARTITION_COUNT = 3
const DATA_NODES = ['harbour-a', 'harbour-b', 'harbour-c']
const CONTROLLER = 'harbour-office'
const NEXT_CONTROLLER = 'harbour-relief'
const SERVING_NODE = 'harbour-b'

interface HeldCutover {
  coordinator: ClusterCoordinator
  held(): number
  fail(): void
}

function holdCutoverWrite(inner: ClusterCoordinator, indexName: string): HeldCutover {
  let held = 0
  let failed = false
  const waiting: Array<(error: Error) => void> = []
  const lost = () => new Error('the controller lost its connection to the coordinator')
  const coordinator = new Proxy(inner, {
    get(target, property, receiver) {
      if (property === 'putAllocation') {
        return async (name: string, table: AllocationTable, ...rest: unknown[]): Promise<boolean> => {
          if (name === indexName && table.generation !== undefined) {
            held += 1
            if (failed) throw lost()
            await new Promise<never>((_resolve, reject) => waiting.push(reject))
          }
          const stored: boolean = await Reflect.apply(target.putAllocation, target, [name, table, ...rest])
          return stored
        }
      }
      const value: unknown = Reflect.get(target, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    coordinator,
    held: () => held,
    fail() {
      failed = true
      for (const reject of waiting.splice(0)) reject(lost())
    },
  }
}

describe.each([
  { outcome: 'resumes', partitionCount: TARGET_PARTITION_COUNT },
  { outcome: 'aborts', partitionCount: SYNC_PARTITION_COUNT },
])('a controller that dies between the cutover epoch and the allocation write, after which the change $outcome', ({
  outcome,
  partitionCount,
}) => {
  let cluster: SyncCluster | null = null
  const devices: Narsil[] = []

  afterEach(async () => {
    for (const device of devices.splice(0)) await device.shutdown()
    await cluster?.dispose()
    cluster = null
  })

  async function deviceFrom(bytes: Uint8Array): Promise<Narsil> {
    const device = await createNarsil({ workers: { enabled: false } })
    devices.push(device)
    await device.restore('alice', bytes)
    return device
  }

  async function snapshotOf(base: string) {
    return waitFor('a backup that qualifies for the snapshot', async () => {
      const answer = await download(base, 'alice', 'alice-token')
      return answer.status === 200 ? answer : null
    })
  }

  it('resyncs the connected device, and gives a fresh device every document under the new layout', async () => {
    const running = await startSyncCluster({ backups: true })
    cluster = running
    const hold = holdCutoverWrite(running.coordinator, 'alice')
    await running.start(CONTROLLER, ['coordinator', 'controller'], hold.coordinator)
    for (const nodeId of DATA_NODES) await running.start(nodeId, ['data', 'coordinator'])
    const base = await running.serve(SERVING_NODE, ownerHook())

    const oracle = new Map<string, Note>()
    await running.admin.createIndex('alice', SCHEMA)
    await activeTable(running.coordinator, 'alice')
    const batch = Array.from({ length: FIRST_DOCUMENTS }, (_, at) => ({ id: `n${at}`, ...note(at) }))
    for (let at = 0; at < FIRST_DOCUMENTS; at++) oracle.set(`n${at}`, note(at))
    expect((await running.admin.insertBatch('alice', batch)).failed).toEqual([])
    await running.admin.updateSync('alice', { enabled: true })

    const first = await snapshotOf(base)
    const firstEpoch = (await running.node(SERVING_NODE).getSync('alice')).epoch
    const connected = await openFeed(base, 'alice', 'alice-token')
    connected.send({ type: 'subscribe', epoch: firstEpoch, positions: await archivePositions(first.bytes) })
    await connected.next('subscribed')

    const changing = running
      .node(SERVING_NODE)
      .rebalance('alice', TARGET_PARTITION_COUNT)
      .catch(() => undefined)
    await waitFor('the controller to write the cutover epoch and reach the allocation write', async () => {
      const epoch = (await running.node(SERVING_NODE).getSync('alice')).epoch
      return hold.held() > 0 && epoch !== firstEpoch
    })
    expect((await connected.next('resync')).reason).toBe('epoch')
    expect((await connected.closed).code).toBe(4410)

    hold.fail()
    await running.stop(CONTROLLER)
    if (outcome === 'aborts') {
      const record = await readRebalanceRecord(running.coordinator, 'alice')
      if (record === null) throw new Error('the partition count change left no record')
      await updateRebalanceRecord(running.coordinator, 'alice', record.jobId, current => ({
        ...current,
        phase: 'aborting',
      }))
    }
    await running.start(NEXT_CONTROLLER, ['coordinator', 'controller'])
    await waitFor('the partition count change to finish', async () => {
      if ((await readRebalanceRecord(running.coordinator, 'alice')) !== null) return false
      const served = (await running.coordinator.getAllocation('alice'))?.generation ?? 'alice'
      const table = await running.coordinator.getAllocation(served)
      return table?.assignments.size === partitionCount
    })
    await changing

    for (let at = FIRST_DOCUMENTS; at < FIRST_DOCUMENTS + 20; at++) {
      oracle.set(`n${at}`, note(at))
      await running.admin.put('alice', `n${at}`, note(at))
    }
    for (let at = 0; at < 10; at++) {
      oracle.delete(`n${at}`)
      await running.admin.remove('alice', `n${at}`)
    }

    const status = await running.node(SERVING_NODE).getSync('alice')
    expect(status.epoch).not.toBe(firstEpoch)
    const fresh = await snapshotOf(base)
    const positions = await archivePositions(fresh.bytes)
    expect(positions.map(position => position.partitionId)).toEqual(
      Array.from({ length: partitionCount }, (_, at) => at),
    )
    const device = await deviceFrom(fresh.bytes)
    const feed = await openFeed(base, 'alice', 'alice-token')
    feed.send({ type: 'subscribe', epoch: status.epoch, positions })
    expect((await feed.next('subscribed')).partitionCount).toBe(partitionCount)
    await catchUp(feed, device, 'alice', positionMap(positions))
    expect(await documentsOf(device, 'alice')).toEqual(oracle)
    feed.close()
  }, 120_000)
})
