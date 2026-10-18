import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AnyDocument } from '../../../types/schema'
import { INDEX, registerWorkshopLanguage, workshopCorpus } from './corpus'
import {
  createWorkshopIndex,
  NO_WORKERS,
  searchOver,
  startWorkshopServer,
  WORKERS_BUILT,
  type WorkshopServer,
  waitForWorkerCopies,
  workerCopies,
} from './harness'

const PLURAL_ONLY = 'oilskins-title'
const SINGULAR_ONLY = 'oilskin-title'
const SPELLING_DOCUMENTS: AnyDocument[] = [
  { id: PLURAL_ONLY, title: 'oilskins', body: 'paint' },
  { id: SINGULAR_ONLY, title: 'oilskin', body: 'chair' },
]
const INSIDE_THE_PLURAL = { term: 'lskins', partialWords: true }

const servers: WorkshopServer[] = []
let directory: string | null = null

beforeAll(() => {
  registerWorkshopLanguage()
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  if (directory !== null) await rm(directory, { recursive: true, force: true })
  directory = null
})

async function idsInsideThePlural(server: WorkshopServer): Promise<string[]> {
  return (await searchOver(server.client)(INSIDE_THE_PLURAL)).map(hit => hit.id).sort()
}

async function removePlural(server: WorkshopServer): Promise<void> {
  expect((await server.client.removeBatch(INDEX, [PLURAL_ONLY])).failed).toEqual([])
}

describe('a spelling that leaves a frozen segment with its last document', () => {
  it.skipIf(!WORKERS_BUILT)(
    'stops matching on worker copies, while the word it belongs to stays in other documents',
    async () => {
      const server = await startWorkshopServer({ workers: workerCopies() })
      servers.push(server)
      await createWorkshopIndex(server, [...workshopCorpus(300, 71), ...SPELLING_DOCUMENTS])
      await waitForWorkerCopies(server)
      expect(await idsInsideThePlural(server)).toEqual([SINGULAR_ONLY, PLURAL_ONLY].sort())

      await removePlural(server)
      await server.client.waitForWrites(INDEX)
      expect(await idsInsideThePlural(server)).toEqual([])
      expect((await searchOver(server.client)({ term: 'oilskin' })).map(hit => hit.id)).toEqual([SINGULAR_ONLY])
    },
    60_000,
  )

  it('stops matching after a restart replays the removal over the checkpoint', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-partial-removals-'))
    const first = await startWorkshopServer({ workers: NO_WORKERS, durability: { directory } })
    await createWorkshopIndex(first, [...workshopCorpus(300, 72), ...SPELLING_DOCUMENTS])
    await first.client.checkpoint(INDEX)
    await removePlural(first)
    await first.stop()

    const second = await startWorkshopServer({ workers: NO_WORKERS, durability: { directory } })
    servers.push(second)
    expect(await idsInsideThePlural(second)).toEqual([])
    const restored = await second.client.insertBatch(INDEX, [SPELLING_DOCUMENTS[0]])
    expect(restored.failed).toEqual([])
    expect(await idsInsideThePlural(second)).toEqual([SINGULAR_ONLY, PLURAL_ONLY].sort())
  }, 60_000)
})
