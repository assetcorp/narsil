import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createNarsil, type Narsil, registerLanguage } from '../../index'

type Article = {
  id: string
  title?: string
  body?: string[]
}

function words(article: Article, field: 'title' | 'body'): string[] {
  const value = article[field]
  const texts = typeof value === 'string' ? [value] : (value ?? [])
  return texts.flatMap(text => text.split(' ').filter(Boolean))
}

async function verifyScores(engine: Narsil, articles: ReadonlyMap<string, Article>): Promise<void> {
  const rows = [...articles.values()]
  const holders = rows.filter(article =>
    [...words(article, 'body'), ...words(article, 'title')].some(word => word === 'wave' || word === 'waves'),
  )
  const idf = Math.log((rows.length - holders.length + 0.5) / (holders.length + 0.5) + 1)
  const expected = new Map<string, number>()
  for (const article of holders) {
    let score = 0
    for (const field of ['body', 'title'] as const) {
      const tokens = words(article, field)
      const frequency = Math.min(65_535, tokens.filter(word => word === 'wave' || word === 'waves').length)
      if (frequency === 0) continue
      const average = rows.reduce((sum, row) => sum + words(row, field).length, 0) / rows.length
      const numerator = frequency * 2.2
      const denominator = frequency + 1.2 * (tokens.length / average)
      score += idf * (numerator / denominator) * (field === 'title' ? 3 : 0.5)
    }
    expected.set(article.id, score)
  }
  const answer = await engine.query('articles', {
    term: 'wave',
    exact: true,
    limit: 1_000,
    bm25: { k1: 1.2, b: 1 },
    boost: { title: 3, body: 0.5 },
  })
  expect(answer.count).toBe(holders.length)
  expect(new Set(answer.hits.map(hit => hit.id))).toEqual(new Set(expected.keys()))
  for (const hit of answer.hits) expect(hit.score).toBeCloseTo(expected.get(hit.id) ?? -1, 12)
  expect(await engine.countDocuments('articles')).toBe(rows.length)
}

