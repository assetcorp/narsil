import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createNarsil, type Narsil } from '../../../narsil'
import { scaledOut, waitFor } from '../../server/helpers'
import { bytesOf } from '../portability/archive-oracle'
import { INDEX, pantryCorpus, registerPantryLanguage } from './corpus'
import {
  expectEveryProbe,
  expectSameHits,
  NO_WORKERS,
  PANTRY_CONFIG,
  type PantryServer,
  searchOver,
  startPantryServer,
  WORKERS_BUILT,
  workerCopies,
} from './harness'
import { createOracle } from './oracle'

vi.setConfig({ testTimeout: 120_000 })

const servers: PantryServer[] = []
const engines: Narsil[] = []
let directory: string | null = null

beforeAll(() => {
  registerPantryLanguage()
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  for (const engine of engines.splice(0)) await engine.shutdown()
  if (directory !== null) await rm(directory, { recursive: true, force: true })
  directory = null
})

async function opened(config: Parameters<typeof createNarsil>[0]): Promise<Narsil> {
  const engine = await createNarsil(config)
  engines.push(engine)
  return engine
}

async function closeEngines(): Promise<void> {
  for (const engine of engines.splice(0)) await engine.shutdown()
}

describe('phrase search agrees with the independent oracle', () => {
  it('through the HTTP server and the client, on a segment that is still growing', async () => {
    const documents = pantryCorpus(500, 93)
    const server = await startPantryServer({ workers: NO_WORKERS })
    servers.push(server)
    await server.client.createIndex(INDEX, PANTRY_CONFIG)
    expect((await server.client.insertBatch(INDEX, documents)).failed).toEqual([])

    expect(await expectEveryProbe(searchOver(server.client), documents, 'growing')).toBeGreaterThan(1_000)
  })

  it('on saved segments beside a growing segment, with removals, and again after a restart', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-phrase-saved-'))
    const config = { durability: { directory }, workers: NO_WORKERS }
    const saved = pantryCorpus(400, 94)
    const writer = await opened(config)
    await writer.createIndex(INDEX, PANTRY_CONFIG)
    expect((await writer.insertBatch(INDEX, saved)).failed).toEqual([])
    await writer.checkpoint(INDEX)
    await closeEngines()

    const reader = await opened(config)
    expect((await reader.query(INDEX, { term: '"olive oil"' })).analysisStale).toBeUndefined()
    await expectEveryProbe(searchOver(reader), saved, 'saved')

    const removed = saved.filter((_, at) => at % 7 === 0)
    expect(
      (
        await reader.removeBatch(
          INDEX,
          removed.map(document => String(document.id)),
        )
      ).failed,
    ).toEqual([])
    const added = pantryCorpus(120, 95, 'late')
    expect((await reader.insertBatch(INDEX, added)).failed).toEqual([])
    const current = [...saved.filter((_, at) => at % 7 !== 0), ...added]
    await expectEveryProbe(searchOver(reader), current, 'saved and growing')

    await closeEngines()
    const restarted = await opened(config)
    await expectEveryProbe(searchOver(restarted), current, 'restarted')
  })

  it('after a snapshot restores into another engine', async () => {
    const documents = pantryCorpus(300, 96)
    const source = await opened({ workers: NO_WORKERS })
    await source.createIndex(INDEX, PANTRY_CONFIG)
    expect((await source.insertBatch(INDEX, documents)).failed).toEqual([])
    const archive = await bytesOf(await source.snapshot(INDEX))

    const target = await opened({ workers: NO_WORKERS })
    await target.restore(INDEX, archive)
    expect((await target.query(INDEX, { term: '"olive oil"' })).analysisStale).toBeUndefined()
    await expectEveryProbe(searchOver(target), documents, 'restored')
  })

  it.skipIf(!WORKERS_BUILT)('on worker copies', async () => {
    const documents = pantryCorpus(400, 97)
    const engine = await opened({ workers: workerCopies() })
    await engine.createIndex(INDEX, PANTRY_CONFIG)
    expect((await engine.insertBatch(INDEX, documents)).failed).toEqual([])
    await waitFor(() => scaledOut(engine, INDEX))
    await engine.waitForWrites(INDEX)
    await expectEveryProbe(searchOver(engine), documents, 'worker copies')
  })

  it('honours filters as it honours them for a word', async () => {
    const documents = pantryCorpus(300, 98)
    const engine = await opened({ workers: NO_WORKERS })
    await engine.createIndex(INDEX, PANTRY_CONFIG)
    expect((await engine.insertBatch(INDEX, documents)).failed).toEqual([])
    const query = { term: '"olive oil"', shelf: 2 }
    const expected = createOracle(documents).search(query)
    expect(expected.length).toBeGreaterThan(0)
    expectSameHits(await searchOver(engine)(query), expected, 'filtered')
  })
})

