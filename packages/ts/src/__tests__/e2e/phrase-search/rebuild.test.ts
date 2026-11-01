import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorCodes } from '../../../errors'
import { createNarsil, type Narsil } from '../../../narsil'
import type { AnyDocument } from '../../../types/schema'
import { postJson, startTestServer, waitFor } from '../../server/helpers'
import { copyReleaseFixture, expectedFixtureDocuments, RELEASE_0_3_FIXTURE } from '../portability/release-0.3-fixture'
import { WORKERS_BUILT } from './harness'

vi.setConfig({ testTimeout: 120_000 })

const engines: Narsil[] = []
let directory: string | null = null

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
  if (directory !== null) await rm(directory, { recursive: true, force: true })
  directory = null
})

function phraseHolders(documents: Record<string, AnyDocument>, first: string, second: string): string[] {
  const adjacent = (text: unknown): boolean => {
    const parts = String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
    return parts.some((part, at) => part === first && parts[at + 1] === second)
  }
  return Object.entries(documents)
    .filter(([, document]) =>
      [document.title, document.body, ...((document.tags as string[]) ?? [])].some(value => adjacent(value)),
    )
    .map(([id]) => id)
    .sort()
}

function crossingItems(documents: Record<string, AnyDocument>): [string, string] {
  for (const document of Object.values(documents)) {
    const tags = document.tags as string[]
    if (tags.length > 1) return [tags[0], tags[1]]
  }
  throw new Error('the fixture holds no document with two tags')
}

