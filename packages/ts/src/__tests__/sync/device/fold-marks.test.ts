import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerLanguage } from '../../../languages/registry'
import { yoruba } from '../../../languages/yoruba'
import type { Narsil } from '../../../narsil'
import { foldOracle, generatedDocuments, idsWithWord, YORUBA_WORDS } from '../../integration/folded-matching/oracle'
import { waitFor } from '../../server/helpers'
import {
  INDEX,
  type SyncServer,
  settledWithin,
  startDevice,
  startSyncServer,
  type TestDevice,
  temporaryDirectory,
} from './fixtures'

const CORPUS_SIZE = 50
const CORPUS_SEED = 41
const EVERY_HIT = 500
const TASK_POLL_MS = 5
const QUERY = 'oko'
const documents = generatedDocuments(CORPUS_SIZE, YORUBA_WORDS, CORPUS_SEED)
const folded = idsWithWord(documents, word => foldOracle(word) === QUERY)
const written = idsWithWord(documents, word => word === QUERY)

async function hitIds(engine: Narsil): Promise<string[]> {
  return (await engine.query(INDEX, { term: QUERY, limit: EVERY_HIT })).hits.map(hit => hit.id).sort()
}

describe('a synced device after the server changes foldMarks', () => {
  let directory: { path: string; remove(): Promise<void> } | null = null
  let server: SyncServer | null = null
  let device: TestDevice | null = null

  beforeEach(async () => {
    registerLanguage(yoruba)
    directory = await temporaryDirectory('fold-marks')
    server = await startSyncServer(join(directory.path, 'server'))
  })

  afterEach(async () => {
    await device?.close()
    device = null
    await server?.stop()
    server = null
    await directory?.remove()
    directory = null
  })

  async function changeFoldMarks(running: SyncServer, foldMarks: boolean | null): Promise<void> {
    const task = await running.admin.changeAnalysis(INDEX, { foldMarks })
    expect((await running.admin.waitForTask(task.id, { pollIntervalMs: TASK_POLL_MS })).status).toBe('succeeded')
  }

  it('applies each foldMarks value to its copy and keeps its epoch', async () => {
    if (server === null || directory === null) throw new Error('The server has not started')
    const running = server
    await running.admin.createIndex(INDEX, { schema: { body: 'string' }, language: 'yoruba' })
    await running.admin.insertBatch(
      INDEX,
      documents.map(document => ({ id: document.id, body: document.body })),
    )
    await running.admin.updateSync(INDEX, { enabled: true })
    expect(written).not.toEqual(folded)

    const started = await startDevice(running.proxy.url, join(directory.path, 'device'))
    device = started
    await settledWithin(started.sync)
    const epoch = started.sync.status().position?.epoch
    expect(epoch).toBeDefined()
    expect(await hitIds(started.engine)).toEqual(folded)

    await changeFoldMarks(running, false)
    await waitFor(async () => (await hitIds(started.engine)).join() === written.join())
    await settledWithin(started.sync)
    expect(started.sync.status().position?.epoch).toBe(epoch)

    await changeFoldMarks(running, null)
    await waitFor(async () => (await hitIds(started.engine)).join() === folded.join())
    await settledWithin(started.sync)
    expect(started.sync.status().position?.epoch).toBe(epoch)
    expect(started.errors).toEqual([])
  })
})
