import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { registerTokenizer } from '../../analysis/registry'
import { clearNormalizationCache } from '../../core/tokenizer/cache'
import { registerLanguage } from '../../languages/registry'
import { createNarsil } from '../../narsil'

it('keeps a frozen document unchanged when preparing its removed spellings fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-frozen-analysis-'))
  const language = 'frozen-publication-refusal'
  let refuses = false
  let refusesReplacement = false
  registerLanguage({
    name: language,
    revision: '1',
    stopWords: new Set(),
    tokenizer: { normalizeDiacritics: true },
    normalizer(token) {
      if (refuses && token === 'shore') throw new Error('The analyser refused the text')
      if (refusesReplacement && token === 'forest') throw new Error('The replacement text was refused')
      return token
    },
    stemmer: token => token.slice(0, -1),
  })
  let engine = await createNarsil({ durability: { directory }, workers: { enabled: false } })
  const original = { title: 'river', body: 'shore', rating: 7 }
  try {
    await engine.createIndex('readings', {
      schema: { title: 'string', body: 'string', rating: 'number' },
      language,
    })
    await engine.insert('readings', original, 'retained')
    await engine.checkpoint('readings')
    await engine.shutdown()
    engine = await createNarsil({ durability: { directory }, workers: { enabled: false } })
    clearNormalizationCache()
    refuses = true
    await expect(engine.update('readings', 'retained', { title: 'forest', body: 'open', rating: 99 })).rejects.toThrow(
      'The analyser refused the text',
    )
    await expect(engine.remove('readings', 'retained')).rejects.toThrow('The analyser refused the text')
    refuses = false
    refusesReplacement = true
    clearNormalizationCache()
    await expect(engine.update('readings', 'retained', { title: 'forest', body: 'open', rating: 99 })).rejects.toThrow(
      'The replacement text was refused',
    )
    refusesReplacement = false
    expect(await engine.get('readings', 'retained')).toEqual(original)
    expect(await engine.countDocuments('readings')).toBe(1)
    expect((await engine.query('readings', { term: 'forest' })).count).toBe(0)
    expect((await engine.query('readings', { term: 'river' })).hits.map(hit => hit.id)).toEqual(['retained'])
    await engine.update('readings', 'retained', { title: 'lake', body: '', rating: 12 })
    expect((await engine.query('readings', { term: 'lake' })).count).toBe(1)
  } finally {
    refuses = false
    refusesReplacement = false
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})

it('uses prepared partial spellings after removing or replacing a frozen document', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'narsil-frozen-partial-'))
  const refused = new Set<string>()
  registerTokenizer('frozen-partial-publication', {
    tokenize(text) {
      if (refused.has(text)) throw new Error('The removed document was analysed again')
      return text.split(' ').map((token, position) => ({ token, position }))
    },
  })
  const options = { durability: { directory }, workers: { enabled: false } }
  let engine = await createNarsil(options)
  try {
    await engine.createIndex('readings', {
      schema: { title: 'string:partial' },
      tokenizer: 'frozen-partial-publication',
      partitions: { maxPartitions: 1 },
    })
    await engine.insert('readings', { title: 'harbour river' }, 'removed')
    await engine.insert('readings', { title: 'harbour forest' }, 'changed')
    await engine.insert('readings', { title: 'harbour valley' }, 'retained')
    await engine.checkpoint('readings')
    await engine.shutdown()
    engine = await createNarsil(options)
    await engine.remove('readings', 'removed')
    refused.add('harbour river')
    await engine.update('readings', 'changed', { title: 'coast desert' })
    refused.add('harbour forest')
    for (let check = 0; check < 2; check++) {
      expect((await engine.query('readings', { term: 'bour', partialWords: true })).hits.map(hit => hit.id)).toEqual([
        'retained',
      ])
      expect((await engine.query('readings', { term: 'sert', partialWords: true })).hits.map(hit => hit.id)).toEqual([
        'changed',
      ])
      expect((await engine.query('readings', { term: 'iver', partialWords: true })).hits).toEqual([])
      expect((await engine.query('readings', { term: 'rest', partialWords: true })).hits).toEqual([])
    }
    await engine.checkpoint('readings')
    await engine.shutdown()
    engine = await createNarsil(options)
    expect((await engine.query('readings', { term: 'bour', partialWords: true })).hits.map(hit => hit.id)).toEqual([
      'retained',
    ])
  } finally {
    refused.clear()
    await engine.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})