describe('an index whose array positions a release before the gap wrote', () => {
  it('refuses a phrase until somebody rebuilds it, then matches inside one item alone', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-phrase-rebuild-'))
    await copyReleaseFixture('wal', directory)
    const config = {
      workers: { enabled: false },
      durability: { directory },
      analysis: { rebuild: 'manual' as const },
    }
    const documents = await expectedFixtureDocuments('wal-expected.json')
    const [first, second] = crossingItems(documents)
    const term = `"${first} ${second}"`

    const engine = await createNarsil(config)
    engines.push(engine)
    await expect(engine.query('products', { term })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_PHRASE_NOT_READY,
      message: expect.stringContaining('somebody has to start it'),
    })
    await expect(engine.preflight('products', { term })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_PHRASE_NOT_READY,
    })
    expect((await engine.query('products', { term: first })).analysisStale).toBe(true)
    await expect(engine.query('notes', { term: '"note about"' })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_INVALID_PHRASE,
    })

    await engine.rebuildAnalysis('products')
    const rebuilt = await engine.query('products', { term, limit: 1_000 })
    expect(rebuilt.analysisStale).toBeUndefined()
    expect(rebuilt.hits.map(hit => hit.id).sort()).toEqual(phraseHolders(documents, first, second))

    await engine.shutdown()
    engines.length = 0
    const reopened = await createNarsil(config)
    engines.push(reopened)
    const again = await reopened.query('products', { term, limit: 1_000 })
    expect(again.analysisStale).toBeUndefined()
    expect(again.hits.map(hit => hit.id).sort()).toEqual(phraseHolders(documents, first, second))
  })

  it('rewrites the array positions under a change of analysis, and records the gap across a reopen', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-phrase-change-'))
    await copyReleaseFixture('wal', directory)
    const config = {
      workers: { enabled: false },
      durability: { directory },
      analysis: { rebuild: 'manual' as const },
    }
    const documents = await expectedFixtureDocuments('wal-expected.json')
    const [first, second] = crossingItems(documents)
    const term = `"${first} ${second}"`
    const holders = phraseHolders(documents, first, second)

    const engine = await createNarsil(config)
    engines.push(engine)
    await expect(engine.query('products', { term })).rejects.toMatchObject({
      code: ErrorCodes.SEARCH_PHRASE_NOT_READY,
    })

    await engine.changeAnalysis('products', { stopWords: ['zzzzzz'] })
    const changed = await engine.query('products', { term, limit: 1_000 })
    expect(changed.analysisStale).toBeUndefined()
    expect(changed.hits.map(hit => hit.id).sort()).toEqual(holders)

    await engine.shutdown()
    engines.length = 0
    const reopened = await createNarsil(config)
    engines.push(reopened)
    const again = await reopened.query('products', { term, limit: 1_000 })
    expect(again.analysisStale).toBeUndefined()
    expect(again.hits.map(hit => hit.id).sort()).toEqual(holders)
  })

  it('answers a phrase straight after restoring an archive of that release, which it analyses again, and after a reopen', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-phrase-restore-'))
    const config = { workers: { enabled: false }, durability: { directory }, analysis: { rebuild: 'manual' as const } }
    const archive = await readFile(new URL('products-0.3.0.nrsl', RELEASE_0_3_FIXTURE))
    const engine = await createNarsil(config)
    engines.push(engine)
    await engine.restore('products', new Uint8Array(archive))

    const page = await engine.listDocuments('products', { limit: 1_000 })
    const documents = Object.fromEntries(page.documents.map(entry => [entry.id, entry.document as AnyDocument]))
    const [first, second] = crossingItems(documents)
    const term = `"${first} ${second}"`
    const restored = await engine.query('products', { term, limit: 1_000 })
    expect(restored.analysisStale).toBeUndefined()
    expect(restored.hits.map(hit => hit.id).sort()).toEqual(phraseHolders(documents, first, second))

    await engine.shutdown()
    engines.length = 0
    const reopened = await createNarsil(config)
    engines.push(reopened)
    const again = await reopened.query('products', { term, limit: 1_000 })
    expect(again.analysisStale).toBeUndefined()
    expect(again.hits.map(hit => hit.id).sort()).toEqual(phraseHolders(documents, first, second))
  })

  it.skipIf(!WORKERS_BUILT)(
    'answers 503 through the HTTP server while worker copies hold the stale index, then matches after the rebuild',
    async () => {
      directory = await mkdtemp(join(tmpdir(), 'narsil-phrase-rebuild-http-'))
      await copyReleaseFixture('wal', directory)
      const server = await startTestServer(undefined, {
        workers: { promotionThreshold: 200, count: 2, mainCopyQueries: 'none' },
        durability: { directory },
        analysis: { rebuild: 'manual' },
      })
      try {
        const documents = await expectedFixtureDocuments('wal-expected.json')
        const [first, second] = crossingItems(documents)
        const term = `"${first} ${second}"`
        for (let round = 0; round < 8; round++) {
          const refused = await postJson(server.base, '/indexes/products/search', { term })
          expect(refused.status).toBe(503)
          expect(JSON.stringify(refused.body)).toContain('somebody has to start it')
          const plain = await postJson(server.base, '/indexes/products/search', { term: first })
          expect(plain.status).toBe(200)
        }

        await server.engine.rebuildAnalysis('products')
        const rebuilt = await postJson<{ hits: Array<{ id: string }> }>(server.base, '/indexes/products/search', {
          term,
          limit: 1_000,
        })
        expect(rebuilt.status).toBe(200)
        expect(rebuilt.body.hits.map(hit => hit.id).sort()).toEqual(phraseHolders(documents, first, second))
      } finally {
        await server.stop()
      }
    },
  )

  it('rebuilds on its own under the default setting, and answers once the rebuild ends', async () => {
    directory = await mkdtemp(join(tmpdir(), 'narsil-phrase-auto-rebuild-'))
    await copyReleaseFixture('wal', directory)
    const engine = await createNarsil({ workers: { enabled: false }, durability: { directory } })
    engines.push(engine)
    await waitFor(async () => (await engine.query('products', { term: 'harbour' })).analysisStale !== true)
    const documents = await expectedFixtureDocuments('wal-expected.json')
    const [first, second] = crossingItems(documents)
    const answer = await engine.query('products', { term: `"${first} ${second}"`, limit: 1_000 })
    expect(answer.hits.map(hit => hit.id).sort()).toEqual(phraseHolders(documents, first, second))
  })
})
