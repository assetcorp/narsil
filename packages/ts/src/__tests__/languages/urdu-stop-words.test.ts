import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerLanguage } from '../../languages/registry'
import { urdu } from '../../languages/urdu'
import { createNarsil, type Narsil } from '../../narsil'
import { urduFixture } from './fixtures/urdu'

const FUNCTION_WORDS_IN_THE_SAMPLES = ['میں', 'سے', 'ہے', 'کا', 'کی', 'اور']

describe('an Urdu index drops the function words that Urdu prose repeats in every sentence', () => {
  let narsil: Narsil

  beforeAll(async () => {
    registerLanguage(urdu)
    narsil = await createNarsil({ workers: { enabled: false } })
    await narsil.createIndex('prose', { schema: { body: 'string' }, language: 'urdu' })
    await narsil.insertBatch(
      'prose',
      urduFixture.samples.map((sample, index) => ({ id: `doc-${index}`, body: sample.text })),
    )
  })

  afterAll(async () => {
    await narsil.shutdown()
  })

  for (const word of FUNCTION_WORDS_IN_THE_SAMPLES) {
    it(`finds no document for "${word}" alone`, async () => {
      expect(urduFixture.samples.some(sample => sample.text.split(/[\s،۔]+/).includes(word))).toBe(true)
      const result = await narsil.query('prose', { term: word })
      expect(result.hits).toEqual([])
    })
  }

  it('finds a document for a content word beside those function words', async () => {
    const result = await narsil.query('prose', { term: 'میں برصغیر' })
    expect(result.hits.map(hit => hit.id)).toEqual(['doc-0'])
  })
})
