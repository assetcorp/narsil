import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { createTestCluster, INDEX, readCopy, SCHEMA, type TestCluster, waitUntil } from './harness'

let cluster: TestCluster | undefined

afterEach(async () => {
  await cluster?.dispose()
  cluster = undefined
})

it('sends no expired write to a fallback address after the first connection fails', async () => {
  const running = await createTestCluster()
  cluster = running
  await running.start('controller', { roles: ['controller', 'coordinator'], durable: false })
  await running.start('primary', { durable: false, address: 'unreachable-primary' })
  await running.node('controller').createIndex(INDEX, { schema: SCHEMA }, { partitionCount: 1, replicationFactor: 0 })
  const original = { title: 'acknowledged transfer', amount: 10 }
  const existing = ['update-one', 'remove-one', 'update-batch-a', 'update-batch-b', 'remove-batch-a', 'remove-batch-b']
  for (const id of existing) await running.node('primary').insert(INDEX, original, id)

  await running.start('router', { roles: ['coordinator'], durable: false })
  let connecting = 0
  const stopFailing = running.transport('router').failSlowlyWhen((target, message) => {
    if (target !== 'unreachable-primary' || !message.type.startsWith('replication.forward')) return false
    connecting++
    return true
  }, 31_000)
  const arrivals = running
    .transport('primary')
    .recordArrivalsWhen((_target, message) => message.type.startsWith('replication.forward'))
  const router = running.node('router')
  const changed = { title: 'expired transfer', amount: 99 }
  const singles = [
    router.insert(INDEX, changed, 'insert-one'),
    router.update(INDEX, 'update-one', changed),
    router.remove(INDEX, 'remove-one'),
  ].map(write => write.catch((error: unknown) => error))
  const batches = [
    router.insertBatch(INDEX, [
      { id: 'insert-batch-a', ...changed },
      { id: 'insert-batch-b', ...changed },
    ]),
    router.updateBatch(INDEX, [
      { docId: 'update-batch-a', document: changed },
      { docId: 'update-batch-b', document: changed },
    ]),
    router.removeBatch(INDEX, ['remove-batch-a', 'remove-batch-b']),
  ]
  try {
    await waitUntil('every write to wait for its first connection', () => connecting >= 6)
    const expired = { code: 'REPLICATION_OUTCOME_UNKNOWN', details: { reason: 'forward_window_ended' } }
    for (const answer of await Promise.all(singles)) expect(answer).toMatchObject(expired)
    for (const answer of await Promise.all(batches)) {
      expect(answer.succeeded).toEqual([])
      expect(answer.failed).toHaveLength(2)
      for (const failure of answer.failed) expect(failure.error).toMatchObject(expired)
    }
    await sleep(2_000)
    expect.soft(arrivals).toEqual([])
    expect(Object.fromEntries(await readCopy(running.probe, 'primary'))).toEqual(
      Object.fromEntries(existing.map(id => [id, original])),
    )
  } finally {
    stopFailing()
  }
}, 60_000)
