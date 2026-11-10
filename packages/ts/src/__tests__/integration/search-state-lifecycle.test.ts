import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNarsil, type Narsil } from '../../narsil'
import type { IndexConfig } from '../../types/schema'

const INDEX = 'readings'
const DOCUMENTS = 64
const PROBE = [1, 0, 0, 0]

type Reading = {
  id: string
  title: string
  group: string
  scoreText: string
  embedding: number[]
}

function cosine(vector: readonly number[]): number {
  let squared = 0
  for (const value of vector) squared += value * value
  return vector[0] / Math.sqrt(squared)
}

function reading(position: number, generation: number): Reading {
  const embedding = [generation === 0 ? position + 1 : -position - 1, 1, 2, 3]
  return {
    id: `reading-${String(position).padStart(3, '0')}`,
    title: `river generation ${generation}`,
    group: generation === 0 ? 'earlier' : 'later',
    scoreText: String(cosine(embedding)),
    embedding,
  }
}

function gate(): { opened: Promise<void>; open(): void } {
  let open = (): void => undefined
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  return { opened, open }
}

const engines: Narsil[] = []
const roots: string[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe.each(['memory', 'disk'] as const)('search state across replacement with text in %s', textStorage => {
  it.each([
    'restore',
    'analysis change',
    'rebalance',
    'checkpoint',
  ] as const)('keeps scores, documents, groups, facets, and highlights together through a %s', async operation => {
    const directory = await mkdtemp(join(tmpdir(), 'narsil-search-state-'))
    roots.push(directory)
    const engine = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    engines.push(engine)
    const config: IndexConfig = {
      schema: { title: 'string', group: 'enum', scoreText: 'string', embedding: 'vector[4]' },
      vectorPromotion: { quantization: 'none' },
      textStorage,
    }
    await engine.createIndex(INDEX, config)
    const earlier = Array.from({ length: DOCUMENTS }, (_, position) => reading(position, 0))
    const later = Array.from({ length: DOCUMENTS }, (_, position) => reading(position, 1))
    expect((await engine.insertBatch(INDEX, earlier)).failed).toEqual([])
    await engine.checkpoint(INDEX)
    await engine.createIndex('replacement', config)
    expect((await engine.insertBatch('replacement', later)).failed).toEqual([])
    const archive = new Uint8Array(await new Response(await engine.snapshot('replacement')).arrayBuffer())
    const entered = gate()
    const release = gate()
    engine.registerRerankAdapter('stored-cosine', {
      async rerank(_query, texts) {
        entered.open()
        await release.opened
        return texts.map(Number)
      },
    })
    const searching = engine.query<Reading>(INDEX, {
      term: 'river',
      vector: { field: 'embedding', value: PROBE },
      hybrid: { strategy: 'linear', alpha: 0.5 },
      limit: DOCUMENTS,
      facets: { group: {} },
      group: { fields: ['group'], maxPerGroup: DOCUMENTS },
      highlight: { fields: ['title'] },
      rerank: { adapter: 'stored-cosine', fields: ['scoreText'], window: DOCUMENTS },
    })
    let replacing: Promise<void> | undefined
    try {
      await Promise.race([
        entered.opened,
        searching.then(() => {
          throw new Error('The search ended before its rerank adapter held the state')
        }),
      ])
      expect(engine.getStats(INDEX).heldSearchStates).toBeGreaterThan(0)
      if (operation === 'restore') {
        const readingArchive = gate()
        async function* chunks(): AsyncGenerator<Uint8Array> {
          readingArchive.open()
          yield archive
        }
        replacing = engine.restore(INDEX, chunks())
        await Promise.race([readingArchive.opened, replacing])
      } else {
        if (operation === 'analysis change') await engine.changeAnalysis(INDEX, { stopWords: ['river'] })
        if (operation === 'rebalance') await engine.rebalance(INDEX, 3)
        expect(
          (
            await engine.updateBatch(
              INDEX,
              later.map(document => ({ docId: document.id, document })),
            )
          ).failed,
        ).toEqual([])
        if (operation === 'checkpoint') await engine.checkpoint(INDEX)
      }
    } finally {
      release.open()
    }
    const [answer] = await Promise.all([searching, replacing])
    expect(answer.count).toBe(DOCUMENTS)
    expect(answer.hits).toHaveLength(DOCUMENTS)
    expect(answer.facets?.group.values).toEqual({ earlier: DOCUMENTS })
    expect(answer.groups).toHaveLength(1)
    expect(answer.groups?.[0].values).toEqual({ group: 'earlier' })
    const byId = new Map(earlier.map(document => [document.id, document]))
    for (const hit of answer.hits) {
      const expected = byId.get(hit.id)
      expect(Array.from(hit.document.embedding)).toEqual(expected?.embedding)
      expect(hit.document.title).toBe(expected?.title)
      expect(hit.score).toBeCloseTo(cosine(hit.document.embedding), 12)
      expect(hit.highlights?.title.positions).toEqual([{ start: 0, end: 5 }])
    }
    for (const hit of answer.groups?.[0].hits ?? []) {
      const expected = byId.get(hit.id)
      expect(expected).toBeDefined()
      expect(hit.document).toMatchObject({ title: expected?.title, group: 'earlier' })
      const embedding = hit.document.embedding
      expect(Array.isArray(embedding) || embedding instanceof Float32Array).toBe(true)
      if (Array.isArray(embedding) || embedding instanceof Float32Array) {
        expect(Array.from(embedding)).toEqual(expected?.embedding)
      }
    }
    expect(engine.getStats(INDEX).heldSearchStates).toBe(0)
    expect((await engine.get(INDEX, later[0].id))?.title).toBe(later[0].title)
  }, 60_000)
})
