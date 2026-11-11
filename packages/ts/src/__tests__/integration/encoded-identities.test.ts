import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createNarsil, type Narsil, registerLanguage, registerTokenizer } from '../../index'

it.each([
  'memory',
  'disk',
] as const)('keeps leading Unicode markers in document IDs through %s recovery', async textStorage => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-encoded-identities-'))
  const options = { workers: { enabled: false }, durability: { directory } }
  let engine = await createNarsil(options)
  const ids = ['record', '\ufeffrecord', '\ufeff\ufeffrecord']
  async function verify(current: Narsil): Promise<void> {
    const answer = await current.query('records', { term: 'harbor', limit: 10 })
    expect(answer.hits.map(hit => hit.id).sort()).toEqual([...ids].sort())
    for (const [at, id] of ids.entries())
      expect(await current.get('records', id)).toEqual({ body: 'harbor', value: at })
  }
  try {
    await engine.createIndex('records', { schema: { body: 'string', value: 'number' }, textStorage })
    for (const [at, id] of ids.entries()) await engine.insert('records', { body: 'harbor', value: at }, id)
    await verify(engine)
    await engine.checkpoint('records')
    await engine.shutdown()
    engine = await createNarsil(options)
    await verify(engine)
    await engine.remove('records', ids[1])
    expect(await engine.get('records', ids[0])).toEqual({ body: 'harbor', value: 0 })
    expect(await engine.get('records', ids[2])).toEqual({ body: 'harbor', value: 2 })
    expect((await engine.query('records', { term: 'harbor' })).hits.map(hit => hit.id).sort()).toEqual(
      [ids[0], ids[2]].sort(),
    )
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps leading Unicode markers in synonym terms from a registered tokeniser', async () => {
  registerTokenizer('marked-synonym-terms', {
    tokenize: text => text.split(' ').map((word, position) => ({ token: `\ufeff${word}`, position })),
  })
  const engine = await createNarsil({ workers: { enabled: false } })
  try {
    await engine.createIndex('records', { schema: { body: 'string' }, tokenizer: 'marked-synonym-terms' })
    await engine.insert('records', { body: 'harbor' }, 'harbor')
    await engine.insert('records', { body: 'port' }, 'port')
    await engine.updateSynonyms('records', [{ words: ['harbor', 'port'] }])
    expect((await engine.query('records', { term: 'harbor' })).hits.map(hit => hit.id).sort()).toEqual([
      'harbor',
      'port',
    ])
  } finally {
    await engine.shutdown()
  }
})

it.each([
  'memory',
  'disk',
] as const)('keeps marked surfaces and partial spellings through %s removals and merging', async textStorage => {
  const language = `marked-spellings-${textStorage}`
  registerLanguage({
    name: language,
    revision: '1',
    stopWords: new Set(),
    tokenizer: { normalizeDiacritics: true },
    normalizer: word => (word.length >= 6 ? `\ufeff${word}` : word),
    stemmer: word => {
      const plain = word.startsWith('\ufeff') ? word.slice(1) : word
      return plain.endsWith('s') ? plain.slice(0, -1) : plain
    },
  })
  const directory = await mkdtemp(join(tmpdir(), 'narsil-marked-spellings-'))
  const options = { workers: { enabled: false }, durability: { directory } }
  let engine = await createNarsil(options)
  const kept = new Set(['first', 'second'])
  async function verify(): Promise<void> {
    const suggested = await engine.suggest('records', { prefix: 'harbor' })
    expect(suggested.terms).toEqual([{ term: '\ufeffharbors', documentFrequency: kept.size }])
    const matched = await engine.query('records', { term: 'arbor', partialWords: true, tolerance: 0 })
    expect(matched.hits.map(hit => hit.id).sort()).toEqual([...kept].sort())
  }
  try {
    await engine.createIndex('records', { schema: { body: 'string:partial' }, language, textStorage })
    for (const id of kept) await engine.insert('records', { body: 'harbors harbors' }, id)
    await verify()
    await engine.checkpoint('records')
    await engine.shutdown()
    engine = await createNarsil(options)
    await verify()
    await engine.remove('records', 'first')
    kept.delete('first')
    await verify()
    await engine.checkpoint('records')
    await engine.shutdown()
    engine = await createNarsil(options)
    await verify()
  } finally {
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
