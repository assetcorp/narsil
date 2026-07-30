import { afterEach, describe, expect, it } from 'vitest'
import { registerStopWords, registerTokenizer } from '../../analysis/registry'
import { createNarsil, type Narsil } from '../../narsil'
import type { CustomTokenizer } from '../../types/schema'

const schema = { title: 'string' as const }

const wholeText: CustomTokenizer = {
  tokenize(text: string) {
    return [{ token: text.trim().toLowerCase(), position: 0 }]
  },
}

const perLetter: CustomTokenizer = {
  tokenize(text: string) {
    return [...text.replace(/\s+/g, '')].map((token, position) => ({ token, position }))
  },
}

describe('an index holds the analysis it resolved when the caller created it', () => {
  const engines: Narsil[] = []

  afterEach(async () => {
    while (engines.length > 0) {
      const engine = engines.pop()
      await engine?.shutdown()
    }
  })

  async function engineWith(tokenizerName: string): Promise<Narsil> {
    const engine = await createNarsil()
    engines.push(engine)
    await engine.createIndex('prose', { schema, tokenizer: tokenizerName })
    return engine
  }

  it('keeps querying and indexing alike after the name is registered again', async () => {
    registerTokenizer('binding-probe', wholeText)
    const engine = await engineWith('binding-probe')
    await engine.insert('prose', { title: 'machine' })

    expect((await engine.query('prose', { term: 'machine' })).hits).toHaveLength(1)

    registerTokenizer('binding-probe', perLetter)

    expect((await engine.query('prose', { term: 'machine' })).hits).toHaveLength(1)
    expect((await engine.query('prose', { term: 'm' })).hits).toHaveLength(0)

    await engine.insert('prose', { title: 'engine' })
    expect((await engine.query('prose', { term: 'engine' })).hits).toHaveLength(1)
    expect((await engine.query('prose', { term: 'e' })).hits).toHaveLength(0)
  })

  it('binds an index created after the second registration to the newer tokenizer', async () => {
    registerTokenizer('binding-later', wholeText)
    const first = await engineWith('binding-later')
    await first.insert('prose', { title: 'machine' })

    registerTokenizer('binding-later', perLetter)
    const second = await engineWith('binding-later')
    await second.insert('prose', { title: 'machine' })

    expect((await first.query('prose', { term: 'machine' })).hits).toHaveLength(1)
    expect((await second.query('prose', { term: 'm' })).hits).toHaveLength(1)
  })

  it('keeps a rebalanced index on the tokenizer it was created with', async () => {
    registerTokenizer('binding-rebalance', wholeText)
    const engine = await createNarsil()
    engines.push(engine)
    await engine.createIndex('prose', { schema, tokenizer: 'binding-rebalance' })
    for (let i = 0; i < 12; i++) {
      await engine.insert('prose', { title: `machine ${i}` })
    }

    registerTokenizer('binding-rebalance', perLetter)
    await engine.rebalance('prose', 3)

    expect((await engine.query('prose', { term: 'machine 4' })).hits).toHaveLength(1)
    expect((await engine.query('prose', { term: 'm' })).hits).toHaveLength(0)
  })

  it('holds the stop word set it resolved when the caller created the index', async () => {
    registerStopWords('binding-stop-words', new Set<string>())
    const engine = await createNarsil()
    engines.push(engine)
    await engine.createIndex('prose', { schema, stopWords: 'binding-stop-words' })
    await engine.insert('prose', { title: 'the rise of the machine' })

    registerStopWords('binding-stop-words', new Set(['the']))

    expect((await engine.query('prose', { term: 'the' })).hits).toHaveLength(1)
  })

  it('highlights under the same binding the index searches with', async () => {
    registerStopWords('binding-highlight', new Set<string>())
    const engine = await createNarsil()
    engines.push(engine)
    await engine.createIndex('prose', { schema, stopWords: 'binding-highlight' })
    await engine.insert('prose', { title: 'the rise of the machine' })

    registerStopWords('binding-highlight', new Set(['the']))

    const result = await engine.query('prose', { term: 'the', highlight: { fields: ['title'] } })
    expect(result.hits[0].highlights?.title.positions.length).toBeGreaterThan(0)
  })
})
