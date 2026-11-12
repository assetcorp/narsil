import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, NarsilError } from '../../errors'
import { createNarsil, type Narsil } from '../../narsil'
import type { EmbeddingAdapter } from '../../types/adapters'
import type { IndexConfig } from '../../types/schema'

const INDEX = 'trails'
const SEARCHED_WORD = 'river'
const RERANK_CALLS_WITH_ONE_RESTORE = 2
const RERANK_CALLS_BEFORE_REFUSAL = 3
const SIMILARITY_FLOOR = 0.9
const MATCHING_VECTOR = [1, 0]
const OTHER_VECTOR = [0, 1]

type Trail = { title: string; category: string }

const REPLACED_DOCUMENTS: [string, Trail][] = [
  ['shared', { title: 'river stone', category: 'old' }],
  ['replaced-bend', { title: 'river bend', category: 'old' }],
  ['replaced-mouth', { title: 'river mouth wide', category: 'old' }],
  ['replaced-quiet', { title: 'quiet river', category: 'old' }],
]

const RESTORED_DOCUMENTS: [string, Trail][] = [
  ['shared', { title: 'river stone path', category: 'trail' }],
  ['restored-crossing', { title: 'river crossing', category: 'trail' }],
  ['restored-delta', { title: 'river delta marsh', category: 'wetland' }],
  ['restored-shore', { title: 'lake shore', category: 'wetland' }],
  ['restored-current', { title: 'slow river current water', category: 'wetland' }],
]

const config: IndexConfig = { schema: { title: 'string', category: 'enum' } }

const engines: Narsil[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.shutdown()
})

async function engineHolding(documents: [string, Trail][]): Promise<Narsil> {
  const engine = await createNarsil({ workers: { enabled: false } })
  engines.push(engine)
  await engine.createIndex(INDEX, config)
  for (const [id, document] of documents) await engine.insert(INDEX, document, id)
  return engine
}

async function archiveOf(documents: [string, Trail][]): Promise<Uint8Array> {
  const source = await engineHolding(documents)
  return new Uint8Array(await new Response(await source.snapshot(INDEX)).arrayBuffer())
}

function titleLengthScore(title: string): number {
  return Array.from(title).length
}

function expectedPage(documents: [string, Trail][]) {
  const matching = documents
    .filter(([, document]) => document.title.split(/\s+/).includes(SEARCHED_WORD))
    .sort(([, left], [, right]) => titleLengthScore(right.title) - titleLengthScore(left.title))
  const categories: Record<string, number> = {}
  for (const [, document] of matching) categories[document.category] = (categories[document.category] ?? 0) + 1
  return {
    ids: matching.map(([id]) => id),
    documents: matching.map(([, document]) => document),
    count: matching.length,
    categories,
  }
}

function wordVector(text: string): Float32Array {
  const words = text.split(/\s+/)
  return Float32Array.from(words.includes(SEARCHED_WORD) ? MATCHING_VECTOR : OTHER_VECTOR)
}

function wordEmbedding(onQuery: () => Promise<void>): EmbeddingAdapter {
  return {
    dimensions: MATCHING_VECTOR.length,
    async embed(input, purpose) {
      if (purpose === 'query') await onQuery()
      return wordVector(input)
    },
  }
}

function embeddedConfig(adapter: string): IndexConfig {
  return {
    schema: { title: 'string', category: 'enum', embedding: `vector[${MATCHING_VECTOR.length}]` },
    embedding: { adapter, fields: { embedding: 'title' } },
  }
}

async function embeddedEngineHolding(adapter: string, documents: [string, Trail][]): Promise<Narsil> {
  const engine = await createNarsil({ workers: { enabled: false } })
  engines.push(engine)
  engine.registerEmbeddingAdapter(
    adapter,
    wordEmbedding(async () => undefined),
  )
  await engine.createIndex(INDEX, embeddedConfig(adapter))
  for (const [id, document] of documents) await engine.insert(INDEX, { ...document }, id)
  return engine
}

