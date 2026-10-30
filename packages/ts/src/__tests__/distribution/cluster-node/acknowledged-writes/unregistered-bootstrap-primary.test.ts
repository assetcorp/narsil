import { afterEach, describe, expect, it } from 'vitest'
import type { ClusterCoordinator, NodeRegistration } from '../../../../distribution/coordinator/types'
import { NarsilError } from '../../../../errors'
import {
  createTestCluster,
  INDEX,
  partitionAssignment,
  readCopy,
  SCHEMA,
  type TestCluster,
  waitForCopies,
  waitUntil,
} from './harness'

const DOCUMENTS = 25

function hidingRegistration(inner: ClusterCoordinator, hiddenNodeId: string) {
  let hidden = true
  const coordinator = new Proxy(inner, {
    get(target, property, receiver) {
      if (property !== 'listNodes') return Reflect.get(target, property, receiver)
      return async (): Promise<NodeRegistration[]> => {
        const nodes = await target.listNodes()
        return hidden ? nodes.filter(node => node.nodeId !== hiddenNodeId) : nodes
      }
    },
  })
  return {
    coordinator,
    reveal() {
      hidden = false
    },
  }
}

function innerCodeOf(error: Error): unknown {
  return error instanceof NarsilError ? error.details.innerCode : undefined
}

describe('a replica that bootstraps from a primary the coordinator holds no registration for', () => {
  let cluster: TestCluster

  afterEach(async () => {
    await cluster.dispose()
  })

  it('reports that no transport target exists, then bootstraps once the registration returns', async () => {
    cluster = await createTestCluster()
    await cluster.start('controller', { roles: ['controller', 'coordinator'], durable: false })
    await cluster.start('node-a', { durable: false })
    await cluster.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 1 })
    await waitForCopies(cluster.coordinator, 'node-a', [])
    for (let i = 0; i < DOCUMENTS; i++) {
      await cluster.node('node-a').insert(INDEX, { title: `deposit ${i}`, amount: i }, `account-${i}`)
    }

    const view = hidingRegistration(cluster.coordinator, 'node-a')
    const errors: Error[] = []
    await cluster.start('node-b', {
      durable: false,
      coordinator: view.coordinator,
      onError: error => errors.push(error),
    })

    await waitUntil('node-b to report that it found no transport target for node-a', () =>
      errors.some(error => innerCodeOf(error) === 'SNAPSHOT_SYNC_NO_TARGETS'),
    )
    expect(partitionAssignment(await cluster.coordinator.getAllocation(INDEX))?.inSyncSet).not.toContain('node-b')

    view.reveal()
    await waitForCopies(cluster.coordinator, 'node-a', ['node-b'], 30_000)
    expect(Object.fromEntries(await readCopy(cluster.probe, 'node-b'))).toEqual(
      Object.fromEntries(await readCopy(cluster.probe, 'node-a')),
    )
    expect((await readCopy(cluster.probe, 'node-b')).size).toBe(DOCUMENTS)
  }, 60_000)
})
