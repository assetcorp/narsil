import { expect, it } from 'vitest'
import { registerStopWords, registerTokenizer } from '../../analysis/registry'
import { registerLanguage } from '../../languages/registry'
import { createNarsil } from '../../narsil'

it('preserves every field after an analyser refusal', async () => {
  const calls: string[] = []
  let refused = ''
  const tokenizer = 'publication-positions'
  registerTokenizer(tokenizer, {
    tokenize(text) {
      calls.push(text)
      if (text === refused) throw new Error('The analyser refused the text')
      return text.split(' ').map((token, position) => ({ token, position }))
    },
  })
  const engine = await createNarsil({ workers: { enabled: false } })
  const original = { rating: 7, title: 'river', labels: ['lagoon', 'shore'], category: 'water', active: true }
  try {
    await engine.createIndex('readings', {
      schema: { rating: 'number', title: 'string:partial', labels: 'string[]', category: 'enum', active: 'boolean' },
      trackPositions: true,
      tokenizer,
    })
    await engine.insert('readings', original, 'retained')
    expect(calls.splice(0)).toEqual(['river', 'lagoon', 'shore'])
    refused = 'closed'
    await expect(
      engine.update('readings', 'retained', { ...original, rating: 99, title: 'forest', labels: ['open', 'closed'] }),
    ).rejects.toThrow('The analyser refused the text')
    expect(calls.splice(0)).toEqual(['river', 'lagoon', 'shore', 'forest', 'open', 'closed'])
    expect(await engine.get('readings', 'retained')).toEqual(original)
    expect((await engine.query('readings', { term: 'river' })).hits.map(hit => hit.id)).toEqual(['retained'])
    expect((await engine.query('readings', { term: 'forest' })).count).toBe(0)
    expect((await engine.query('readings', { term: 'ive', partialWords: true })).hits.map(hit => hit.id)).toEqual([
      'retained',
    ])
    expect((await engine.query('readings', { term: 'ores', partialWords: true })).count).toBe(0)
    expect((await engine.query('readings', { term: 'river', filters: { fields: { rating: { eq: 7 } } } })).count).toBe(
      1,
    )

    expect((await engine.query('readings', { term: 'river', filters: { fields: { rating: { eq: 99 } } } })).count).toBe(
      0,
    )

    await expect(
      engine.insert('readings', { ...original, title: 'ghost', labels: ['open', 'closed'] }, 'refused'),
    ).rejects.toThrow('The analyser refused the text')
    refused = ''
    await engine.insert('readings', { ...original, title: 'forest', labels: [] }, 'refused')
    expect((await engine.query('readings', { term: 'ghost' })).count).toBe(0)
    expect((await engine.query('readings', { term: 'hos', partialWords: true })).count).toBe(0)
    expect((await engine.query('readings', { term: 'open' })).count).toBe(0)
    expect(await engine.countDocuments('readings')).toBe(2)

    calls.length = 0
    refused = 'shore'
    await expect(engine.remove('readings', 'retained')).rejects.toThrow('The analyser refused the text')
    expect(calls.splice(0)).toEqual(['river', 'lagoon', 'shore'])
    refused = ''
    expect(await engine.get('readings', 'retained')).toEqual(original)
    expect((await engine.query('readings', { term: 'lagoon' })).hits.map(hit => hit.id)).toEqual(['retained'])
    expect(
      (await engine.query('readings', { term: 'river forest', filters: { fields: { rating: { eq: 7 } } } })).count,
    ).toBe(2)
    expect(engine.getStats('readings').heldSearchStates).toBe(0)
    await engine.update('readings', 'retained', { ...original, title: 'lake', labels: [] })
    await engine.remove('readings', 'refused')
    expect((await engine.query('readings', { term: 'lake' })).hits.map(hit => hit.id)).toEqual(['retained'])
    expect((await engine.query('readings', { term: 'river' })).count).toBe(0)
    expect(await engine.countDocuments('readings')).toBe(1)
  } finally {
    await engine.shutdown()
  }
})

it.each([
  'normalizer',
  'stemmer',
  'stopWords',
] as const)('keeps the document and its indexes intact when %s refuses a later field', async callback => {
  const language = `publication-${callback}`
  let calls = 0
  let refuses = false
  const transform = (token: string): string => {
    if (refuses && token === 'closed') throw new Error('The analyser refused the text')
    return token
  }
  registerLanguage({
    name: language,
    revision: '1',
    stopWords: new Set(),
    normalizer: callback === 'normalizer' ? transform : undefined,
    stemmer: callback === 'stemmer' ? transform : null,
  })
  registerStopWords(language, defaults => {
    calls++
    if (refuses && calls === 4) throw new Error('The analyser refused the text')
    return defaults
  })
  const engine = await createNarsil({ workers: { enabled: false } })
  const original = { title: 'river', body: 'shore', rating: 7 }
  try {
    await engine.createIndex('readings', {
      schema: { rating: 'number', title: 'string', body: 'string' },
      language,
      stopWords: callback === 'stopWords' ? language : undefined,
    })
    await engine.insert('readings', original, 'retained')
    calls = 0
    refuses = true
    await expect(
      engine.update('readings', 'retained', { title: 'forest', body: 'closed', rating: 99 }),
    ).rejects.toThrow('The analyser refused the text')
    calls = 2
    await expect(engine.insert('readings', { title: 'ghost', body: 'closed', rating: 99 }, 'refused')).rejects.toThrow(
      'The analyser refused the text',
    )
    refuses = false
    expect(await engine.get('readings', 'retained')).toEqual(original)
    expect(await engine.get('readings', 'refused')).toBeUndefined()
    expect(await engine.countDocuments('readings')).toBe(1)
    expect((await engine.query('readings', { term: 'forest ghost' })).count).toBe(0)
    expect(
      (await engine.query('readings', { term: 'river', filters: { fields: { rating: { eq: 7 } } } })).hits.map(
        hit => hit.id,
      ),
    ).toEqual(['retained'])
    await engine.update('readings', 'retained', { title: 'lake', body: '', rating: 12 })
    expect((await engine.query('readings', { term: 'lake' })).count).toBe(1)
  } finally {
    await engine.shutdown()
  }
})