function registerRestoringReranker(engine: Narsil, archive: Uint8Array, restores: number): { calls: number } {
  const counted = { calls: 0 }
  engine.registerRerankAdapter('restoring', {
    async rerank(_query, texts) {
      counted.calls++
      if (counted.calls <= restores) await engine.restore(INDEX, archive)
      return texts.map(titleLengthScore)
    },
  })
  return counted
}

function rerankedSearch(engine: Narsil) {
  return engine.query<Trail>(INDEX, {
    term: SEARCHED_WORD,
    facets: { category: {} },
    rerank: { adapter: 'restoring', fields: ['title'] },
  })
}

describe('a restore during a rerank call', () => {
  it('returns a page whose hits, documents, count, and facets all come from the restored index', async () => {
    const archive = await archiveOf(RESTORED_DOCUMENTS)
    const engine = await engineHolding(REPLACED_DOCUMENTS)
    const reranker = registerRestoringReranker(engine, archive, 1)

    const answer = await rerankedSearch(engine)

    const expected = expectedPage(RESTORED_DOCUMENTS)
    expect(answer.hits.map(hit => hit.id)).toEqual(expected.ids)
    expect(answer.hits.map(hit => hit.document)).toEqual(expected.documents)
    expect(answer.count).toBe(expected.count)
    expect(answer.facets?.category.values).toEqual(expected.categories)
    expect(reranker.calls).toBe(RERANK_CALLS_WITH_ONE_RESTORE)
  })

  it('refuses with WORKER_BUSY once a restore replaces the index during every rerank call', async () => {
    const archive = await archiveOf(RESTORED_DOCUMENTS)
    const engine = await engineHolding(REPLACED_DOCUMENTS)
    const reranker = registerRestoringReranker(engine, archive, Number.POSITIVE_INFINITY)

    const outcome = await rerankedSearch(engine).then(
      () => null,
      (error: unknown) => error,
    )

    expect(outcome).toBeInstanceOf(NarsilError)
    expect((outcome as NarsilError).code).toBe(ErrorCodes.WORKER_BUSY)
    expect(reranker.calls).toBe(RERANK_CALLS_BEFORE_REFUSAL)
    expect(await engine.get(INDEX, 'restored-current')).toEqual(RESTORED_DOCUMENTS[4][1])
  })

  it('counts only the rerank calls that a restore interrupted toward the refusal, never a changed embedding adapter', async () => {
    const restoredSource = await embeddedEngineHolding('later', RESTORED_DOCUMENTS)
    const archive = new Uint8Array(await new Response(await restoredSource.snapshot(INDEX)).arrayBuffer())
    const engine = await createNarsil({ workers: { enabled: false } })
    engines.push(engine)
    let queryEmbeddings = 0
    engine.registerEmbeddingAdapter(
      'earlier',
      wordEmbedding(async () => {
        queryEmbeddings++
        await engine.restore(INDEX, archive)
      }),
    )
    engine.registerEmbeddingAdapter(
      'later',
      wordEmbedding(async () => {
        queryEmbeddings++
      }),
    )
    await engine.createIndex(INDEX, embeddedConfig('earlier'))
    for (const [id, document] of REPLACED_DOCUMENTS) await engine.insert(INDEX, { ...document }, id)
    const reranker = registerRestoringReranker(engine, archive, RERANK_CALLS_BEFORE_REFUSAL - 1)

    const answer = await engine.query<Trail>(INDEX, {
      term: SEARCHED_WORD,
      vector: { field: 'embedding', text: SEARCHED_WORD, similarity: SIMILARITY_FLOOR },
      facets: { category: {} },
      document: { exclude: ['embedding'] },
      rerank: { adapter: 'restoring', fields: ['title'] },
    })

    const expected = expectedPage(RESTORED_DOCUMENTS)
    expect(answer.hits.map(hit => hit.id)).toEqual(expected.ids)
    expect(answer.hits.map(hit => hit.document)).toEqual(expected.documents)
    expect(answer.count).toBe(expected.count)
    expect(answer.facets?.category.values).toEqual(expected.categories)
    expect(reranker.calls).toBe(RERANK_CALLS_BEFORE_REFUSAL)
    expect(queryEmbeddings).toBe(2)
  })
})
