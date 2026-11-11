import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { activeTable, note, type SyncCluster, startSyncCluster, waitFor } from './cluster-fixtures'
import { ADMIN_TOKEN, download, ownerHook } from './fixtures'

const SCHEMA = { schema: { title: 'string', body: 'string' } } as const
const DOCUMENTS = 60
const ROUTER = 'harbour-office'
const DATA_NODES = ['harbour-a', 'harbour-b']
const EPOCH_CHANGES = 3
const SYNC_BACKUPS_LEFT = 2

function oldSyncNameShape(indexName: string): string {
  return `sync-${createHash('sha256').update(indexName).digest('hex').slice(0, 32)}-1700000000000`
}

describe('the cleanup of the backups that device sync takes in a cluster', () => {
  let cluster: SyncCluster | null = null

  afterEach(async () => {
    await cluster?.dispose()
    cluster = null
  })

  it("keeps a caller's backup that carries the device-sync name shape, and keeps two of the backups that device sync takes", async () => {
    const running = await startSyncCluster({ backups: true })
    cluster = running
    await running.start(ROUTER, ['coordinator', 'controller'])
    for (const nodeId of DATA_NODES) await running.start(nodeId, ['data'])
    const base = await running.serve(ROUTER, ownerHook())
    await running.admin.createIndex('alice', SCHEMA)
    await activeTable(running.coordinator, 'alice')
    const batch = Array.from({ length: DOCUMENTS }, (_, at) => ({ id: `n${at}`, ...note(at) }))
    expect((await running.admin.insertBatch('alice', batch)).failed).toEqual([])
    await running.admin.updateSync('alice', { enabled: true })

    const callersBackup = oldSyncNameShape('alice')
    const created = await fetch(`${base}/indexes/alice/backups`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ backup: callersBackup, takenBy: 'sync' }),
    })
    expect(created.status).toBe(202)
    const task = (await created.json()) as { id: string }
    expect((await running.admin.waitForTask(task.id)).status).toBe('succeeded')

    for (let change = 0; change < EPOCH_CHANGES; change++) {
      await running.admin.updateSync('alice', { enabled: false })
      await running.admin.updateSync('alice', { enabled: true })
      await waitFor('a backup that qualifies for the snapshot', async () => {
        const answer = await download(base, 'alice', 'alice-token')
        return answer.status === 200 ? answer : null
      })
    }

    const names = await waitFor('the controller to delete every surplus device-sync backup', async () => {
      const listed = (await running.admin.listBackups()).map(backup => backup.name)
      return listed.length === SYNC_BACKUPS_LEFT + 1 ? listed : null
    })
    expect(names).toContain(callersBackup)
    expect(names.filter(name => name !== callersBackup)).toHaveLength(SYNC_BACKUPS_LEFT)
  }, 120_000)
})
