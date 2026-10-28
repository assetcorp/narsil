import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { FIRST_RULES, garageCorpus, INDEX, registerGarageLanguage, SECOND_RULES } from './corpus'
import {
  createGarageIndex,
  expectEveryProbe,
  type GarageServer,
  insertAll,
  NO_WORKERS,
  probeQueries,
  searchOver,
  startGarageServer,
  WORKERS_BUILT,
  waitForWorkerCopies,
  workerCopies,
} from './harness'
import { createOracle, expandQuery } from './oracle'

const CORPUS_SIZE = 1_200
const LEAST_MATCHES = 20_000

const servers: GarageServer[] = []

beforeAll(() => {
  registerGarageLanguage()
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

async function started(config: Parameters<typeof startGarageServer>[0]): Promise<GarageServer> {
  const server = await startGarageServer(config)
  servers.push(server)
  return server
}

describe('the oracle that the synonym tests compare against', () => {
  it('changes the hits of most probes, so a search that ignored the set would fail', () => {
    const documents = garageCorpus(CORPUS_SIZE, 61)
    const withSet = createOracle(documents, FIRST_RULES)
    const withoutSet = createOracle(documents, [])
    const changed = probeQueries().filter(
      query => JSON.stringify(withSet.search(query)) !== JSON.stringify(withoutSet.search(query)),
    )
    expect(changed.length).toBeGreaterThan(probeQueries().length / 2)
  }, 60_000)

  it('caps one token at 50 synonyms in code point order, and splits the cap across tokens', () => {
    expect(expandQuery(['giant'], FIRST_RULES).get('giant')).toHaveLength(50)
    const split = expandQuery(['giant', 'huge', 'fast'], FIRST_RULES)
    expect([...split.values()].map(list => list.length)).toEqual([17, 17, 1])
    expect(expandQuery(['fast'], FIRST_RULES).get('fast')).toEqual(['quick'])
  })
})

describe('a synonym search sent over HTTP matches the independent oracle', () => {
  it('on the main thread, after a replaced set, and after the set is removed', async () => {
    const documents = garageCorpus(CORPUS_SIZE, 62)
    const server = await started({ workers: NO_WORKERS })
    await createGarageIndex(server, documents, FIRST_RULES)
    const search = searchOver(server.client)
    expect(await expectEveryProbe(search, createOracle(documents, FIRST_RULES), 'created')).toBeGreaterThan(
      LEAST_MATCHES,
    )
    expect(await server.client.getSynonyms(INDEX)).toEqual(FIRST_RULES)

    await server.client.updateSynonyms(INDEX, SECOND_RULES)
    await expectEveryProbe(search, createOracle(documents, SECOND_RULES), 'replaced')
    expect(await server.client.getSynonyms(INDEX)).toEqual(SECOND_RULES)

    await server.client.updateSynonyms(INDEX, [])
    await expectEveryProbe(search, createOracle(documents, []), 'removed')
    expect(await server.client.getSynonyms(INDEX)).toEqual([])
  }, 180_000)

  it.skipIf(!WORKERS_BUILT)(
    'on worker copies, before and after the set is replaced',
    async () => {
      const documents = garageCorpus(CORPUS_SIZE, 63)
      const server = await started({ workers: workerCopies() })
      await createGarageIndex(server, documents.slice(0, 300), FIRST_RULES)
      await waitForWorkerCopies(server)
      await insertAll(server, documents.slice(300))
      await server.client.waitForWrites(INDEX)
      const search = searchOver(server.client)
      await expectEveryProbe(search, createOracle(documents, FIRST_RULES), 'workers')

      await server.client.updateSynonyms(INDEX, SECOND_RULES)
      await expectEveryProbe(search, createOracle(documents, SECOND_RULES), 'workers replaced')
    },
    180_000,
  )
})

describe('a synonym set after the index leaves the server that built it', () => {
  let directory: string | null = null

  afterEach(async () => {
    if (directory !== null) await rm(directory, { recursive: true, force: true })
    directory = null
  })

  it('keeps the replaced set across a restart, from the checkpoint and from the log after it', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-synonyms-'))
    const documents = garageCorpus(CORPUS_SIZE, 64)
    const first = await startGarageServer({ workers: NO_WORKERS, durability: { directory } })
    await createGarageIndex(first, documents, FIRST_RULES)
    await first.client.checkpoint(INDEX)
    await first.client.updateSynonyms(INDEX, SECOND_RULES)
    const late = garageCorpus(200, 65, 'logged')
    await insertAll(first, late)
    await first.stop()

    const second = await started({ workers: NO_WORKERS, durability: { directory } })
    await expectEveryProbe(searchOver(second.client), createOracle([...documents, ...late], SECOND_RULES), 'restarted')
    expect(await second.client.getSynonyms(INDEX)).toEqual(SECOND_RULES)
  }, 180_000)

  it('carries the set in a snapshot restored into another server', async () => {
    const documents = garageCorpus(CORPUS_SIZE, 66)
    const source = await started({ workers: NO_WORKERS })
    await createGarageIndex(source, documents, FIRST_RULES)
    const snapshot = await source.client.snapshot(INDEX)

    const target = await started({ workers: NO_WORKERS })
    const task = await target.client.restore(INDEX, snapshot)
    expect((await target.client.waitForTask(task.id)).status).toBe('succeeded')
    await expectEveryProbe(searchOver(target.client), createOracle(documents, FIRST_RULES), 'restored')
    expect(await target.client.getSynonyms(INDEX)).toEqual(FIRST_RULES)
  }, 180_000)
})