it('keeps whole-document counts, capped field frequencies, and array positions through writes and recovery', async () => {
  registerLanguage({
    name: 'keyword-publication',
    revision: '1',
    stopWords: new Set(),
    stemmer: word => (word === 'waves' ? 'wave' : word),
  })
  const directory = await mkdtemp(join(tmpdir(), 'narsil-keyword-publication-'))
  const options = { workers: { enabled: false }, durability: { directory } }
  let engine = await createNarsil(options)
  const articles = new Map<string, Article>([
    ['heading', { id: 'heading', title: 'wave' }],
    ['empty', { id: 'empty' }],
    ['blank', { id: 'blank', title: '', body: [] }],
    ['long', { id: 'long', title: 'waves wave', body: [Array(65_536).fill('waves').join(' ')] }],
    ['separate', { id: 'separate', body: ['wave', 'port wave'] }],
    ['adjacent', { id: 'adjacent', body: ['wave port', 'waves'] }],
  ])
  try {
    await engine.createIndex('articles', {
      schema: { title: 'string', body: 'string[]:partial' },
      language: 'keyword-publication',
      partitions: { maxPartitions: 1 },
    })
    for (const article of articles.values()) await engine.insert('articles', article, article.id)
    await verifyScores(engine, articles)
    expect((await engine.query('articles', { term: '"wave port"' })).hits.map(hit => hit.id)).toEqual(['adjacent'])
    await engine.remove('articles', 'long')
    articles.delete('long')
    const replacement = { id: 'long', title: 'wave', body: ['port wave'] }
    await engine.insert('articles', replacement, replacement.id)
    articles.set(replacement.id, replacement)
    const changed = { id: 'heading', title: '', body: ['wave wave', 'waves'] }
    await engine.update('articles', changed.id, changed)
    articles.set(changed.id, changed)
    await verifyScores(engine, articles)
    await engine.checkpoint('articles')
    await engine.shutdown()
    engine = await createNarsil(options)
    await verifyScores(engine, articles)
    expect((await engine.query('articles', { term: 'ave', partialWords: true })).count).toBe(4)
    for (const id of ['heading', 'long', 'separate', 'adjacent']) {
      await engine.remove('articles', id)
      articles.delete(id)
    }
    await verifyScores(engine, articles)
    expect((await engine.suggest('articles', { prefix: 'wav' })).terms).toEqual([])
    expect((await engine.query('articles', { term: 'ave', partialWords: true })).hits).toEqual([])
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

it('preserves capped frequencies and field positions in worker-built segments through recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-keyword-worker-build-'))
  const options = {
    workers: { enabled: true, count: 2, promotionThreshold: 50 },
    durability: { directory },
  }
  let engine = await createNarsil(options)
  const articles = new Map<string, Article>()
  for (let at = 0; at < 200; at++) {
    const id = `article-${at}`
    articles.set(id, at % 5 === 0 ? { id } : { id, title: 'waves', body: ['wave', 'port wave'] })
  }
  articles.set('article-1', {
    id: 'article-1',
    title: 'wave port',
    body: [Array(65_536).fill('waves').join(' ')],
  })
  try {
    await engine.createIndex('articles', {
      schema: { title: 'string', body: 'string[]:partial' },
      partitions: { maxPartitions: 1 },
    })
    expect((await engine.insertBatch('articles', [...articles.values()])).failed).toEqual([])
    expect((await engine.getMemoryStats()).workers.length).toBeGreaterThan(0)
    await verifyScores(engine, articles)
    expect((await engine.query('articles', { term: '"wave port"' })).hits.map(hit => hit.id)).toEqual(['article-1'])
    const replacement = { id: 'article-1', title: 'wave', body: ['wave port'] }
    await engine.update('articles', replacement.id, replacement)
    articles.set(replacement.id, replacement)
    await engine.remove('articles', 'article-2')
    articles.delete('article-2')
    await verifyScores(engine, articles)
    await engine.checkpoint('articles')
    await engine.shutdown()
    engine = await createNarsil(options)
    await verifyScores(engine, articles)
    expect((await engine.query('articles', { term: '"wave port"' })).hits.map(hit => hit.id)).toEqual(['article-1'])
    expect(
      (await engine.query('articles', { term: 'ave', partialWords: true, limit: 1_000 })).hits
        .map(hit => hit.id)
        .sort(),
    ).toEqual(
      [...articles.values()]
        .filter(article => words(article, 'body').includes('wave'))
        .map(article => article.id)
        .sort(),
    )
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)

it('retains surface and partial-word membership through compaction', async () => {
  registerLanguage({
    name: 'keyword-compaction',
    revision: '1',
    stopWords: new Set(),
    stemmer: word => (word.endsWith('s') ? word.slice(0, -1) : word),
  })
  const directory = await mkdtemp(join(tmpdir(), 'narsil-keyword-compaction-'))
  const options = { workers: { enabled: false }, durability: { directory } }
  let engine = await createNarsil(options)
  const rows = new Map<string, { id: string; body: string }>()
  for (let at = 0; at < 240; at++) {
    const id = `article-${at}`
    const terms = Array.from({ length: 12 }, (_, word) => `harbour${String(at * 12 + word).padStart(4, '0')}s`)
    rows.set(id, { id, body: `waves ${terms.join(' ')}` })
  }
  async function verify(): Promise<void> {
    expect(await engine.countDocuments('articles')).toBe(rows.size)
    const shared = await engine.query('articles', { term: 'wave', exact: true, limit: 1_000 })
    expect(shared.hits.map(hit => hit.id).sort()).toEqual([...rows.keys()].sort())
    for (const fragment of ['bour000', 'bour120', 'bour216', 'bour280', 'bour287', 'bour999']) {
      const expected = [...rows.values()].filter(row => row.body.split(' ').some(term => term.includes(fragment)))
      const answer = await engine.query('articles', { term: fragment, partialWords: true, limit: 1_000 })
      expect(answer.hits.map(hit => hit.id).sort()).toEqual(expected.map(row => row.id).sort())
    }
    for (const prefix of ['harbour00', 'harbour21', 'harbour28', 'harbour99']) {
      const expected = [...rows.values()].flatMap(row => row.body.split(' ')).filter(term => term.startsWith(prefix))
      const answer = await engine.suggest('articles', { prefix, limit: 1_000 })
      expect(answer.terms.map(term => term.term).sort()).toEqual(expected.sort())
    }
  }
  try {
    await engine.createIndex('articles', {
      schema: { body: 'string:partial' },
      language: 'keyword-compaction',
      trackPositions: true,
      partitions: { maxPartitions: 1 },
    })
    expect((await engine.insertBatch('articles', [...rows.values()])).failed).toEqual([])
    for (let at = 0; at < 90; at++) {
      await engine.remove('articles', `article-${at}`)
      rows.delete(`article-${at}`)
    }
    const removed = Array.from({ length: 90 }, (_, at) => `article-${at + 90}`)
    expect((await engine.removeBatch('articles', removed)).failed).toEqual([])
    for (const id of removed) rows.delete(id)
    const changed = { id: 'article-180', body: 'waves harbour9999s harbour0000s' }
    await engine.update('articles', changed.id, changed)
    rows.set(changed.id, changed)
    await verify()
    await engine.checkpoint('articles')
    await engine.shutdown()
    engine = await createNarsil(options)
    await verify()
    await engine.remove('articles', changed.id)
    rows.delete(changed.id)
    await verify()
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