describe('the count, the sort path, and highlights of a phrase', () => {
  it('count the same documents that the scored search returns, and highlight only the phrase tokens as written', async () => {
    const engine = await opened({ workers: NO_WORKERS })
    await engine.createIndex(INDEX, PANTRY_CONFIG)
    await engine.insertBatch(INDEX, [
      { id: 'a', title: 'olive oil', body: 'bread', tags: [], shelf: 2 },
      { id: 'b', title: 'oil olive', body: 'bread', tags: [], shelf: 1 },
      { id: 'c', title: 'olive salt oil', body: 'olives', tags: [], shelf: 0 },
      { id: 'd', title: 'fresh', body: 'olive oils', tags: ['olive', 'oil'], shelf: 3 },
    ])

    expect((await engine.preflight(INDEX, { term: '"olive oil"' })).count).toBe(2)
    const sorted = await engine.query(INDEX, { term: '"olive oil"', sort: { shelf: 'asc' } })
    expect(sorted.hits.map(hit => hit.id)).toEqual(['a', 'd'])

    const highlighted = await engine.query(INDEX, {
      term: '"olive oil"',
      tolerance: 2,
      highlight: { fields: ['title'] },
    })
    const a = highlighted.hits.find(hit => hit.id === 'a')
    expect(a?.highlights?.title?.snippet).toBe('<mark>olive</mark> <mark>oil</mark>')
  })

  it('keep the typo tolerance of a word away from the phrase', async () => {
    const engine = await opened({ workers: NO_WORKERS })
    await engine.createIndex(INDEX, PANTRY_CONFIG)
    await engine.insertBatch(INDEX, [
      { id: 'exact', title: 'olive oil', body: 'x', tags: [], shelf: 0 },
      { id: 'typo', title: 'oliva oil', body: 'x', tags: [], shelf: 0 },
    ])
    expect((await engine.query(INDEX, { term: '"olive oil"', tolerance: 2 })).hits.map(hit => hit.id)).toEqual([
      'exact',
    ])
    const completed = await engine.query(INDEX, { term: 'x "olive oil"', prefix: true })
    expect(completed.hits.map(hit => hit.id)).toEqual(['exact'])
  })

  it('leave the term coverage of the words outside the phrase intact', async () => {
    const engine = await opened({ workers: NO_WORKERS })
    await engine.createIndex(INDEX, PANTRY_CONFIG)
    await engine.insertBatch(INDEX, [
      { id: 'both', title: 'olive oil pasta', body: 'x', tags: [], shelf: 0 },
      { id: 'phrase-only', title: 'olive oil', body: 'x', tags: [], shelf: 0 },
      { id: 'word-only', title: 'pasta', body: 'x', tags: [], shelf: 0 },
    ])
    const covered = await engine.query(INDEX, { term: '"olive oil" pasta', termMatch: 1 })
    expect(covered.hits.map(hit => hit.id)).toEqual(['both'])
    const optional = await engine.query(INDEX, { term: '"olive oil" pasta' })
    expect(optional.hits.map(hit => hit.id).sort()).toEqual(['both', 'phrase-only'])
  })
})
